/**
 * The MCP server: geo-query's tools, resources and prompt over a SQL engine,
 * with no knowledge of where the engine runs. worker.js gives it DuckDB-wasm
 * inside a Web Worker; tests give it a stub.
 *
 * Tool names, arguments, descriptions and output conventions follow geo-query
 * (SchmidtDSE/geo-query, server.py), so a client or model can use either
 * server. geo-query's hex-tile tools (register_hex_tiles,
 * get_hex_tile_status) are not here yet.
 */

import {
    Server,
    ListToolsRequestSchema, CallToolRequestSchema,
    ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema,
    ListPromptsRequestSchema, GetPromptRequestSchema,
} from '../vendor/mcp-server-sdk.js';
import { markdownTable, MAX_ROWS } from './format.js';
import { queryDescription } from './guidance.js';

export const NAME = 'geo-query-wasm';
export const VERSION = '0.3.0';
export { MAX_ROWS };

const S3_ARGS = {
    s3_key: { type: 'string' },
    s3_secret: { type: 'string' },
    s3_endpoint: { type: 'string' },
    s3_scope: { type: 'string' },
    s3_region: { type: 'string' },
    s3_url_style: { type: 'string' },
};

function tools({ discovery, description }) {
    return [
        discovery && {
            name: 'browse_stac_catalog',
            description: [
                'Browse the full public STAC catalog to discover datasets not already loaded in your app.',
                'Use when the user asks about data outside your pre-configured layers.',
                'Optionally provide catalog inline (a Catalog dict with nested `children: [<collection dict>, ...]`)',
                'to skip the HTTP fetch entirely — useful for OAuth-walled deployments where the',
                'client already has the catalog content cached.',
            ].join('\n'),
            inputSchema: { type: 'object', properties: { catalog: { type: 'object' } } },
        },
        {
            name: 'get_stac_details',
            description: [
                'Fetch metadata (parquet paths, column schemas) for any STAC collection by ID.',
                'Returns markdown formatted for LLM consumption (use get_collection for structured JSON).',
                'Optionally provide collection inline (a Collection dict, optionally with embedded',
                '`children: [<sub-collection dict>, ...]`) to skip the HTTP fetch entirely.',
            ].join('\n'),
            inputSchema: {
                type: 'object',
                properties: { dataset_id: { type: 'string' }, collection: { type: 'object' } },
                required: ['dataset_id'],
            },
        },
        {
            name: 'get_collection',
            description: [
                'Return structured STAC collection metadata as JSON for programmatic use.',
                '',
                'Unlike get_stac_details (markdown for LLM consumption), this returns the',
                'raw collection dict with all assets (parquet, PMTiles, COG, GeoJSON),',
                'per-asset STAC extension fields (table:columns, raster:bands, vector:layers),',
                'full collection metadata, and nested child collections. S3 paths are pre-resolved.',
                '',
                'Optionally provide collection inline (a Collection dict, optionally with embedded',
                '`children: [<sub-collection dict>, ...]`) to skip the HTTP fetch — output round-trips',
                'back into the same parameter.',
                '',
                'Intended for app code that builds map layers and system prompts programmatically.',
            ].join('\n'),
            inputSchema: {
                type: 'object',
                properties: { collection_id: { type: 'string' }, collection: { type: 'object' } },
                required: ['collection_id'],
            },
        },
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
    ].filter(Boolean);
}

/**
 * @param {Object} engine
 * @param {(sql: string, opts: {s3?: Object, limit?: number}) => Promise<Object[]>} engine.query - rows as plain objects
 * @param {(sql: string, opts: {s3?: Object}) => Promise<string>} engine.json - all rows as JSON text
 * @param {Object} engine.catalog - createCatalog() from stac.js
 * @param {string} [engine.instructions] - server instructions for the handshake
 * @param {{optim?: string, h3?: string, role?: string}} [engine.guidance] - geo-query's guidance texts
 */
export function createServer(engine) {
    const { catalog, guidance = {} } = engine;
    const discovery = catalog.discovery !== false;
    const description = queryDescription({ discovery, optim: guidance.optim ?? '', h3: guidance.h3 ?? '' });
    const server = new Server(
        { name: NAME, version: VERSION },
        {
            capabilities: { tools: {}, resources: {}, prompts: {} },
            ...(engine.instructions ? { instructions: engine.instructions } : {}),
        },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools({ discovery, description }) }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const { name, arguments: args = {} } = req.params;
        if (name === 'query') return text(await runQuery(engine, args));
        try {
            if (name === 'browse_stac_catalog' && discovery) return text(await catalog.browse(args.catalog ?? null));
            if (name === 'get_stac_details') {
                const id = args.dataset_id ?? args.collection_id ?? args.collection?.id;
                if (!args.collection && (typeof id !== 'string' || !id.trim())) return text('Error: no dataset_id given');
                return text(await catalog.details(String(id ?? '').trim(), args.collection ?? null));
            }
            if (name === 'get_collection') {
                const id = args.collection_id ?? args.dataset_id ?? args.collection?.id;
                if (!args.collection && (typeof id !== 'string' || !id.trim())) return json({ error: 'no collection_id given' });
                return json(await catalog.collection(String(id ?? '').trim(), args.collection ?? null));
            }
        } catch (err) {
            if (name === 'get_collection') return json({ error: err.message });
            return text(`Error: ${err.message}`);
        }
        return { ...text(`Unknown tool: ${name}`), isError: true };
    });

    // Resources, as geo-query registers them: catalog://list with discovery,
    // and catalog://{dataset_id} always.
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: discovery ? [{ uri: 'catalog://list', name: 'catalog_list', mimeType: 'text/plain' }] : [],
    }));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
        resourceTemplates: [{ uriTemplate: 'catalog://{dataset_id}', name: 'catalog_dataset', mimeType: 'text/plain' }],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
        const { uri } = req.params;
        const m = uri.match(/^catalog:\/\/(.+)$/);
        if (!m || (m[1] === 'list' && !discovery)) throw new Error(`Unknown resource: ${uri}`);
        const body = m[1] === 'list' ? await catalog.browse() : await catalog.details(decodeURIComponent(m[1]));
        return { contents: [{ uri, mimeType: 'text/plain', text: body }] };
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
