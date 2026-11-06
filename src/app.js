/**
 * Demo page: glen-harness in the page, the MCP data server in a Web Worker.
 *
 * The page talks to the worker only through MCP over postMessage, and to the
 * language model only through the endpoint the user gives. The API key stays
 * in memory; the endpoint and model are remembered in this browser.
 */

import { Agent, ToolRegistry, MCPClient, PostMessageTransport } from '../vendor/glen-harness/index.js';

const $ = (id) => document.getElementById(id);
const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
};

for (const k of ['endpoint', 'model']) {
    const saved = store.get(`glen-wasm.${k}`);
    if (saved) $(k).value = saved;
}
let session = null;

$('start').addEventListener('click', async () => {
    $('start').disabled = true;
    session?.worker.terminate();
    $('log').replaceChildren();
    const t0 = performance.now();
    status('Starting DuckDB in a worker…');

    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    const mcp = new MCPClient('worker:glen-wasm', {}, { transport: () => new PostMessageTransport(worker) });
    try {
        await mcp.connect();
    } catch (err) {
        status(`Could not start the worker: ${err.message}`);
        $('start').disabled = false;
        return;
    }

    const registry = new ToolRegistry();
    registry.registerRemote(mcp.getTools(), mcp);

    const agent = new Agent({
        llm_models: [{ value: $('model').value, endpoint: $('endpoint').value, api_key: $('key').value || 'EMPTY' }],
        auto_approve: true,
    }, registry, { clientName: 'glen-wasm/0.1.0' });
    agent.setSystemPrompt([
        'You are a geospatial data analyst. Answer questions with the tools, which find datasets in a STAC catalog and run DuckDB SQL over them in the user\'s browser.',
        'Report numbers with units, say which datasets you used, and keep answers short.',
        '',
        mcp.client.getInstructions() ?? '',
    ].join('\n'));
    agent.onToolProposal = (calls) => {
        for (const c of calls) {
            let args = {};
            try { args = JSON.parse(c.function.arguments); } catch { /* shown raw below */ }
            entry('tool', c.function.name, args.sql_query ?? (Object.keys(args).length ? JSON.stringify(args) : ''));
        }
        return { approved: true };
    };

    session = { worker, mcp, agent };
    window.__glen = session; // for scripts/e2e.mjs
    status(`Ready in ${((performance.now() - t0) / 1000).toFixed(1)} s: tools ${registry.getNames().join(', ')}.`);
    $('ask').disabled = false;
    $('start').disabled = false;
    $('start').textContent = 'Restart';
    for (const k of ['endpoint', 'model']) store.set(`glen-wasm.${k}`, $(k).value);
});

$('chat').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('question').value.trim();
    if (!q || !session) return;
    $('question').value = '';
    $('ask').disabled = true;
    entry('user', 'You', q);
    try {
        const { response, cancelled } = await session.agent.processMessage(q);
        if (!cancelled) entry('answer', 'Answer', response ?? '');
    } catch (err) {
        entry('error', 'Error', err.message);
    } finally {
        $('ask').disabled = false;
    }
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
