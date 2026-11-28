/**
 * Demo page: an agent in the page, geo-query-wasm in a Web Worker.
 *
 * The agent is glen-harness, a separate project, loaded from jsDelivr at a
 * pinned commit as any client of the server would load its own agent. The
 * page talks to the worker only through MCP over postMessage, and to the
 * language model only through the endpoint the user gives. The API key stays
 * in memory; the endpoint and model are remembered in this browser.
 *
 * As on geo-query, the server has no STAC tools, so the page brings its own
 * catalog tools, as glen does: browse_stac_catalog and get_stac_details run
 * here, over GLEN's catalog on source.coop (stac.js).
 *
 * A visitor can add files of their own (files.js). The page registers each
 * with the worker, lists it, and tells the model its SQL and columns with
 * the next question. The files stay in the browser, and are added again
 * when the worker restarts.
 */

import * as harness from 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-harness@b808d616937e210fbb9cf9d9d071ba492b2342d6/src/index.js';
import { createCatalog } from './stac.js';
import { addFile, removeFile } from './files.js';

const { Agent, ToolRegistry, MCPClient, PostMessageTransport } = harness;

const $ = (id) => document.getElementById(id);
const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
};

for (const k of ['endpoint', 'model']) {
    const saved = store.get(`geo-query-wasm.${k}`);
    if (saved) $(k).value = saved;
}
let session = null;
// The visitor's files, kept so they can be added to a restarted worker.
const files = new Map(); // name → File
let unsent = []; // notes about added files, sent with the next question

$('start').addEventListener('click', async () => {
    $('start').disabled = true;
    session?.worker.terminate();
    $('log').replaceChildren();
    const t0 = performance.now();
    status('Starting DuckDB in a worker…');

    const url = new URL('./worker.js', import.meta.url);
    const worker = new Worker(url, { type: 'module' });
    const mcp = new MCPClient('worker:geo-query-wasm', {}, { transport: () => new PostMessageTransport(worker) });
    try {
        await mcp.connect();
    } catch (err) {
        status(`Could not start the worker: ${err.message}`);
        $('start').disabled = false;
        return;
    }

    const registry = new ToolRegistry();
    registry.registerRemote(mcp.getTools(), mcp);
    for (const tool of catalogTools()) registry.registerLocal(tool);

    const agent = new Agent({
        llm_models: [{ value: $('model').value, endpoint: $('endpoint').value, api_key: $('key').value || 'EMPTY' }],
        auto_approve: true,
    }, registry, { clientName: 'geo-query-wasm/0.3.0' });
    agent.setSystemPrompt([
        'You are a geospatial data analyst. Answer questions with the tools, which find datasets in a STAC catalog and run DuckDB SQL over them in the user\'s browser.',
        'Report numbers with units, say which datasets you used, and keep answers short.',
        ...(mcp.client.getInstructions() ? ['', mcp.client.getInstructions()] : []),
    ].join('\n'));
    agent.onToolProposal = (calls) => {
        for (const c of calls) {
            let args = {};
            try { args = JSON.parse(c.function.arguments); } catch { /* shown raw below */ }
            entry('tool', c.function.name, args.sql_query ?? (Object.keys(args).length ? JSON.stringify(args) : ''));
        }
        return { approved: true };
    };

    session = { worker, mcp, registry, agent, harness };
    window.__demo = session; // for scripts/e2e.mjs
    for (const [name, file] of files) await sendFile(file, name);
    status(`Ready in ${((performance.now() - t0) / 1000).toFixed(1)} s: tools ${registry.getNames().join(', ')}.`);
    $('ask').disabled = false;
    $('file').disabled = false;
    $('start').disabled = false;
    $('start').textContent = 'Restart';
    for (const k of ['endpoint', 'model']) store.set(`geo-query-wasm.${k}`, $(k).value);
});

