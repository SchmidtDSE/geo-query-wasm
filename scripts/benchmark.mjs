#!/usr/bin/env node
// Benchmarks geo-query-wasm against geo-query on fixed queries, from a point
// lookup to a statewide join of two hex datasets.
//
//   GEO_QUERY_TOKEN=… node scripts/benchmark.mjs [duckdb-wasm version …]
//   node scripts/benchmark.mjs --table    rewrite the tables from bench/results.json
//
// Each query runs on a fresh engine (src/engine.js, as apps use it: locked,
// with the default settings) in a new headless Chrome profile, reading the source.coop
// mirror. For each it records the time, the HTTP requests (count, megabytes,
// most in flight at once), the most memory DuckDB's worker held, and the
// result. The same SQL then runs on geo-query, which reads the same files
// from its own mirror, and the results are compared.
//
// Versions default to the engine's pin. Results go to bench/results.json,
// and the table in docs/capabilities.md is rewritten from them.
//
// Environment:
//   GEO_QUERY_URL    geo-query's MCP endpoint (default Carl's mirror)
//   GEO_QUERY_TOKEN  its bearer token; without it geo-query is skipped
//   TIMEOUT          the engine's time limit in seconds (default 600)
//   ONLY             comma-separated query ids to run
//   SETTINGS         JSON of DuckDB settings added to the engine's

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, summarize } from './chrome.mjs';
import { DUCKDB_WASM } from '../src/defaults.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = path.join(ROOT, 'bench/results.json');
const DOC = path.join(ROOT, 'docs/capabilities.md');
const GEO_QUERY_URL = process.env.GEO_QUERY_URL ?? 'https://duckdb-mcp.carlboettiger.info/mcp';
const TIMEOUT = Number(process.env.TIMEOUT ?? 600);

// The SQL names NRP's buckets, as geo-query's catalog does; the browser reads
// the same files on source.coop.
const REWRITE = [{ from: 's3://public-', to: 's3://us-west-2.opendata.source.coop/cboettig/' }];
const PADUS = "read_parquet('s3://public-padus/padus-4-1/combined/hex/h0=*/data_0.parquet')";
const UNITS = "read_parquet('s3://public-ca30x30/conserved-areas-terrestrial-2025/hex/h0=*/data_0.parquet')";
const WEIGHTS = "read_parquet('s3://public-ca30x30/conserved-areas-terrestrial-2025/hex-weights/h0=*/data_0.parquet')";
const ECO = "read_parquet('s3://public-ca30x30/ecoregion/hex/h0=*/data_0.parquet')";
const TRACTS = "read_parquet('s3://public-census/census-2024/tract/hex/h0=*/data_0.parquet')";
const CA_H0 = '577199624117288959'; // the res-0 cell holding most of California
const YOSEMITE = 'h3_latlng_to_cell(37.745, -119.59, 8)';

