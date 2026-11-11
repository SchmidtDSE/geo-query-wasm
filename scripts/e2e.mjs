#!/usr/bin/env node
// End-to-end check in headless Chrome: the demo page starts the worker and
// DuckDB-wasm, the STAC tools read GLEN's catalog, SQL reads parquet by s3://
// and https:// URL, geo-query's tools, resources, prompt and query arguments
// work, and the demo's agent (glen-harness, from jsDelivr) runs against a
// scripted stand-in for the language model (no API key needed). Also checks
// that the SQL cannot read other hosts, change its settings, or create a
// secret.
//
//   node scripts/e2e.mjs
//   SITE_URL=https://schmidtdse.github.io/geo-query-wasm/ node scripts/e2e.mjs
//
// Against the deployed page, the checks up to the agent turn apply: Chrome
// blocks a public https page from calling the scripted model on 127.0.0.1
// (Private Network Access), as it would block any site probing localhost.
//
// Network: the page fetches DuckDB-wasm from jsDelivr, geo-query's guidance
// and glen-harness from jsDelivr, and the catalog and parquet from the
// source.coop mirror, as it does for users. No check needs NRP.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findChrome } from './find-chrome.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = findChrome();
// Checks read the source.coop mirror, which is much faster from a browser
// than NRP and stays up when NRP is down. PAD-US stands in for a global
// h0-partitioned hex dataset; this partition is a few hundred kilobytes.
const MIRROR = 's3://us-west-2.opendata.source.coop/cboettig';
const PADUS_HEX = `${MIRROR}/padus/padus-4-1/combined/hex`;
const H0 = '576531121047601151';
const STL = 'https://data.source.coop/tge-labs/st-louis-open-data-mirror/';
const WARDS = `${STL}government/wards/wards.parquet`;
const TORNADO = `${STL}law-safety-and-justice/tornado-damage-2025/tornado-damage-2025.parquet`;
const DAC = 's3://us-west-2.opendata.source.coop/cboettig/tpl-cities/browser-tiles/public-ca-dac/dac-2023/tract/hex/06001.parquet';
const SQL = `SELECT DAC23, SUM(Pop23) AS people FROM (SELECT DISTINCT _cng_fid, DAC23, Pop23 FROM read_parquet('${DAC}')) GROUP BY DAC23 ORDER BY DAC23`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const listen = (server) => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));

// Static files, as GitHub Pages would serve them.
const site = await listen(http.createServer(async (req, res) => {
    let file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    if (file.endsWith('/')) file = path.join(file, 'index.html');
    try {
        const body = await fs.readFile(file);
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end(); }
}));

