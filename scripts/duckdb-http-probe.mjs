#!/usr/bin/env node
// Measures how the pinned DuckDB-wasm reads remote parquet in headless Chrome:
// for each query, its result, time, and the HTTP requests behind it (count,
// bytes, byte ranges, and the most requests in flight at once).
//
//   CHROME=/path/to/chrome node scripts/duckdb-http-probe.mjs [suite]
//
// Suites: `httpfs` (default) and `autoload` compare a 1 GB file read with and
// without an explicit LOAD httpfs; `s3` runs geo-query-style SQL (s3:// paths,
// globs, hive partitions) against NRP Ceph and source.coop.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DUCKDB = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0';
const CHROME = process.env.CHROME
    ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;

const BIG = 'https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/cboettig/bioclimate/chelsa-2-1/ssp370-2071-2100/hex/h0=577129255373111295/data_0.parquet';
const S3_SETUP = [
    'LOAD httpfs', 'INSTALL h3 FROM community', 'LOAD h3', 'INSTALL spatial', 'LOAD spatial',
    "CREATE SECRET s3 (TYPE S3, KEY_ID '', SECRET '', ENDPOINT 's3-west.nrp-nautilus.io', URL_STYLE 'path', USE_SSL true)",
    "CREATE SECRET source_coop (TYPE S3, KEY_ID '', SECRET '', ENDPOINT 's3.us-west-2.amazonaws.com', REGION 'us-west-2', URL_STYLE 'path', USE_SSL true, SCOPE 's3://us-west-2.opendata.source.coop')",
];
const WDPA = 's3://public-wdpa/wdpa/hex/**';
const SUITES = {
    httpfs: { setup: ['LOAD httpfs'], queries: {
        count: `SELECT count(*) AS n FROM read_parquet('${BIG}')`,
        one_column: `SELECT avg(bio1_gfdl_esm4) AS a FROM read_parquet('${BIG}')`,
        one_row: `SELECT count(*) AS n FROM read_parquet('${BIG}') WHERE h8 = (SELECT min(h8) FROM read_parquet('${BIG}'))`,
    } },
    autoload: { setup: [], queries: {
        count: `SELECT count(*) AS n FROM read_parquet('${BIG}')`,
    } },
    s3: { setup: S3_SETUP, queries: {
        glob_files: `SELECT count(*) AS files FROM glob('${WDPA}')`,
        glob_count: `SELECT count(*) AS n FROM read_parquet('${WDPA}')`,
        partition: `SELECT count(DISTINCT h8) AS h8_cells FROM read_parquet('${WDPA}') WHERE h0 = 576636674163867647`,
        h3_point: `SELECT NAME_ENG FROM read_parquet('${WDPA}') WHERE h0 = h3_cell_to_parent(h3_latlng_to_cell(37.87, -122.26, 8), 0) AND h8 = h3_latlng_to_cell(37.87, -122.26, 8) LIMIT 3`,
        source_coop: `SELECT count(*) AS n FROM read_parquet('s3://us-west-2.opendata.source.coop/cboettig/tpl-cities/browser-tiles/public-ca-dac/dac-2023/tract/hex/06001.parquet')`,
        https_url: `SELECT count(*) AS n FROM read_parquet('https://s3-west.nrp-nautilus.io/public-wdpa/wdpa/hex/h0=576636674163867647/data_0.parquet')`,
    } },
    locked: { setup: [...S3_SETUP,
        'LOAD parquet', 'LOAD json',
        "SET allowed_directories = ['s3://',  'https://s3-west.nrp-nautilus.io/', 'https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/']",
        'SET enable_external_access = false', 'SET lock_configuration = true'], queries: {
        allowed_glob: `SELECT count(*) AS files FROM glob('${WDPA}')`,
        allowed_s3: `SELECT count(*) AS n FROM read_parquet('s3://public-wdpa/wdpa/hex/h0=576636674163867647/data_0.parquet')`,
        allowed_https: `SELECT count(*) AS n FROM read_parquet('https://s3-west.nrp-nautilus.io/public-wdpa/wdpa/hex/h0=576636674163867647/data_0.parquet')`,
        h3: `SELECT h3_latlng_to_cell(37.87, -122.26, 8) AS cell`,
        other_host: `SELECT * FROM read_csv('https://example.org/x.csv')`,
        lookalike_host: `SELECT * FROM read_csv('https://s3-west.nrp-nautilus.io.example.org/x.csv')`,
        other_bucket: `SELECT * FROM read_parquet('s3://private-wyoming/x.parquet')`,
        unlock: 'SET enable_external_access = true',
        widen: "SET allowed_directories = ['https://']",
        gate: "SELECT json_serialize_sql('CREATE SECRET x (TYPE S3)') AS secret, json_serialize_sql('DESCRIBE SELECT 1') AS describe, json_serialize_sql('SUMMARIZE SELECT 1') AS summarize",
        new_secret: "CREATE SECRET evil (TYPE S3, ENDPOINT 'example.org', SCOPE 's3://public-x')",
    } },
};
const suite = SUITES[process.argv[2] ?? 'httpfs'];
if (!suite) throw new Error(`unknown suite; use one of ${Object.keys(SUITES).join(', ')}`);