// The 30x30 Assessment Explorer's land panel (overview/protection.sql) for
// Alpine County with "Managed by: State", as boettiger-lab/ca-30x30 d11bb74
// expands it.
const ALPINE_CELLS = `SELECT DISTINCT e.h0, e.h8, e.h9, e.h10 FROM ${ECO} e JOIN (SELECT DISTINCT h0, h8, h10 FROM ${TRACTS} WHERE STATEFP = '06' AND GEOID LIKE '06003%') a ON e.h0 = a.h0 AND e.h10 = a.h10`;
const STATE = "(u.MNG_AG_LEV IN ('State'))";
const ALPINE = `WITH land AS MATERIALIZED (SELECT c.h0, c.h8, c.h9, c.h10, h3_cell_area(c.h10, 'km^2') AS area_km2, `
    + 'COALESCE((w.w1 + w.w2) * m.s12, 0) AS w12, COALESCE((w.w3 + w.w4) * m.s34, 0) AS w34, COALESCE(w.w1 + w.w2 + w.w3 + w.w4, 0) AS wc '
    + `FROM (${ALPINE_CELLS}) c LEFT JOIN ${WEIGHTS} w ON w.h0 = c.h0 AND w.h10 = c.h10 `
    + `LEFT JOIN (SELECT u.h0, u.h10, SUM(CASE WHEN ${STATE} THEN COALESCE(u.Final_g1_p, 0) + COALESCE(u.Final_g2_p, 0) ELSE 0 END) / NULLIF(SUM(COALESCE(u.Final_g1_p, 0) + COALESCE(u.Final_g2_p, 0)), 0) AS s12, `
    + `SUM(CASE WHEN ${STATE} THEN COALESCE(u.Final_g3_p, 0) + COALESCE(u.Final_g4_p, 0) ELSE 0 END) / NULLIF(SUM(COALESCE(u.Final_g3_p, 0) + COALESCE(u.Final_g4_p, 0)), 0) AS s34 `
    + `FROM ${UNITS} u SEMI JOIN (${ALPINE_CELLS}) k ON u.h0 = k.h0 AND u.h10 = k.h10 GROUP BY u.h0, u.h10) m ON m.h0 = c.h0 AND m.h10 = c.h10), `
    + 's AS (SELECT SUM(area_km2) AS land_km2, SUM(area_km2 * w12) AS gap12_km2, SUM(area_km2 * w34) AS gap34_km2, SUM(area_km2 * wc) AS conserved_km2 FROM land) '
    + 'SELECT land_km2 * 247.105 AS land_acres, gap12_km2 * 247.105 AS gap12_acres, gap34_km2 * 247.105 AS gap34_acres, gap12_km2 / land_km2 AS frac_gap12, gap34_km2 / land_km2 AS frac_gap34 FROM s';

export const QUERIES = [
    { id: 'point', label: 'Point lookup in PAD-US',
        sql: `SELECT DISTINCT Unit_Nm, Mang_Name FROM ${PADUS} WHERE h0 = h3_cell_to_parent(${YOSEMITE}, 0) AND h8 = ${YOSEMITE} ORDER BY ALL` },
    { id: 'partition', label: 'One PAD-US partition',
        sql: `SELECT Mang_Type, count(DISTINCT h8) AS cells FROM ${PADUS} WHERE h0 = ${CA_H0} GROUP BY ALL ORDER BY ALL` },
    { id: 'national', label: 'National PAD-US scan',
        sql: `SELECT GAP_Sts, count(*) AS n FROM ${PADUS} GROUP BY ALL ORDER BY ALL` },
    { id: 'statewide', label: 'Statewide 30x30 scan',
        sql: `SELECT MNG_AG_LEV, count(*) AS cells, round(sum(COALESCE(Final_g1_p, 0) + COALESCE(Final_g2_p, 0)), 3) AS gap12 FROM ${UNITS} GROUP BY ALL ORDER BY ALL` },
    { id: 'county_cells', label: 'County cells from national tracts',
        sql: `SELECT count(DISTINCT h10) AS cells FROM ${TRACTS} WHERE STATEFP = '06' AND GEOID LIKE '06003%'` },
    { id: 'alpine_state', label: '30x30 land panel for Alpine County',
        sql: ALPINE },
    { id: 'statewide_join', label: 'Statewide hex join',
        sql: `SELECT e.CA_Ecoregi, count(*) AS cells, round(sum(w.w1 + w.w2), 3) AS gap12 FROM ${ECO} e JOIN ${WEIGHTS} w ON e.h0 = w.h0 AND e.h10 = w.h10 GROUP BY ALL ORDER BY ALL` },
];

/** Rows of a markdown table as arrays of trimmed cells (geo-query pads its tables). */
const parseTable = (md) => md.split('\n').filter(l => l.startsWith('|') && !/^\|[\s:|-]+\|$/.test(l)).slice(1)
    .map(l => l.slice(1, -1).split('|').map(c => c.trim()));

