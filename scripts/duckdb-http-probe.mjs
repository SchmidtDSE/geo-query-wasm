#!/usr/bin/env node
// Measures how DuckDB-wasm reads remote parquet in headless Chrome: for each
// query, its result, time, and the HTTP requests behind it (count, bytes, byte
// ranges, status, and the most requests in flight at once).
//
//   [DUCKDB_WASM=<version>] [HEADER_SHIM=drop|if-match|decode|none] node scripts/duckdb-http-probe.mjs [suite]
//
// Suites: `httpfs` (default) and `autoload` compare a 1 GB file read with and
// without an explicit LOAD httpfs; `s3` runs geo-query-style SQL (s3:// paths,
// globs, hive partitions) against NRP Ceph and source.coop; `locked` checks the
// access limits; `extensions` loads h3 and spatial; `spill` runs queries that
// need more than a 256 MB memory_limit; `cancel` times how fast a sent query
// stops after cancelSent(); `etag` reads one file from each host; `padus`
// reads one partition and all of PAD-US's hex files on source.coop.
//
// DUCKDB_WASM picks the @duckdb/duckdb-wasm version (default: the engine's
// pin). HEADER_SHIM picks how the DuckDB worker's If-Match and
// X-Host-Override headers are treated (engine.js WORKER_SHIM): `drop`
// drops both, as the engine does (default); `if-match` drops only If-Match,
// so every range read needs a CORS preflight; `decode` drops X-Host-Override
// and sends If-Match unencoded; `none` sends both, and DuckDB 2.0's reads fail
// with a 412.
// EXTRA_SETUP adds statements, separated by semicolons, to the suite's setup.

import http from 'node:http';
import { launchChrome, summarize } from './chrome.mjs';
import { DUCKDB_WASM } from '../src/defaults.js';
import { WORKER_SHIM } from '../src/engine.js';

