/**
 * Web Worker entry: geo-query's MCP server, running in the browser.
 *
 * Starts the DuckDB-wasm engine and serves MCP over postMessage; the worker
 * has no other interface. A page connects with an MCP client and a
 * postMessage transport around the Worker (src/transport.js, or
 * glen-harness's PostMessageTransport).
 *
 * As on geo-query, there are no tables: the SQL reads parquet by URL, and the
 * model finds the paths through the STAC tools.
 *
 * An app configures the worker through its URL, as JSON in `config`:
 *
 *   new Worker(`…/src/worker.js?config=${encodeURIComponent(JSON.stringify(cfg))}`, { type: 'module' })
 *
 * cfg takes the engine's options (engine.js: workers, timeout, secrets, rewrite,
 * fetchWhole, settings, allowedDirectories, allowedEndpoints, duckdb) and
 * geo-query's deployment settings:
 *   catalog            STAC catalog.json URL (STAC_CATALOG_URL); the default is
 *                      the source.coop mirror, and NRP_CATALOG_URL in stac.js is
 *                      NRP's canonical catalog
 *   discovery          false hides browse_stac_catalog and catalog://list (STAC_DISCOVERY=0)
 *   extraInstructions  true keeps the guidance meant for small models (EXTRA_INSTRUCTIONS)
 *   guidanceRef        geo-query commit to take the guidance from
 *   instructions       server instructions sent in the handshake (geo-query sends none)
 *   maxTilesets        hex tilesets kept in memory; the least recently used
 *                      is dropped beyond this (default 8)
 * The SQL stays locked to SELECT statements on the allowed directories,
 * whatever the configuration, because a model may write it.
 *
 * S3 keys are not accepted in the URL, which is sent to the server that serves
 * this file. A page sends them with sendSecrets() (secrets.js), a message the
 * worker handles before MCP, so the model never sees them.
 */

import { PostMessageTransport } from './transport.js';
import { createServer } from './server.js';
import { createCatalog, CATALOG_URL } from './stac.js';
import { createEngine } from './engine.js';
import { loadGuidance, GEO_QUERY_REF } from './guidance.js';
import { createHexTiles, MAX_TILESETS } from './hex.js';
import { SECRETS_MESSAGE, hasKeys } from './secrets.js';

const fetchJson = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
};

// S3 secrets from the page (secrets.js). This listener comes before the MCP
// transport's, and stops the message from reaching MCP.
let engine = null;
const pending = [];
const applySecrets = async ({ id, secrets }) => {
    try {
        await engine.setSecrets(Array.isArray(secrets) ? secrets : []);
        self.postMessage({ type: SECRETS_MESSAGE, id, ok: true });
    } catch (err) {
        self.postMessage({ type: SECRETS_MESSAGE, id, ok: false, error: String(err.message ?? err) });
    }
};
self.addEventListener('message', (event) => {
    if (event.data?.type !== SECRETS_MESSAGE) return;
    event.stopImmediatePropagation();
    if (engine) applySecrets(event.data);
    else pending.push(event.data);
});

// Listen now: the page sends `initialize` straight away, and the transport
// queues it until the server connects, once DuckDB is ready.
const transport = new PostMessageTransport(self);

let config = {};
let configError = null;
try {
    const raw = new URL(self.location.href).searchParams.get('config');
    if (raw) config = JSON.parse(raw);
    if (hasKeys(config.secrets)) {
        throw new Error('S3 keys are not accepted in the worker URL, which is sent to the server that serves the '
            + 'worker. Send them with sendSecrets() (src/secrets.js).');
    }
} catch (err) {
    config = {};
    configError = err;
}
const {
    catalog: url = CATALOG_URL,
    discovery = true,
    extraInstructions = false,
    guidanceRef = GEO_QUERY_REF,
    instructions,
    maxTilesets = MAX_TILESETS,
    ...options
} = config;
const catalog = createCatalog(fetchJson, { url, discovery });
engine = createEngine({ ...options, lock: true });
for (const message of pending.splice(0)) applySecrets(message);

const [guidance, started] = await Promise.all([
    loadGuidance({ ref: guidanceRef, extra: extraInstructions }),
    (configError ? Promise.reject(new Error(`bad config: ${configError.message}`)) : engine.ready())
        .then(() => null, err => err),
]);
if (guidance.error) console.warn(`[geo-query-wasm] ${guidance.error}`);
if (started) console.error('[geo-query-wasm] failed to start', started);
const fail = async () => { throw new Error(`DuckDB did not start: ${started.message}`); };

await createServer({
    instructions,
    catalog,
    guidance,
    query: started ? fail : engine.query,
    json: started ? fail : engine.jsonText,
    hex: createHexTiles(started ? { arrow: fail, json: fail, createTable: fail, dropTable: fail } : engine, { maxTilesets }),
}).connect(transport);