/** Same rows, numbers equal to 6 significant figures. */
function sameResult(a, b) {
    const x = parseTable(a), y = parseTable(b);
    if (x.length !== y.length) return false;
    return x.every((row, i) => row.length === y[i].length && row.every((c, j) => {
        const d = y[i][j];
        if (c === d) return true;
        const [p, q] = [Number(c), Number(d)];
        return c !== '' && d !== '' && Number.isFinite(p) && Number.isFinite(q)
            && Math.abs(p - q) <= 1e-6 * Math.max(Math.abs(p), Math.abs(q));
    }));
}

async function geoQuery(sql) {
    const t0 = performance.now();
    const res = await fetch(GEO_QUERY_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.GEO_QUERY_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'query', arguments: { sql_query: sql } } }),
    });
    const body = await res.text();
    const seconds = +((performance.now() - t0) / 1000).toFixed(1);
    const data = body.split('\n').find(l => l.startsWith('data: '));
    const text = data ? JSON.parse(data.slice(6)).result?.content?.[0]?.text : `HTTP ${res.status}: ${body.slice(0, 200)}`;
    return /^SQL Error|^HTTP/.test(text) ? { seconds, error: text.slice(0, 300) } : { seconds, result: text };
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const PAGE = `<!doctype html><meta charset=utf-8><script type=module>
import { createEngine } from '/src/engine.js';
import { markdownTable } from '/src/format.js';
window.bench = async (duckdb, sql, timeout, rewrite, settings) => {
    const engine = createEngine({ duckdb, timeout, rewrite, settings });
    await engine.ready();
    const [{ v }] = await engine.json('SELECT version() AS v');
    window.mark = 'query';
    const t0 = performance.now();
    try {
        const rows = await engine.query(sql, { limit: 51 });
        return { version: v, seconds: (performance.now() - t0) / 1000, result: markdownTable(rows) };
    } catch (err) {
        return { version: v, seconds: (performance.now() - t0) / 1000, error: String(err.message).slice(0, 300) };
    } finally {
        window.mark = 'idle';
        await engine.close();
    }
};
</script>`;

if (process.argv[2] === '--table') {
    await writeTable(JSON.parse(await fs.readFile(RESULTS, 'utf8')));
    process.exit(0);
}

const site = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x').pathname;
    if (url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE); return; }
    const file = path.join(ROOT, decodeURIComponent(url));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try {
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(await fs.readFile(file));
    } catch { res.writeHead(404).end(); }
});
const port = await new Promise(r => site.listen(0, '127.0.0.1', () => r(site.address().port)));

const versions = process.argv.slice(2).length ? process.argv.slice(2) : [DUCKDB_WASM];
const only = process.env.ONLY?.split(',');
const queries = QUERIES.filter(q => !only || only.includes(q.id));
const run = { date: new Date().toISOString().slice(0, 10), browser: null, timeout: TIMEOUT, wasm: {}, geoQuery: null };
let chrome = null;

