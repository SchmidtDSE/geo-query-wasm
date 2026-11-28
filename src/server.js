/**
 * The MCP server: geo-query's tools and prompt over a SQL engine, with no
 * knowledge of where the engine runs. worker.js gives it DuckDB-wasm
 * inside a Web Worker; tests give it a stub.
 *
 * Tool names, arguments, descriptions and output conventions follow geo-query
 * (SchmidtDSE/geo-query, server.py), so a client or model can use either
 * server. As on geo-query, there are no STAC tools: dataset paths come from
 * the client's own catalog tool (geo-query#528). The hex-tile tools (register_hex_tiles, get_hex_tile_status) keep
 * their tiles in memory (hex.js) and serve them, and each tileset's
 * metadata.json, as resources at the tile URLs they return.
 */

import {
    Server,
    ListToolsRequestSchema, CallToolRequestSchema,
    ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema,
    ListPromptsRequestSchema, GetPromptRequestSchema,
} from '../vendor/mcp-server-sdk.js';
import { markdownTable, MAX_ROWS } from './format.js';
import { queryDescription } from './guidance.js';
import { REGISTER_HEX_TILES, GET_HEX_TILE_STATUS, TILE_BASE, MVT_TYPE, parseTileUrl } from './hex.js';
import { ZONAL_STATS, ZONAL_SCHEMA } from './zonal.js';

export const NAME = 'geo-query-wasm';
export const VERSION = '0.8.0';
export { MAX_ROWS };

// No s3_key or s3_secret: the model writes these arguments, so credentials
// come from the app (engine `secrets`, or sendSecrets() in secrets.js). A call
// that passes them anyway is refused by the engine.
const S3_ARGS = {
    s3_endpoint: { type: 'string' },
    s3_scope: { type: 'string' },
    s3_region: { type: 'string' },
    s3_url_style: { type: 'string' },
};

const HEX_TOOLS = [
    {
        name: 'register_hex_tiles',
        description: REGISTER_HEX_TILES,
        inputSchema: {
            type: 'object',
            properties: {
                sql: { type: 'string' },
                agg: { type: 'string', default: 'COUNT' },
                color_scale: { type: 'string', default: 'linear' },
                layer_style: { type: 'string', default: 'fill' },
                sql_query: { type: 'string' },
            },
        },
    },
    {
        name: 'get_hex_tile_status',
        description: GET_HEX_TILE_STATUS,
        inputSchema: {
            type: 'object',
            properties: {
                hash: { type: 'string' },
                wait_seconds: { type: 'integer', default: 0 },
                color_scale: { type: 'string', default: 'linear' },
                layer_style: { type: 'string', default: 'fill' },
            },
            required: ['hash'],
        },
    },
];

function tools({ description, hex, zonal }) {
    return [
        {
            name: 'query',
            description,
            inputSchema: {
                type: 'object',
                properties: {
                    sql_query: { type: 'string' },
                    ...S3_ARGS,
                    sql: { type: 'string' },
                    format: {
                        type: 'string',
                        enum: ['markdown', 'json'],
                        description: 'markdown (default): a table of at most 50 rows, for a model. json: every row, as the JSON array DuckDB\'s to_json writes, for app code.',
                    },
                },
            },
        },
        ...(hex ? HEX_TOOLS : []),
        zonal && { name: 'zonal_stats', description: ZONAL_STATS, inputSchema: ZONAL_SCHEMA },
    ].filter(Boolean);
}

/**
 * @param {Object} engine
 * @param {(sql: string, opts: {s3?: Object, limit?: number}) => Promise<Object[]>} engine.query - rows as plain objects
 * @param {(sql: string, opts: {s3?: Object}) => Promise<string>} engine.json - all rows as JSON text
 * @param {string} [engine.instructions] - server instructions for the handshake
 * @param {{optim?: string, h3?: string, role?: string}} [engine.guidance] - geo-query's guidance texts
 * @param {Object} [engine.hex] - createHexTiles() from hex.js; without it the hex-tile tools are not offered
 * @param {Function} [engine.zonal] - createZonalStats() from zonal.js; without it zonal_stats is not offered
 */
