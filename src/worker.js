/**
 * Web Worker entry: geo-query's MCP server, running in the browser.
 *
 * Starts the DuckDB-wasm engine and serves MCP over postMessage; the worker
 * has no other interface. A page connects with an MCP client and a
 * postMessage transport around the Worker (src/transport.js, or
 * glen-harness's PostMessageTransport).
 *
 * As on geo-query, there are no tables: the SQL reads parquet by URL, and the
 * model finds the paths with the client's own catalog tool; the server has no
 * STAC tools (geo-query#528). A page without one can use stac.js, as the demo
 * page does.
 *
 * An app configures the worker through its URL, as JSON in `config`:
 *
 *   new Worker(`…/src/worker.js?config=${encodeURIComponent(JSON.stringify(cfg))}`, { type: 'module' })
 *
 * cfg takes the engine's options (engine.js: workers, timeout, secrets,
 * httpsToS3, rewrite, fetchWhole, settings, allowedDirectories,
 * allowedEndpoints, duckdb) and geo-query's deployment settings:
 *   extraInstructions  true keeps the guidance meant for small models (EXTRA_INSTRUCTIONS)
 *   guidanceRef        geo-query commit to take the guidance from
 *   instructions       server instructions sent in the handshake (geo-query sends none)
 *   maxTilesets        hex tilesets kept in memory; the least recently used
 *                      is dropped beyond this (default 8)
 *   zonalStats         true offers zonal_stats, zonal statistics on a COG with
 *                      no hex copy (zonal.js); off by default
 *   catalog            STAC catalog.json URL in which zonal_stats looks for a
 *                      raster's hex copy; the default is the source.coop mirror
 *                      of GLEN's catalog (CATALOG_URL in stac.js)
 *   zonalMaxPixels     pixels one zonal_stats call may read (default 25 million)
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
import { createEngine, resolveOptions } from './engine.js';
import { loadGuidance, GEO_QUERY_REF } from './guidance.js';
import { createHexTiles, MAX_TILESETS } from './hex.js';
import { createZonalStats, GEOTIFF_URL, MAX_PIXELS } from './zonal.js';
import { markdownTable, MAX_ROWS } from './format.js';
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
    discovery: _discovery, // accepted from older apps and ignored: no STAC tools now
    extraInstructions = false,
    guidanceRef = GEO_QUERY_REF,
    instructions,
    maxTilesets = MAX_TILESETS,
    zonalStats = false,
    zonalMaxPixels = MAX_PIXELS,
    ...options
} = config;
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
    guidance,
    query: started ? fail : engine.query,
    json: started ? fail : engine.jsonText,
    hex: createHexTiles(started ? { arrow: fail, json: fail, createTable: fail, dropTable: fail } : engine, { maxTilesets }),
    zonal: zonalStats ? createZonalStats({
        // geotiff.js loads only when a call needs it.
        open: async url => (await import(GEOTIFF_URL)).fromUrl(url),
        query: started ? fail : engine.query,
        allowed: resolveOptions({ ...options, lock: true }).allowedDirectories,
        // Read only when zonal_stats is called.
        catalog: createCatalog(fetchJson, { url }),
        maxPixels: zonalMaxPixels,
        format: rows => markdownTable(rows, MAX_ROWS),
    }) : null,
}).connect(transport);