try {
    for (const v of versions) {
        run.wasm[v] = {};
        for (const q of queries) {
            // A new browser profile for each query: it starts cold, with no
            // files or CORS preflights cached by an earlier query.
            await chrome?.close();
            chrome = await launchChrome();
            run.browser = chrome.version;
            await chrome.open(`http://127.0.0.1:${port}/`);
            let peak = 0, polling = true;
            // Worker memory, sampled while the query runs; WebAssembly memory
            // only grows, so the last sample is close to the peak.
            const sampler = (async () => {
                while (polling) {
                    peak = Math.max(peak, await chrome.memory());
                    await new Promise(r => setTimeout(r, 250));
                }
            })();
            const poll = setInterval(async () => {
                chrome.setPhase((await chrome.evaluate('window.mark').catch(() => null)) ?? 'setup');
            }, 50);
            const out = await chrome.evaluate(`bench(${JSON.stringify(v)}, ${JSON.stringify(q.sql)}, ${TIMEOUT}, ${JSON.stringify(REWRITE)}, ${process.env.SETTINGS ?? '{}'})`);
            clearInterval(poll);
            polling = false;
            await sampler;
            const net = summarize(chrome.requests, 'query');
            const methods = {};
            for (const x of net.list) methods[x.method] = (methods[x.method] ?? 0) + 1;
            const r = { ...out, seconds: +out.seconds.toFixed(1), requests: net.requests, methods, mb: net.mb, inFlight: net.inFlight, peakMb: Math.round(peak / 1e6) };
            run.wasm[v][q.id] = r;
            console.log(`${v} ${q.id}: ${r.seconds} s, ${r.requests} requests ${JSON.stringify(methods)}, ${r.mb} MB, ${r.peakMb} MB memory${r.error ? `, ERROR ${r.error}` : ''}`);
        }
    }
    if (process.env.GEO_QUERY_TOKEN) {
        run.geoQuery = { url: GEO_QUERY_URL };
        for (const q of queries) {
            const r = await geoQuery(q.sql);
            run.geoQuery[q.id] = r;
            console.log(`geo-query ${q.id}: ${r.seconds} s${r.error ? `, ERROR ${r.error}` : ''}`);
        }
    }
    for (const q of queries) {
        for (const v of versions) {
            const w = run.wasm[v][q.id], g = run.geoQuery?.[q.id];
            if (w.result && g?.result) w.matchesGeoQuery = sameResult(w.result, g.result);
        }
    }
} finally {
    await chrome?.close();
    site.close();
}

// Keep earlier runs of other versions; replace this run's.
let all = [];
try { all = JSON.parse(await fs.readFile(RESULTS, 'utf8')); } catch { /* first run */ }
all = all.filter(r => !(r.date === run.date && Object.keys(r.wasm).some(v => versions.includes(v))));
all.push(run);
await fs.mkdir(path.dirname(RESULTS), { recursive: true });
await fs.writeFile(RESULTS, JSON.stringify(all, null, 2) + '\n');

await writeTable(all);
process.exit(0);

/** Rewrite the table between the benchmark markers in docs/capabilities.md from the latest run of each version. */
async function writeTable(runs) {
    let doc;
    try { doc = await fs.readFile(DOC, 'utf8'); } catch { return; }
    const latest = new Map();
    for (const r of runs) for (const v of Object.keys(r.wasm)) latest.set(v, r);
    const geo = [...runs].reverse().find(r => r.geoQuery)?.geoQuery;
    const cell = (r) => !r ? '' : r.error ? (/time limit/.test(r.error) ? `stopped at ${r.seconds} s` : /Out of Memory/.test(r.error) ? `out of memory at ${r.seconds} s` : `error at ${r.seconds} s`)
        : `${r.seconds} s`;
    const lines = [];
    for (const [v, r] of latest) {
        const version = Object.values(r.wasm[v]).find(x => x.version)?.version ?? '';
        lines.push(`### duckdb-wasm ${v}`, '', `These results are for DuckDB ${version} in ${r.browser} on ${r.date}, against geo-query at ${geo?.url ?? '(not run)'}.`, '');
        lines.push('| Query | Browser | Requests | Read | Worker memory | geo-query | Same result |', '|---|---|---|---|---|---|---|');
        for (const q of QUERIES) {
            const w = r.wasm[v][q.id];
            if (!w) continue;
            const g = geo?.[q.id];
            lines.push(`| ${q.label} | ${cell(w)} | ${w.requests.toLocaleString('en-US')} | ${w.mb.toLocaleString('en-US')} MB | ${w.peakMb.toLocaleString('en-US')} MB | ${cell(g)} | ${w.matchesGeoQuery == null ? '' : w.matchesGeoQuery ? 'yes' : 'no'} |`);
        }
        lines.push('');
    }
    const start = '<!-- benchmark:start -->', end = '<!-- benchmark:end -->';
    if (!doc.includes(start)) return;
    doc = doc.slice(0, doc.indexOf(start) + start.length) + '\n' + lines.join('\n') + doc.slice(doc.indexOf(end));
    await fs.writeFile(DOC, doc);
}