export function createServer(engine) {
    const { guidance = {}, hex, zonal } = engine;
    const description = queryDescription({ optim: guidance.optim ?? '', h3: guidance.h3 ?? '' });
    const server = new Server(
        { name: NAME, version: VERSION },
        {
            capabilities: { tools: {}, resources: {}, prompts: {} },
            ...(engine.instructions ? { instructions: engine.instructions } : {}),
        },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools({ description, hex, zonal }) }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const { name, arguments: args = {} } = req.params;
        if (name === 'query') return text(await runQuery(engine, args));
        if (zonal && name === 'zonal_stats') {
            try {
                return text(await zonal(args));
            } catch (err) {
                return { ...text(`Error executing tool zonal_stats: ${err.message}`), isError: true };
            }
        }
        if (hex && (name === 'register_hex_tiles' || name === 'get_hex_tile_status')) {
            try {
                return json(name === 'register_hex_tiles' ? await hex.register(args) : await hex.status(args));
            } catch (err) {
                // As FastMCP reports an exception raised by a tool.
                return { ...text(`Error executing tool ${name}: ${err.message}`), isError: true };
            }
        }
        return { ...text(`Unknown tool: ${name}`), isError: true };
    });

    // With hex tiles, the tiles and metadata.json that geo-query serves over
    // HTTP from /tiles. geo-query no longer has catalog:// resources.
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
        resourceTemplates: hex ? [
            { uriTemplate: `${TILE_BASE}{hash}/{z}/{x}/{y}.pbf`, name: 'hex_tile', mimeType: MVT_TYPE },
            { uriTemplate: `${TILE_BASE}{hash}/metadata.json`, name: 'hex_tile_metadata', mimeType: 'application/json' },
        ] : [],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
        const { uri } = req.params;
        if (hex && uri.startsWith(TILE_BASE)) return readTile(hex, uri);
        throw new Error(`Unknown resource: ${uri}`);
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
        prompts: [{ name: 'geospatial-analyst' }],
    }));
    server.setRequestHandler(GetPromptRequestSchema, async (req) => {
        if (req.params.name !== 'geospatial-analyst') throw new Error(`Unknown prompt: ${req.params.name}`);
        return { messages: [{ role: 'user', content: { type: 'text', text: guidance.role ?? '' } }] };
    });

    return server;
}

async function readTile(hex, uri) {
    const t = parseTileUrl(uri);
    if (!t) throw new Error(`Unknown resource: ${uri}`);
    if (t.metadata) {
        const meta = hex.metadata(t.hash);
        if (!meta) throw new Error(`No hex tileset ${t.hash} in this worker: register_hex_tiles builds it`);
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(meta) }] };
    }
    const bytes = await hex.tile(t.hash, t.z, t.x, t.y);
    if (!bytes) throw new Error(`No hex tileset ${t.hash} in this worker: register_hex_tiles builds it`);
    return { contents: [{ uri, mimeType: MVT_TYPE, blob: base64(bytes) }] };
}

function base64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

async function runQuery(engine, args) {
    // `sql` is an alias, as on geo-query; `query` too, for older clients.
    const sql = args.sql_query || args.sql || args.query;
    if (typeof sql !== 'string' || !sql.trim()) {
        return 'SQL Error: no query provided — pass the SQL as `sql_query` (the alias `sql` is also accepted).';
    }
    const format = args.format ?? 'markdown';
    if (format !== 'markdown' && format !== 'json') return `SQL Error: unknown format ${format}`;
    const s3 = {
        key: args.s3_key, secret: args.s3_secret, endpoint: args.s3_endpoint,
        scope: args.s3_scope, region: args.s3_region, url_style: args.s3_url_style,
    };
    const opts = Object.values(s3).some(Boolean) ? { s3 } : {};
    try {
        if (format === 'json') return await engine.json(sql, opts);
        // One row more than shown tells whether there are more, without a count.
        const rows = await engine.query(sql, { ...opts, limit: MAX_ROWS + 1 });
        return markdownTable(rows, MAX_ROWS);
    } catch (err) {
        return `SQL Error: ${err.message}`;
    }
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const json = (o) => text(JSON.stringify(o, null, 2));
