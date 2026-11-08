/**
 * Web Worker entry: the MCP data server, running in the browser.
 *
 * Starts the DuckDB-wasm engine and serves MCP over postMessage. The page
 * connects with glen-harness's MCPClient and a PostMessageTransport to this
 * worker; the worker has no other interface.
 *
 * As on geo-query, there are no tables: the SQL reads parquet by URL, from
 * NRP's S3 or source.coop, and the model finds the paths through the STAC
 * tools.
 *
 * An app configures the worker through its URL, as JSON in `config`:
 *
 *   new Worker(`…/src/worker.js?config=${encodeURIComponent(JSON.stringify(cfg))}`, { type: 'module' })
 *
 * cfg takes the engine's options (engine.js: workers, secrets, rewrite,
 * fetchWhole, settings, allowedDirectories, duckdb) plus:
 *   catalog       STAC catalog.json URL
 *   instructions  server instructions, in place of the default GLEN text
 * The SQL stays locked to SELECT statements on the allowed directories,
 * whatever the configuration, because a model may write it.
 */

import { PostMessageTransport } from '../vendor/glen-harness/post-message-transport.js';
import { createServer } from './server.js';
import { createCatalog, CATALOG_URL } from './stac.js';
import { createEngine } from './engine.js';
import { instructions } from './datasets.js';

const fetchJson = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
};

// Listen now: the page sends `initialize` straight away, and the transport
// queues it until the server connects, once DuckDB is ready.
const transport = new PostMessageTransport(self);

let config = {};
let configError = null;
try {
    const raw = new URL(self.location.href).searchParams.get('config');
    if (raw) config = JSON.parse(raw);
} catch (err) {
    configError = err;
}
const { catalog: catalogUrl = CATALOG_URL, instructions: text = instructions(), ...options } = config;
const catalog = createCatalog(fetchJson, catalogUrl);
const engine = createEngine({ ...options, lock: true });

(configError ? Promise.reject(new Error(`bad config: ${configError.message}`)) : engine.ready())
    .then(() => ({ instructions: text, catalog, query: engine.query, json: engine.jsonText }))
    .catch((err) => {
        console.error('[glen-wasm] failed to start', err);
        const fail = async () => { throw new Error(`DuckDB did not start: ${err.message}`); };
        return { instructions: text, catalog, query: fail, json: fail };
    })
    .then((e) => createServer(e).connect(transport));
