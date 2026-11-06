/**
 * Web Worker entry: the MCP data server, running in the browser.
 *
 * Starts DuckDB-wasm and serves MCP over postMessage. The page connects with
 * glen-harness's MCPClient and a PostMessageTransport to this worker; the
 * worker has no other interface.
 *
 * As on geo-query, there are no tables: the model's SQL reads parquet by URL,
 * from NRP's S3 or source.coop, and finds the paths through the STAC tools.
 */

import { PostMessageTransport } from '../vendor/glen-harness/post-message-transport.js';
import { createServer } from './server.js';
import { createCatalog } from './stac.js';
import { ALLOWED_DIRECTORIES, S3_SECRETS, instructions } from './datasets.js';

const DUCKDB = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0';

const DECIMAL = 7; // apache-arrow Type.Decimal

/** An unscaled decimal string as a BigInt (scale 0, exact) or a Number. */
function decimal(digits, scale) {
    return scale === 0 ? BigInt(digits) : Number(digits) / 10 ** scale;
}

const fetchJson = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
};
const catalog = createCatalog(fetchJson);

// Listen now: the page sends `initialize` straight away, and the transport
// queues it until the server connects, once DuckDB is ready.
const transport = new PostMessageTransport(self);

start()
    .catch((err) => {
        console.error('[glen-wasm] failed to start', err);
        const fail = async () => { throw new Error(`DuckDB did not start: ${err.message}`); };
        return { instructions: instructions(), catalog, query: fail };
    })
    .then((engine) => createServer(engine).connect(transport));

async function start() {
    const duckdb = await import(`${DUCKDB}/+esm`);
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    // DuckDB runs in its own worker, started from here.
    const workerUrl = URL.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }));
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    const conn = await db.connect();

    // LOAD httpfs explicitly: without it DuckDB-wasm's built-in HTTP reader
    // downloads whole files instead of byte ranges (duckdb-wasm#2153). Every
    // extension is loaded now, because none can be once access is locked.
    for (const sql of [
        'LOAD httpfs', 'LOAD parquet', 'LOAD json',
        'INSTALL h3 FROM community', 'LOAD h3',
        'INSTALL spatial', 'LOAD spatial',
        ...S3_SECRETS,
    ]) await conn.query(sql);

    // The SQL may read only the data hosts. allowed_directories applies once
    // external access is off, and the lock stops a query from changing either.
    await conn.query(`SET allowed_directories = [${ALLOWED_DIRECTORIES.map(d => `'${d}'`).join(', ')}]`);
    await conn.query('SET enable_external_access = false');
    await conn.query('SET lock_configuration = true');

    // The lock does not cover secrets, and a new secret could send an allowed
    // s3:// path to another endpoint. DuckDB serializes only SELECT statements
    // to JSON, so it is the check that each query is read-only.
    const check = await conn.prepare('SELECT json_serialize_sql($1::VARCHAR) AS j');
    const assertSelect = async (sql) => {
        const parsed = JSON.parse((await check.query(sql)).toArray()[0].j);
        if (!parsed.error) return;
        throw new Error(parsed.error_type === 'not implemented'
            ? 'only SELECT queries run here (also DESCRIBE, SUMMARIZE and FROM-first forms)'
            : parsed.error_message);
    };

    const query = async (sql) => {
        await assertSelect(sql);
        const table = await conn.query(sql);
        // Arrow hands DECIMAL (and HUGEINT, as DECIMAL(38,0)) back as unscaled
        // big integers; apply the scale. SUM over an integer column is HUGEINT.
        const decimals = table.schema.fields
            .filter(f => f.type.typeId === DECIMAL)
            .map(f => [f.name, f.type.scale]);
        return table.toArray().map((r) => {
            const row = r.toJSON();
            for (const [name, scale] of decimals) {
                if (row[name] != null) row[name] = decimal(String(row[name]), scale);
            }
            // Geometry arrives as WKB bytes, which mean nothing in a table;
            // geo-query drops geometry columns too.
            for (const k of Object.keys(row)) if (row[k] instanceof Uint8Array) delete row[k];
            return row;
        });
    };

    return { instructions: instructions(), catalog, query };
}