const PAGE = `<!doctype html><meta charset=utf-8><script type=module>
window.run = async (setup, queries) => {
    const duckdb = await import('${DUCKDB}/+esm');
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    const w = URL.createObjectURL(new Blob(['importScripts("' + bundle.mainWorker + '");'], { type: 'text/javascript' }));
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(w));
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    const c = await db.connect();
    const out = { version: (await c.query('SELECT version() AS v')).toArray()[0].v };
    for (const s of setup) {
        try { await c.query(s); } catch (e) { out['setup: ' + s.slice(0, 40)] = 'ERROR ' + e.message.slice(0, 300); }
    }
    for (const [name, sql] of Object.entries(queries)) {
        window.mark = name;
        const t = performance.now();
        try {
            const rows = (await c.query(sql)).toArray().map(r => r.toJSON());
            out[name] = { rows: JSON.parse(JSON.stringify(rows, (_, v) => typeof v === 'bigint' ? String(v) : v)) };
        } catch (e) { out[name] = { error: String(e.message).slice(0, 300) }; }
        out[name].seconds = +((performance.now() - t) / 1000).toFixed(1);
        await new Promise(r => setTimeout(r, 300)); // let the probe attribute late requests
        window.mark = 'idle';
    }
    return out;
};
</script>`;

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const site = http.createServer((q, r) => r.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE));
const port = await listen(site);
const profile = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'duckdb-probe-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise(r => chrome.stderr.on('data', d => { const m = String(d).match(/ws:\/\/\S+/); if (m) r(m[0]); }));
const dport = new URL(wsUrl).port;
let target;
while (!target) target = (await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json()).find(t => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));

let id = 0, phase = 'setup';
const pending = new Map();
const requests = new Map();
const cdp = (method, params = {}, sessionId) => new Promise(r => {
    const i = ++id; pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
});
// Data requests only: not the page, DuckDB-wasm itself, or its extensions.
const isData = (url) => /^https?:/.test(url) && !/jsdelivr|extensions\.duckdb|127\.0\.0\.1/.test(url);
ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    const p = m.params;
    if (m.method === 'Target.attachedToTarget') {
        // DuckDB fetches from its own worker, so watch the network of every worker too.
        cdp('Network.enable', {}, p.sessionId);
        cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, p.sessionId);
    }
    if (m.method === 'Network.requestWillBeSent' && isData(p.request.url)) {
        const h = p.request.headers;
        requests.set(p.requestId, { phase, t0: Date.now(), method: p.request.method, url: p.request.url, range: h.Range ?? h.range, bytes: 0 });
    }
    if (m.method === 'Network.requestWillBeSentExtraInfo' && requests.has(p.requestId)) {
        const r = requests.get(p.requestId); r.range = p.headers.Range ?? p.headers.range ?? r.range;
    }
    if (m.method === 'Network.loadingFinished' && requests.has(p.requestId)) {
        const r = requests.get(p.requestId); r.bytes = p.encodedDataLength; r.t1 = Date.now();
    }
});

await cdp('Network.enable');
await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/` });
while ((await cdp('Runtime.evaluate', { expression: 'typeof window.run', returnByValue: true })).result.result.value !== 'function') {
    await new Promise(r => setTimeout(r, 100));
}
const poll = setInterval(async () => {
    phase = (await cdp('Runtime.evaluate', { expression: 'window.mark', returnByValue: true })).result.result.value ?? phase;
}, 50);
const res = await cdp('Runtime.evaluate', {
    expression: `run(${JSON.stringify(suite.setup)}, ${JSON.stringify(suite.queries)})`,
    awaitPromise: true, returnByValue: true,
});
clearInterval(poll);
const out = res.result.result.value ?? res.result;

for (const [name, q] of Object.entries(out)) {
    if (typeof q !== 'object') { console.log(`${name}: ${q}`); continue; }
    const rs = [...requests.values()].filter(r => r.phase === name);
    const events = rs.flatMap(r => [[r.t0, 1], [r.t1 ?? r.t0, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let now = 0, most = 0;
    for (const [, d] of events) { now += d; most = Math.max(most, now); }
    const mb = rs.reduce((s, r) => s + r.bytes, 0) / 1e6;
    console.log(`\n${name}  ${q.seconds} s  ${rs.length} requests  ${mb.toFixed(2)} MB  at most ${most} at once`);
    console.log(`  ${q.error ? `ERROR ${q.error}` : JSON.stringify(q.rows).slice(0, 200)}`);
    for (const r of rs.slice(0, 4)) console.log(`  ${r.method} ${r.range ?? 'whole'} ${r.url.slice(0, 110)}`);
}

ws.close();
chrome.kill();
site.close();
await new Promise(r => chrome.once('exit', r));
await fs.rm(profile, { recursive: true, force: true, maxRetries: 5 });
process.exit(0);