// Scripted model: browse_stac_catalog, then one query, then an answer quoting it.
const requests = [];
const llm = await listen(http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }
    let b = '';
    req.on('data', d => b += d);
    req.on('end', () => {
        const { messages } = JSON.parse(b);
        requests.push(messages);
        const toolTurns = messages.filter(m => m.role === 'tool').length;
        const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: `c${toolTurns}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
        const message = toolTurns === 0 ? call('browse_stac_catalog', {})
            : toolTurns === 1 ? call('query', { sql_query: SQL })
            : { role: 'assistant', content: `From disadvantaged_communities:\n${messages.at(-1).content}` };
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' })
            .end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }));
    });
}));

const profile = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'geo-query-wasm-e2e-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
    chrome.stderr.on('data', d => { const m = String(d).match(/ws:\/\/\S+/); if (m) resolve(m[0]); });
    chrome.on('exit', c => reject(new Error(`chrome exited ${c}`)));
});
const port = new URL(wsUrl).port;
let page;
for (let i = 0; i < 50 && !page; i++) {
    page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
    if (!page) await new Promise(r => setTimeout(r, 100));
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || process.env.DEBUG)) {
        console.log(`  [page ${msg.params.type}]`, msg.params.args.map(a => a.value ?? a.description).join(' '));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        console.log('  [page log]', msg.params.entry.text, msg.params.entry.url ?? '');
    }
    if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        console.log('  [page exception]', d.exception?.description ?? d.text, d.url ?? '');
    }
});
const cdp = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
    const { result } = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
    return result.result.value;
};

let failed = false;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed = true; };

try {
    await cdp('Runtime.enable');
    await cdp('Log.enable');
    await cdp('Page.enable');
    const base = process.env.SITE_URL ?? `http://127.0.0.1:${site}/`;
    await cdp('Page.navigate', { url: base });
    // Module scripts, with their imports, have run once the document is complete.
    for (let i = 0; i < 100 && (await evaluate('document.readyState')) !== 'complete'; i++) {
        await new Promise(r => setTimeout(r, 100));
    }

    const started = await evaluate(`(async () => {
        document.getElementById('endpoint').value = 'http://127.0.0.1:${llm}/v1';
        document.getElementById('model').value = 'scripted';
        const t0 = performance.now();
        document.getElementById('start').click();
        while (!window.__demo) {
            if (performance.now() - t0 > 120000) throw new Error('timed out: ' + document.getElementById('status').textContent);
            await new Promise(r => setTimeout(r, 200));
        }
        return { seconds: (performance.now() - t0) / 1000, status: document.getElementById('status').textContent };
    })()`);
    console.log(`     ${started.status}`);
    check(/tools browse_stac_catalog, get_stac_details, get_collection, query/.test(started.status), 'worker started and listed its tools');

    const browse = await evaluate(`window.__demo.mcp.callTool('browse_stac_catalog', {})`);
    const n = Number(browse.match(/Available Datasets \((\d+) collections\)/)?.[1]);
    check(n > 20 && /\*\*pad-us-4\.1\*\*/.test(browse), `browse_stac_catalog read the mirror catalog (${n} collections)`);

    const details = await evaluate(`window.__demo.mcp.callTool('get_stac_details', { dataset_id: 'pad-us-4.1' })`);
    // GLEN's catalog on source.coop is a copy of NRP's, and its hrefs point
    // back at NRP for days while glen-ops' weekly sync runs. So this checks
    // the tool, not the mirror's hrefs; the Portolan check below checks paths.
    check(details.includes('Collection ID: `pad-us-4.1`') && /read_parquet\('s3:\/\//.test(details), 'get_stac_details describes PAD-US with s3:// paths');

    // A Portolan catalog published on source.coop: relative hrefs, theme
    // catalogs between the root and its collections, and no ids on child
    // links. Its paths can only point at source.coop.
    const stl = await evaluate(`(async () => {
        const { MCPClient, PostMessageTransport } = window.__demo.harness;
        const cfg = { catalog: ${JSON.stringify(STL + 'catalog.json')} };
        const worker = new Worker('/src/worker.js?config=' + encodeURIComponent(JSON.stringify(cfg)), { type: 'module' });
        const mcp = new MCPClient('worker:portolan', {}, { transport: () => new PostMessageTransport(worker) });
        await mcp.connect();
        const browse = await mcp.callTool('browse_stac_catalog', {});
        const details = await mcp.callTool('get_stac_details', { dataset_id: 'wards' });
        const path = details.match(/read_parquet\\('([^']+)'\\)/)?.[1];
        const count = path ? await mcp.callTool('query', { sql_query: "SELECT count(*) AS n FROM read_parquet('" + path + "')" }) : null;
        worker.terminate();
        return { browse, path, count };
    })()`);
    const stlN = Number(stl.browse.match(/Available Datasets \((\d+) collections\)/)?.[1]);
    check(stlN > 20 && stl.browse.includes('- **government/wards**:') && !stl.browse.includes('undefined'),
        `browse_stac_catalog reads a Portolan catalog (${stlN} collections)`);
    check(stl.path === 's3://us-west-2.opendata.source.coop/tge-labs/st-louis-open-data-mirror/government/wards/wards.parquet' && /\| 14 \|/.test(stl.count ?? ''),
        `get_stac_details gives a Portolan collection's source.coop path, and SQL reads it (${stl.path}; ${stl.count?.split('\n')[2]})`);

    const q = (sql) => evaluate(`window.__demo.mcp.callTool('query', { sql_query: ${JSON.stringify(sql)} })`);
    const glob = await q(`SELECT count(*) AS files FROM glob('${PADUS_HEX}/**')`);
    check(/\| \d{2,} \|/.test(glob), `SQL globs an s3:// path on source.coop (${glob.split('\n')[2]})`);
    const part = await q(`SELECT count(*) AS n FROM read_parquet('${PADUS_HEX}/h0=*/data_0.parquet') WHERE h0 = ${H0}`);
    check(/\| [1-9]\d* \|/.test(part), `SQL reads one h0 partition (${part.split('\n')[2]})`);
    const https = await q(`SELECT count(*) AS n FROM read_parquet('https://data.source.coop/cboettig/padus/padus-4-1/combined/hex/h0=${H0}/data_0.parquet')`);
    check(/\| [1-9]\d* \|/.test(https), `SQL reads an https:// URL on source.coop (${https.split('\n')[2]})`);
    const h3 = await q('SELECT h3_latlng_to_cell(37.87, -122.26, 8) AS cell, ST_AsText(ST_Point(1, 2)) AS pt');
    check(/\| 613196572481552383 \| POINT \(1 2\) \|/.test(h3), 'h3 and spatial are loaded');

    const out = await evaluate(`window.__demo.agent.processMessage('How many people live in disadvantaged communities?')`);
    console.log(out.response.split('\n').map(l => `     ${l}`).join('\n'));
    check(/\| DAC23 \| people \|/.test(out.response) && /\| Y \| \d+ \|/.test(out.response), 'agent loop: model → browse_stac_catalog → query → answer');
    check(out.sqlQueries.length === 1 && out.sqlQueries[0] === SQL, 'the query was recorded');
    check(requests[0][0].content.includes('California county files'), "the app's instructions reached the system prompt");
    const description = await evaluate(`window.__demo.mcp.getTools().find(t => t.name === 'query').description`);
    check(description.includes('NO TABLES EXIST') && description.includes('H3 SPATIAL MATH') && description.length > 20000,
        `the query description carries geo-query's guidance (${description.length} characters)`);

    if (process.env.SCREENSHOT) {
        // The page as it stands after the turn, at desktop and phone widths.
        await evaluate(`(() => { const e = document.createElement('div'); e.className = 'entry answer';
            e.innerHTML = '<div class=label>Answer</div><div class=body></div>';
            e.querySelector('.body').textContent = ${JSON.stringify(out.response)};
            document.getElementById('log').append(e); })()`);
        for (const [name, width, height] of [['desktop', 1200, 1100], ['phone', 390, 1400]]) {
            await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: name === 'phone' });
            const { result } = await cdp('Page.captureScreenshot', { format: 'png' });
            const file = path.join(process.env.SCREENSHOT, `${name}.png`);
            await fs.writeFile(file, Buffer.from(result.data, 'base64'));
            console.log(`     screenshot ${file}`);
        }
    }

    const nums = await q(`SELECT SUM(Pop23) AS total, CAST(1.25 AS DECIMAL(10,2)) AS d FROM read_parquet('${DAC}')`);
    check(/\| \d+ \| 1\.25 \|/.test(nums), `integer sums and decimals print as numbers (${nums.split('\n')[2]})`);

    const rows = JSON.parse(await evaluate(`window.__demo.mcp.callTool('query', { sql_query: ${JSON.stringify(SQL)}, format: 'json' })`));
    const y = rows.find?.(r => r.DAC23 === 'Y');
    check(y && Number.isInteger(y.people) && y.people > 0, `format json returns rows (${JSON.stringify(y)})`);
    const smuggle = await evaluate(`window.__demo.mcp.callTool('query', { format: 'json',
        sql_query: "SELECT 1) __q; CREATE SECRET x (TYPE S3, ENDPOINT 'example.org'); SELECT * FROM (SELECT 1" })`);
    check(/^SQL Error:/.test(smuggle), `the JSON wrapper cannot be closed early (${smuggle.slice(0, 70)}…)`);

    // A worker configured as an app would configure it: two DuckDB instances,
    // a path rewrite, and files fetched whole.
    const TILES = 'https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/cboettig/tpl-cities/browser-tiles/';
    const configured = await evaluate(`(async () => {
        const { MCPClient, PostMessageTransport } = window.__demo.harness;
        const cfg = { workers: 2, instructions: 'configured',
            rewrite: [{ from: 's3://us-west-2.opendata.source.coop/', to: 'https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/' }],
            fetchWhole: ['${TILES}'] };
        const worker = new Worker('/src/worker.js?config=' + encodeURIComponent(JSON.stringify(cfg)), { type: 'module' });
        const mcp = new MCPClient('worker:configured', {}, { transport: () => new PostMessageTransport(worker) });
        await mcp.connect();
        const t0 = performance.now();
        const sqls = ['06001', '06013', '06075'].map(c => ${JSON.stringify(SQL)}.replace('06001', c));
        const out = await Promise.all(sqls.map(sql => mcp.callTool('query', { sql_query: sql, format: 'json' })));
        const seconds = (performance.now() - t0) / 1000;
        const other = await mcp.callTool('query', { sql_query: "SELECT * FROM read_csv('https://example.org/x.csv')" });
        worker.terminate();
        return { instructions: mcp.client.getInstructions(), out, seconds, other };
    })()`);
    check(configured.instructions === 'configured', 'a configured worker sends its own instructions');
    const counties = configured.out.map(t => { try { return JSON.parse(t); } catch { return t; } });
    check(counties.every(r => Array.isArray(r) && r.some(x => x.DAC23 === 'Y')),
        `two instances read three counties fetched whole, rewritten to https (${configured.seconds.toFixed(1)} s)`);
    if (!counties.every(Array.isArray)) console.log('    ', counties);
    check(/^SQL Error: Permission Error/.test(configured.other), 'a configured worker is still locked');

    // The engine imported straight into the page, as glen-charts would use it.
    const direct = await evaluate(`(async () => {
        const { createEngine } = await import('/src/engine.js');
        const engine = createEngine({ workers: 2, lock: false, settings: { s3_allow_recursive_globbing: false } });
        const [a, b] = await Promise.all([engine.json(${JSON.stringify(SQL)}), engine.query("SELECT 42::UBIGINT AS h")]);
        const set = await engine.json("SELECT current_setting('preserve_insertion_order') AS g, current_setting('s3_allow_recursive_globbing') AS r");
        await engine.close();
        return { a, h: String(b[0].h), set };
    })()`);
    check(direct.a.some(r => r.DAC23 === 'Y') && direct.h === '42' && direct.set[0].g === false && direct.set[0].r === false,
        "the engine runs in the page without MCP, with an app's setting added to the defaults");

    // GeoParquet geometry reads as GEOMETRY on both DuckDB builds: spatial
    // joins work without ST_GeomFromWKB, and a result holding geometry in
    // OGC:CRS84 exports (duckdb-wasm#2199, #2301). The St. Louis files are
    // small: wards has no CRS, the tornado points are in OGC:CRS84.
    const geo = await evaluate(`(async () => {
        const { createEngine } = await import('/src/engine.js');
        const { DUCKDB_WASM_2 } = await import('/src/defaults.js');
        const W = ${JSON.stringify(WARDS)}, T = ${JSON.stringify(TORNADO)};
        const out = {};
        for (const [name, opts] of [['1.5', {}], ['2.0', { duckdb: DUCKDB_WASM_2 }]]) {
            const engine = createEngine(opts);
            const err = (e) => 'ERROR ' + e.message.slice(0, 120);
            const type = await engine.json("SELECT typeof(geometry) AS t FROM read_parquet('" + T + "') LIMIT 1").catch(err);
            const join = await engine.json("SELECT w.NAME AS ward, count(*)::INT AS n FROM read_parquet('" + T + "') t JOIN read_parquet('" + W + "') w ON ST_Contains(w.geometry, t.geometry) GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 1").catch(err);
            const rows = await engine.query("SELECT event_id, geometry FROM read_parquet('" + T + "') ORDER BY event_id LIMIT 2").catch(err);
            const arrow = await engine.arrow("SELECT geometry FROM read_parquet('" + T + "') LIMIT 2").then(t => t.numRows + ' ' + t.schema.fields[0].type).catch(err);
            await engine.close();
            out[name] = { type, join, rows, arrow };
        }
        return out;
    })()`);
    for (const [name, r] of Object.entries(geo)) {
        check(r.type?.[0]?.t === "GEOMETRY('OGC:CRS84')" && r.join?.[0]?.ward === 'WARD 12' && r.join[0].n === 90,
            `DuckDB ${name} reads GeoParquet as GEOMETRY and joins with ST_Contains (${JSON.stringify(r.type)} ${JSON.stringify(r.join)})`);
        check(Array.isArray(r.rows) && r.rows.length === 2 && Object.keys(r.rows[0]).join() === 'event_id' && r.arrow === '2 Binary',
            `DuckDB ${name} returns results holding OGC:CRS84 geometry (${JSON.stringify(r.rows).slice(0, 80)}; arrow ${r.arrow})`);
    }

    // The time limit and spilling, on locked engines: a query past the limit
    // is cancelled and the instance keeps working; on DuckDB 2.0, a query
    // that needs more than memory_limit spills instead of running out of
    // memory, and the If-Match header DuckDB 2.0 sends is dropped.
    const limits = await evaluate(`(async () => {
        const { createEngine } = await import('/src/engine.js');
        const { DUCKDB_WASM_2 } = await import('/src/defaults.js');
        const engine = createEngine({ timeout: 3, settings: { memory_limit: '256MB' } });
        await engine.ready();
        const big = 'SELECT count(*) AS groups FROM (SELECT range % 20000000 AS k, sum(range) AS s FROM range(40000000) GROUP BY k)';
        let t0 = performance.now(), stopped = '';
        try { await engine.json('SELECT sum(range % 7) AS s FROM range(100000000000)'); }
        catch (err) { stopped = err.message; }
        const stopSeconds = (performance.now() - t0) / 1000;
        const after = await engine.json('SELECT 42 AS x');
        const strict = createEngine({ duckdb: DUCKDB_WASM_2, timeout: 60, settings: { memory_limit: '256MB' } });
        t0 = performance.now();
        let spilled; try { spilled = await strict.json(big); } catch (err) { spilled = err.message; }
        const spillSeconds = (performance.now() - t0) / 1000;
        const empty = await strict.query('SELECT 1 AS x WHERE false');
        const remote = await strict.json(${JSON.stringify(`SELECT count(*) AS n FROM read_parquet('${DAC}')`)}).catch(err => err.message);
        await engine.close(); await strict.close();
        return { stopped, stopSeconds, after: after[0].x, spilled, spillSeconds, empty: empty.length, remote };
    })()`);
    check(/^Query stopped after 3 seconds/.test(limits.stopped) && limits.stopSeconds < 5 && limits.after === 42,
        `a query past the time limit is cancelled (${limits.stopSeconds.toFixed(1)} s) and the instance still answers`);
    check(limits.spilled?.[0]?.groups === 20000000,
        `on DuckDB 2.0, a query over memory_limit spills and finishes (${limits.spillSeconds.toFixed(1)} s${typeof limits.spilled === 'string' ? `: ${limits.spilled.slice(0, 120)}` : ''})`);
    check(limits.empty === 0, 'an empty result keeps its schema');
    check(limits.remote?.[0]?.n > 1000, `DuckDB 2.0 reads remote parquet (${JSON.stringify(limits.remote).slice(0, 100)})`);

    // geo-query parity: structured collections, resources, the prompt, formatting, per-query S3.
    const sdk = 'window.__demo.mcp.client';
    const resources = await evaluate(`${sdk}.listResourceTemplates().then(r => r.resourceTemplates.map(t => t.uriTemplate))`);
    const prompt = await evaluate(`${sdk}.getPrompt({ name: 'geospatial-analyst' }).then(p => p.messages[0].content.text)`);
    check(resources.includes('catalog://{dataset_id}') && prompt.length > 100, `catalog resources and the geospatial-analyst prompt (${prompt.slice(0, 50)}…)`);
    const inline = JSON.parse(await evaluate(`window.__demo.mcp.callTool('get_collection', { collection_id: 'x',
        collection: { id: 'x', assets: { d: { href: 'https://data.source.coop/cboettig/x/d.parquet', type: 'application/x-parquet' } } } })`));
    check(inline.assets?.d?.href === 's3://us-west-2.opendata.source.coop/cboettig/x/d.parquet', 'get_collection renders an inline collection with s3:// hrefs');
    const temporal = await q("SELECT DATE '2024-01-02' AS d, TIMESTAMP '2024-01-02 03:04:05' AS t, 1/3 AS x, NULL AS z");
    check(temporal.includes('| 2024-01-02 | 2024-01-02 03:04:05 | 0.3333333333 |  |'), `dates, timestamps, floats and NULLs print as on geo-query (${temporal.split('\n')[2]})`);
    const many = await q('SELECT * FROM range(100000)');
    check(many.split('\n').filter(l => /^\| \d/.test(l)).length === 50 && many.includes('Showing the first 50 rows only'), 'long results stop at 50 rows with the note');
    const describe = await q(`DESCRIBE SELECT * FROM read_parquet('${DAC}')`);
    check(/\| column_name \|/.test(describe), 'DESCRIBE runs through the row limit');
    const s3q = (args) => evaluate(`window.__demo.mcp.callTool('query', ${JSON.stringify(args)})`);
    const viaEndpoint = await s3q({ sql_query: `SELECT count(*) AS n FROM read_parquet('${DAC}')`,
        s3_endpoint: 's3.us-west-2.amazonaws.com', s3_region: 'us-west-2', s3_scope: 's3://us-west-2.opendata.source.coop' });
    check(/\| \d{4,} \|/.test(viaEndpoint), `a query can name its own anonymous endpoint and scope (${viaEndpoint.split('\n')[2]})`);
    const badEndpoint = await s3q({ sql_query: 'SELECT 1', s3_endpoint: 'evil.example.org' });
    check(/^SQL Error: s3_endpoint 'evil\.example\.org' is not an S3 endpoint/.test(badEndpoint), 'an endpoint outside the allow-list is refused');
    const halfKey = await s3q({ sql_query: 'SELECT 1', s3_key: 'k' });
    check(/^SQL Error: s3_secret is required/.test(halfKey), 'a key without its secret is refused');
    // Keys come from the app (sendSecrets), never from the model's arguments.
    // scripts/private-check.mjs reads a private bucket with keys sent that way.
    const keys = await s3q({ sql_query: 'SELECT 1', s3_key: 'AKIAEXAMPLE', s3_secret: 'x', s3_endpoint: 's3.us-west-2.amazonaws.com' });
    check(/^SQL Error: s3_key and s3_secret are not accepted with a query/.test(keys), 'keys passed by the model are refused, with the reason');
    const after = await q(`SELECT count(*) AS n FROM read_parquet('${DAC}')`);
    check(/\| \d{4,} \|/.test(after), 'the per-query secret is gone afterwards');

    // Hex tiles: a pyramid built in the worker's memory from one county's
    // cells, a tile and metadata.json read as resources, and the layer drawn
    // by MapLibre through the geoquerywasm: protocol.
    const hexSql = `SELECT h10 FROM read_parquet('${DAC}')`;
    const hexCall = (name, args) => evaluate(`window.__demo.mcp.callTool(${JSON.stringify(name)}, ${JSON.stringify(args)})`);
    const t0 = Date.now();
    let reg = JSON.parse(await hexCall('register_hex_tiles', { sql: hexSql }));
    while (reg.status === 'running') reg = JSON.parse(await hexCall('get_hex_tile_status', { hash: reg.hash, wait_seconds: 30 }));
    const buildSeconds = (Date.now() - t0) / 1000;
    check(reg.status === 'done' && reg.finest_res === 10 && reg.feature_count_finest > 100000
        && reg.bounds[0] > -123 && reg.bounds[2] < -121 && reg.tile_url_template === `geoquerywasm://tiles/hex/${reg.hash}/{z}/{x}/{y}.pbf`,
        `register_hex_tiles builds a pyramid of ${reg.feature_count_finest} cells at res ${reg.finest_res} in ${buildSeconds.toFixed(1)} s`
        + (reg.status === 'done' ? '' : ` (${JSON.stringify(reg).slice(0, 200)})`));
    const levels = Object.keys(reg.value_stats?.count?.by_res ?? {});
    check(levels.join() === '2,3,4,5,6,7,8,9,10' && reg.value_stats.count.by_res['2'].max > 1000 && reg.next_step && reg.layer?.type === 'fill',
        `value_stats has every level, ${reg.value_stats?.count?.by_res?.['2']?.max} cells in the largest res-2 cell, and a recipe`);
    const again = JSON.parse(await hexCall('register_hex_tiles', { sql: hexSql, color_scale: 'log', layer_style: 'fill-extrusion' }));
    check(again.cache_hit && again.hash === reg.hash && again.layer.type === 'fill-extrusion', 'registering again is a cache hit that restyles');
    const avg = JSON.parse(await hexCall('register_hex_tiles', { sql: `SELECT h9, Pop23 FROM read_parquet('${DAC}')`, agg: 'AVG' }));
    check(avg.status === 'done' && avg.value_columns.join() === 'Pop23' && avg.finest_res === 9, `agg AVG over a value column (${avg.status}, ${avg.value_columns})`);
    const hexTile = await evaluate(`(async () => {
        const { readHexResource } = await import('/src/hex-protocol.js');
        const client = window.__demo.mcp;
        const url = ${JSON.stringify(reg.tile_url_template)};
        const t0 = performance.now();
        const tile = await readHexResource(client, url.replace('{z}/{x}/{y}', '10/164/396'));
        const ms = performance.now() - t0;
        const empty = await readHexResource(client, url.replace('{z}/{x}/{y}', '10/0/0'));
        const meta = JSON.parse(new TextDecoder().decode((await readHexResource(client, url.replace('{z}/{x}/{y}.pbf', 'metadata.json'))).bytes));
        let missing = '';
        try { await readHexResource(client, url.replace(${JSON.stringify(reg.hash)}, 'ffffffffffffffff').replace('{z}/{x}/{y}', '1/0/0')); }
        catch (err) { missing = err.message; }
        return { bytes: tile.bytes.length, type: tile.mimeType, ms, layer: new TextDecoder().decode(tile.bytes).includes('layer'),
            empty: empty.bytes.length, meta, missing };
    })()`);
    check(hexTile.bytes > 1000 && hexTile.layer && hexTile.type === 'application/vnd.mapbox-vector-tile' && hexTile.empty === 0,
        `a tile over Oakland is ${hexTile.bytes} bytes of MVT (${hexTile.ms.toFixed(0)} ms); one in the ocean is empty (${hexTile.empty} bytes, ${hexTile.type})`);
    check(hexTile.meta.feature_count_finest === reg.feature_count_finest && hexTile.meta.agg === 'COUNT', 'metadata.json is served at the tile URL\'s path');
    check(/No hex tileset ffffffffffffffff/.test(hexTile.missing), 'an unknown tileset is an error');
    const drawn = await evaluate(`(async () => {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = 'https://unpkg.com/maplibre-gl@5.22.0/dist/maplibre-gl.css';
        document.head.append(css);
        await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://unpkg.com/maplibre-gl@5.22.0/dist/maplibre-gl.js';
            s.onload = resolve; s.onerror = reject;
            document.head.append(s);
        });
        const { addHexTileProtocol } = await import('/src/hex-protocol.js');
        addHexTileProtocol(maplibregl, window.__demo.mcp);
        const div = document.createElement('div');
        div.style.cssText = 'width:600px;height:400px';
        document.body.append(div);
        const reg = ${JSON.stringify(reg)};
        const map = new maplibregl.Map({ container: div, style: { version: 8, sources: {}, layers: [] },
            bounds: reg.bounds, fitBoundsOptions: { padding: 20 } });
        await new Promise(r => map.on('load', r));
        map.addSource('hex', reg.source);
        map.addLayer({ id: 'hex', source: 'hex', ...reg.layer });
        await new Promise(r => map.once('idle', r));
        const features = map.queryRenderedFeatures({ layers: ['hex'] });
        const out = { zoom: map.getZoom(), n: features.length, props: features[0]?.properties };
        map.remove();
        return out;
    })()`);
    check(drawn.n > 100 && drawn.props?.count > 0 && drawn.props?.res >= 2,
        `MapLibre draws ${drawn.n} hexes at zoom ${drawn.zoom?.toFixed(1)} through the geoquerywasm: protocol (${JSON.stringify(drawn.props)})`);
    for (const [args, what] of [
        [{ sql: "CREATE SECRET x (TYPE S3, ENDPOINT 'example.org')" }, 'register_hex_tiles runs only a SELECT'],
        [{ sql: "SELECT 1 AS h) __q; CREATE SECRET x (TYPE S3); SELECT * FROM (SELECT 1" }, 'and its wrappers cannot be closed early'],
        [{ sql: "SELECT h3_latlng_to_cell(1, 2, 8) AS h FROM read_csv('https://example.org/x.csv')" }, 'and it cannot read another host'],
    ]) {
        const out = await evaluate(`window.__demo.mcp.client.callTool({ name: 'register_hex_tiles', arguments: ${JSON.stringify(args)} })`);
        check(out.isError && /^Error executing tool register_hex_tiles:/.test(out.content[0].text),
            `${what} (${out.content[0].text.slice(0, 90).replace(/\n/g, ' ')}…)`);
    }

    for (const [sql, what] of [
        ["SELECT * FROM read_csv('https://example.org/x.csv')", 'SQL cannot read another host'],
        ["SELECT * FROM read_csv('https://s3-west.nrp-nautilus.io.example.org/x.csv')", 'nor a look-alike host'],
        ['SET enable_external_access = true', 'nor turn access back on'],
        ["CREATE SECRET x (TYPE S3, ENDPOINT 'example.org', SCOPE 's3://public-x')", 'nor create a secret'],
        ["SELECT * FROM query('CREATE SECRET x (TYPE S3)')", 'nor create one through query()'],
        ["ATTACH 'https://example.org/x.duckdb'", 'nor attach a database'],
    ]) {
        const out = await q(sql);
        check(/^SQL Error:/.test(out) && !/did not start/.test(out), `${what} (${out.slice(0, 90).replace(/\n/g, ' ')}…)`);
    }
} catch (err) {
    console.log('FAIL', err.message);
    failed = true;
} finally {
    ws.close();
    chrome.kill();
    await new Promise(r => chrome.once('exit', r));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5 });
    process.exit(failed ? 1 : 0);
}
