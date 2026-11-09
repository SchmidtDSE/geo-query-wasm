#!/usr/bin/env node
// Private-bucket check in headless Chrome: a page starts the worker, sends a
// user's S3 keys with sendSecrets(), and runs `query` over MCP on a private
// object. Checks that DuckDB-wasm signs every request (AWS4-HMAC-SHA256) and
// reads with byte ranges, that nothing the model receives contains the keys,
// and that the model cannot read them back (duckdb_secrets()), pass its own
// (s3_key), or have them put in the worker's URL.
//
//   PRIVATE_S3_ENDPOINT=minio.example.org PRIVATE_S3_KEY=… PRIVATE_S3_SECRET=… \
//   PRIVATE_S3_PATH=s3://my-bucket/file.parquet node scripts/private-check.mjs
//
// The bucket's CORS rules must allow http://127.0.0.1 (any port) for GET and
// HEAD with the headers Authorization, x-amz-content-sha256 and x-amz-date.
// The keys are read from the environment and never printed.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findChrome } from './find-chrome.mjs';

const { PRIVATE_S3_ENDPOINT: ENDPOINT, PRIVATE_S3_KEY: KEY, PRIVATE_S3_SECRET: SECRET, PRIVATE_S3_PATH: OBJECT } = process.env;
if (!ENDPOINT || !KEY || !SECRET || !OBJECT) {
    console.log('skipped: set PRIVATE_S3_ENDPOINT, PRIVATE_S3_KEY, PRIVATE_S3_SECRET and PRIVATE_S3_PATH');
    process.exit(0);
}
const BUCKET = OBJECT.match(/^s3:\/\/[^/]+/)[0];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = findChrome();

const PAGE = `<!doctype html><meta charset=utf-8><script type=module>
import { sendSecrets } from '/src/secrets.js';
const rpc = (worker) => {
    let id = 0; const waiting = new Map(); const seen = [];
    worker.addEventListener('message', (e) => {
        if (e.data?.type) return; // the secrets reply
        seen.push(JSON.stringify(e.data));
        if (e.data?.id && waiting.has(e.data.id)) { waiting.get(e.data.id)(e.data); waiting.delete(e.data.id); }
    });
    const call = (method, params) => new Promise(r => { const i = ++id; waiting.set(i, r); worker.postMessage({ jsonrpc: '2.0', id: i, method, params }); });
    return { call, seen, notify: (method) => worker.postMessage({ jsonrpc: '2.0', method }) };
};
const start = async (config) => {
    const worker = new Worker('/src/worker.js?config=' + encodeURIComponent(JSON.stringify(config)), { type: 'module' });
    const c = rpc(worker);
    await c.call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'private-check', version: '0' } });
    c.notify('notifications/initialized');
    return { worker, ...c };
};
const text = (r) => r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r);
window.run = async (s, object) => {
    const out = {};
    const a = await start({ discovery: false });
    out.before = text(await a.call('tools/call', { name: 'query', arguments: { sql_query: \`SELECT count(*) AS n FROM read_parquet('\${object}')\` } }));
    await sendSecrets(a.worker, [{ name: 'mine', scope: s.scope, endpoint: s.endpoint, key: s.key, secret: s.secret, region: 'us-east-1' }]);
    window.mark = 'signed';
    out.count = text(await a.call('tools/call', { name: 'query', arguments: { sql_query: \`SELECT count(*) AS n FROM read_parquet('\${object}')\` } }));
    window.mark = 'idle';
    out.secrets = text(await a.call('tools/call', { name: 'query', arguments: { sql_query: 'SELECT * FROM duckdb_secrets()' } }));
    out.modelKeys = text(await a.call('tools/call', { name: 'query', arguments: { sql_query: 'SELECT 1', s3_key: 'AKIAFROMMODEL', s3_secret: 'x' } }));
    out.schema = JSON.stringify((await a.call('tools/list', {})).result.tools.find(t => t.name === 'query').inputSchema.properties);
    // A wrong secret with the real key ID: the S3 error names the key ID.
    await sendSecrets(a.worker, [{ name: 'mine', scope: s.scope, endpoint: s.endpoint, key: s.key, secret: s.secret + 'x', region: 'us-east-1' }]);
    out.badSecret = text(await a.call('tools/call', { name: 'query', arguments: { sql_query: \`SELECT count(*) AS n FROM read_parquet('\${object}')\` } }));
    out.mcpTraffic = a.seen.join('\\n');
    const b = new Worker('/src/worker.js?config=' + encodeURIComponent(JSON.stringify({ secrets: [{ scope: s.scope, key: 'k', secret: 's' }] })), { type: 'module' });
    const bc = rpc(b);
    await bc.call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'private-check', version: '0' } });
    out.urlKeys = text(await bc.call('tools/call', { name: 'query', arguments: { sql_query: 'SELECT 1' } }));
    return out;
};
</script>`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const listen = (server) => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const port = await listen(http.createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE); return; }
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try { res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(await fs.readFile(file)); }
    catch { res.writeHead(404).end(); }
}));