$('chat').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('question').value.trim();
    if (!q || !session) return;
    $('question').value = '';
    $('ask').disabled = true;
    entry('user', 'You', q);
    // Notes about files added since the last question go to the model with it.
    const message = unsent.length ? `${unsent.join('\n')}\n\n${q}` : q;
    unsent = [];
    try {
        const { response, cancelled } = await session.agent.processMessage(message);
        if (!cancelled) entry('answer', 'Answer', response ?? '');
    } catch (err) {
        entry('error', 'Error', err.message);
    } finally {
        $('ask').disabled = false;
    }
});

/** The page's catalog tools, worded as geo-query's last STAC tools were. */
function catalogTools() {
    const catalog = createCatalog(async (u) => {
        const res = await fetch(u);
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${u}`);
        return res.json();
    });
    const failed = (fn) => async (args) => {
        try { return await fn(args); } catch (err) { return `Error: ${err.message}`; }
    };
    return [
        {
            name: 'browse_stac_catalog',
            description: 'List the datasets in the STAC catalog, with their IDs and titles, under their groups.',
            inputSchema: { type: 'object', properties: {} },
            execute: failed(() => catalog.browse()),
        },
        {
            name: 'get_stac_details',
            description: 'Fetch metadata (parquet paths, column schemas) for a STAC collection by ID.',
            inputSchema: { type: 'object', properties: { dataset_id: { type: 'string' } }, required: ['dataset_id'] },
            execute: failed(({ dataset_id: id }) => (typeof id === 'string' && id.trim()
                ? catalog.details(id.trim()) : 'Error: no dataset_id given')),
        },
    ];
}

/** A name the worker accepts: letters, digits, '.', '_' and '-'. */
export function uploadName(name) {
    const clean = String(name).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.{2,}/g, '.').replace(/^[^A-Za-z0-9]+/, '');
    const dot = clean.lastIndexOf('.');
    return dot > 0 && clean.length > 100 ? clean.slice(0, 100 - (clean.length - dot)) + clean.slice(dot) : clean;
}

/** Register one file with the current worker, list it, and note it for the model. */
async function sendFile(file, name = uploadName(file.name)) {
    try {
        const added = await addFile(session.worker, file, name);
        files.set(name, file);
        const cols = added.columns.map(c => `${c.name} (${c.type})`).join(', ');
        unsent = unsent.filter(n => !n.includes(`'${added.path}'`));
        unsent.push(`[I added a file. Read it with ${added.read}. Columns: ${cols}.${added.geometry ? ` Geometry column: ${added.geometry}.` : ''}]`);
        showFiles();
        return added;
    } catch (err) {
        entry('error', 'File', `${file.name}: ${err.message}`);
        return null;
    }
}

function showFiles() {
    $('file-list').replaceChildren(...[...files.keys()].map((name) => {
        const li = document.createElement('li');
        const code = document.createElement('code');
        code.textContent = `/upload/${name}`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.addEventListener('click', async () => {
            files.delete(name);
            unsent = unsent.filter(n => !n.includes(`/upload/${name}'`));
            showFiles();
            if (session) await removeFile(session.worker, name).catch(() => {});
        });
        li.append(code, remove);
        return li;
    }));
}

async function addFiles(list) {
    if (!session) {
        status('Start first, then add files.');
        return;
    }
    for (const file of list) await sendFile(file);
}

$('file').addEventListener('change', async (e) => {
    await addFiles([...e.target.files]);
    e.target.value = '';
});
// Drop a file anywhere on the page.
document.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    document.body.classList.add('dragging');
});
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
document.addEventListener('drop', async (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    document.body.classList.remove('dragging');
    await addFiles([...e.dataTransfer.files]);
});

function status(text) {
    $('status').textContent = text;
}

function entry(kind, label, text) {
    const div = document.createElement('div');
    div.className = `entry ${kind}`;
    const head = document.createElement('div');
    head.className = 'label';
    head.textContent = label;
    div.append(head);
    if (text) {
        const body = document.createElement(kind === 'tool' ? 'pre' : 'div');
        body.className = 'body';
        body.textContent = text;
        div.append(body);
    }
    $('log').append(div);
    div.scrollIntoView({ block: 'end' });
}