const DUCKDB = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${process.env.DUCKDB_WASM ?? DUCKDB_WASM}`;
const BIG = 'https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/cboettig/bioclimate/chelsa-2-1/ssp370-2071-2100/hex/h0=577129255373111295/data_0.parquet';
const S3_SETUP = [
    'LOAD httpfs', 'INSTALL h3 FROM community', 'LOAD h3', 'INSTALL spatial', 'LOAD spatial',
    "CREATE SECRET s3 (TYPE S3, KEY_ID '', SECRET '', ENDPOINT 's3-west.nrp-nautilus.io', URL_STYLE 'path', USE_SSL true)",
    "CREATE SECRET source_coop (TYPE S3, KEY_ID '', SECRET '', ENDPOINT 's3.us-west-2.amazonaws.com', REGION 'us-west-2', URL_STYLE 'path', USE_SSL true, SCOPE 's3://us-west-2.opendata.source.coop')",
];
const WDPA = 's3://public-wdpa/wdpa/hex/**';
const PADUS = 's3://us-west-2.opendata.source.coop/cboettig/padus/padus-4-1/combined/hex/h0=*/data_0.parquet';
const SUITES = {
    httpfs: { setup: ['LOAD httpfs'], queries: {
        count: `SELECT count(*) AS n FROM read_parquet('${BIG}')`,
        one_column: `SELECT avg(bio1_gfdl_esm4) AS a FROM read_parquet('${BIG}')`,
        one_row: `SELECT count(*) AS n FROM read_parquet('${BIG}') WHERE h8 = (SELECT min(h8) FROM read_parquet('${BIG}'))`,
    } },
    autoload: { setup: [], queries: {
        count: `SELECT count(*) AS n FROM read_parquet('${BIG}')`,
    } },
    extensions: { setup: [], queries: {
        httpfs: 'LOAD httpfs', h3: "INSTALL h3 FROM community", h3_load: 'LOAD h3', spatial: 'INSTALL spatial', spatial_load: 'LOAD spatial',
        cell: 'SELECT h3_latlng_to_cell(37.87, -122.26, 8) AS cell', point: "SELECT ST_AsText(ST_Point(1, 2)) AS p",
        settings: "SELECT name, value FROM duckdb_settings() WHERE name IN ('temp_directory', 'memory_limit', 'max_temp_directory_size', 'threads')",
    } },
    spill: { setup: ["SET memory_limit = '256MB'", 'SET preserve_insertion_order = false'], queries: {
        group: 'SELECT count(*) AS groups, sum(s) AS total FROM (SELECT range % 20000000 AS k, sum(range) AS s FROM range(40000000) GROUP BY k)',
        sort: 'SELECT max(rn) AS n FROM (SELECT row_number() OVER (ORDER BY hash(range)) AS rn FROM range(30000000))',
    } },
    cancel: { setup: S3_SETUP, queries: {
        cancel_local: 'SELECT count(*) AS n FROM (SELECT range % 20000000 AS k, sum(range) AS s FROM range(200000000) GROUP BY k)',
        cancel_remote: `SELECT count(*) AS n FROM read_parquet('${WDPA}')`,
        after: 'SELECT 42 AS still_works',
    } },
    etag: { setup: S3_SETUP, queries: {
        nrp_file: `SELECT count(*) AS n FROM read_parquet('s3://public-wdpa/wdpa/hex/h0=576636674163867647/data_0.parquet')`,
        nrp_https: `SELECT count(*) AS n FROM read_parquet('https://s3-west.nrp-nautilus.io/public-wdpa/wdpa/hex/h0=576636674163867647/data_0.parquet')`,
        coop_file: `SELECT count(*) AS n FROM read_parquet('s3://us-west-2.opendata.source.coop/cboettig/tpl-cities/browser-tiles/public-ca-dac/dac-2023/tract/hex/06001.parquet')`,
        coop_big: `SELECT avg(bio1_gfdl_esm4) AS a FROM read_parquet('${BIG}')`,
    } },
    padus: { setup: S3_SETUP, queries: {
        partition: `SELECT Mang_Type, count(DISTINCT h8) AS cells FROM read_parquet('${PADUS}') WHERE h0 = 577199624117288959 GROUP BY ALL`,
        national: `SELECT GAP_Sts, count(*) AS n FROM read_parquet('${PADUS}') GROUP BY ALL`,
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
if (process.env.EXTRA_SETUP) suite.setup = [...suite.setup, ...process.env.EXTRA_SETUP.split(';')];

const SHIMS = {
    drop: WORKER_SHIM,
    decode: '{const set = XMLHttpRequest.prototype.setRequestHeader;'
        + 'XMLHttpRequest.prototype.setRequestHeader = function (k, v) { if (!/^x-host-override$/i.test(k)) return set.call(this, k, /^if-match$/i.test(k) ? decodeURI(v) : v); };}\n',
    'if-match': '{const set = XMLHttpRequest.prototype.setRequestHeader;'
        + 'XMLHttpRequest.prototype.setRequestHeader = function (k, v) { if (!/^if-match$/i.test(k)) return set.call(this, k, v); };}\n',
    none: '',
};
const PAGE = `<!doctype html><meta charset=utf-8><script type=module>
const SHIM = ${JSON.stringify(SHIMS[process.env.HEADER_SHIM ?? 'drop'])};
window.run = async (setup, queries) => {
    const duckdb = await import('${DUCKDB}/+esm');
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    const w = URL.createObjectURL(new Blob([SHIM + 'importScripts("' + bundle.mainWorker + '");'], { type: 'text/javascript' }));
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
            let table;
            if (name.startsWith('cancel_')) {
                // Send the query, cancel it after 3 s, and time how long it takes to stop.
                const timer = setTimeout(() => { window.cancelAt = performance.now(); c.cancelSent().then(ok => { window.cancelled = ok; }); }, 3000);
                try {
                    const reader = await c.send(sql);
                    const batches = []; for await (const b of reader) batches.push(b);
                    table = { toArray: () => batches.flatMap(b => b.toArray()) };
                } finally { clearTimeout(timer); }
            } else table = await c.query(sql);
            const rows = table.toArray().map(r => r.toJSON());
            out[name] = { rows: JSON.parse(JSON.stringify(rows, (_, v) => typeof v === 'bigint' ? String(v) : v)) };
        } catch (e) { out[name] = { error: String(e.message).slice(0, 300) }; }
        if (window.cancelAt) { out[name].stop_after_cancel = +((performance.now() - window.cancelAt) / 1000).toFixed(2); out[name].cancelled = window.cancelled; window.cancelAt = 0; }
        out[name].seconds = +((performance.now() - t) / 1000).toFixed(1);
        await new Promise(r => setTimeout(r, 300)); // let the probe attribute late requests
        window.mark = 'idle';
    }
    return out;
};
</script>`;

const site = http.createServer((q, r) => r.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE));
const port = await new Promise(r => site.listen(0, '127.0.0.1', () => r(site.address().port)));
const chrome = await launchChrome();
await chrome.open(`http://127.0.0.1:${port}/`);
const poll = setInterval(async () => {
    chrome.setPhase((await chrome.evaluate('window.mark').catch(() => null)) ?? 'setup');
}, 50);
const out = await chrome.evaluate(`run(${JSON.stringify(suite.setup)}, ${JSON.stringify(suite.queries)})`);
clearInterval(poll);

for (const [name, q] of Object.entries(out)) {
    if (typeof q !== 'object') { console.log(`${name}: ${q}`); continue; }
    const net = summarize(chrome.requests, name);
    console.log(`\n${name}  ${q.seconds} s  ${net.requests} requests  ${net.mb.toFixed(2)} MB  at most ${net.inFlight} at once`);
    console.log(`  ${q.error ? `ERROR ${q.error}` : JSON.stringify(q.rows).slice(0, 200)}`);
    if (q.stop_after_cancel != null) console.log(`  stopped ${q.stop_after_cancel} s after cancel (cancelSent returned ${q.cancelled})`);
    for (const r of net.list.slice(0, 4)) {
        console.log(`  ${r.method} ${r.status ?? r.failed ?? ''} ${r.range ?? 'whole'}${r.ifMatch ? ` If-Match ${r.ifMatch}` : ''} ${r.url.slice(0, 110)}`);
    }
}

await chrome.close();
site.close();
process.exit(0);