const profile = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'private-check-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise(r => chrome.stderr.on('data', d => { const m = String(d).match(/ws:\/\/\S+/); if (m) r(m[0]); }));
let target;
while (!target) target = (await (await fetch(`http://127.0.0.1:${new URL(wsUrl).port}/json/list`)).json()).find(t => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0, phase = 'setup';
const pending = new Map(), requests = [];
const cdp = (method, params = {}, sessionId) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
const host = `https://${ENDPOINT}/`;
ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data), p = m.params;
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Target.attachedToTarget') {
        cdp('Network.enable', {}, p.sessionId);
        cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, p.sessionId);
    }
    if (m.method === 'Network.requestWillBeSentExtraInfo' && phase === 'signed') {
        const h = Object.fromEntries(Object.entries(p.headers).map(([k, v]) => [k.toLowerCase(), v]));
        if ((h[':authority'] && host.includes(h[':authority'])) || requests.length < 1e4) {
            if (h[':path'] || h.host) requests.push({ auth: (h.authorization ?? '').split(' ')[0], range: h.range ?? null, method: h[':method'] });
        }
    }
});
await cdp('Network.enable');
await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/` });
while ((await cdp('Runtime.evaluate', { expression: 'typeof window.run', returnByValue: true })).result.result.value !== 'function') await new Promise(r => setTimeout(r, 100));
const poll = setInterval(async () => { phase = (await cdp('Runtime.evaluate', { expression: 'window.mark', returnByValue: true })).result.result.value ?? phase; }, 20);
const res = await cdp('Runtime.evaluate', {
    expression: `run(${JSON.stringify({ scope: BUCKET, endpoint: ENDPOINT, key: KEY, secret: SECRET })}, ${JSON.stringify(OBJECT)})`,
    awaitPromise: true, returnByValue: true,
});
clearInterval(poll);
const out = res.result.result.value;
if (!out) { console.error('page failed:', JSON.stringify(res.result).replaceAll(KEY, '[KEY]').replaceAll(SECRET, '[SECRET]').slice(0, 800)); process.exit(1); }

const leaks = (s) => s.includes(KEY) || s.includes(SECRET);
const reads = requests.filter(r => r.method !== 'OPTIONS');
const checks = [
    ['without keys the private object is refused', /SQL Error/.test(out.before)],
    ['with sendSecrets() the query returns a count', /\|\s*n\s*\|/.test(out.count) && !/SQL Error/.test(out.count)],
    ['every read is signed (AWS4-HMAC-SHA256)', reads.length > 0 && reads.every(r => r.auth === 'AWS4-HMAC-SHA256')],
    ['reads use byte ranges', reads.some(r => r.range)],
    ['duckdb_secrets() is refused', /not available here/.test(out.secrets)],
    ['keys passed by the model are refused', /not accepted with a query/.test(out.modelKeys)],
    ['the query schema offers no s3_key or s3_secret', !/s3_key|s3_secret/.test(out.schema)],
    ['a failed signed read reports an error', /SQL Error/.test(out.badSecret)],
    ['keys in the worker URL are refused', /not accepted in the worker URL/.test(out.urlKeys)],
    ['no MCP message to the model contains the key or secret', !leaks(out.mcpTraffic)],
];
let failed = 0;
for (const [name, ok] of checks) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) failed++; }
console.log(`signed reads: ${reads.length}, with a Range header: ${reads.filter(r => r.range).length}`);
console.log(`error shown to the model for a wrong secret: ${out.badSecret.replaceAll(KEY, '[KEY]').replaceAll(SECRET, '[SECRET]').slice(0, 300)}`);

ws.close(); chrome.kill();
await new Promise(r => chrome.once('exit', r));
await fs.rm(profile, { recursive: true, force: true, maxRetries: 5 });
process.exit(failed ? 1 : 0);
