/**
 * The MCP server: geo-query's discovery and query tools over a SQL engine,
 * with no knowledge of where the engine runs. worker.js gives it DuckDB-wasm
 * inside a Web Worker; tests give it a stub.
 *
 * Tool names, arguments and the `SQL Error:` convention match geo-query
 * (SchmidtDSE/geo-query), so glen-harness and the model treat both servers
 * alike.
 */

import { Server, ListToolsRequestSchema, CallToolRequestSchema } from '../vendor/mcp-server-sdk.js';
import { markdownTable } from './format.js';

export const MAX_ROWS = 200;

const TOOLS = [
    {
        name: 'browse_stac_catalog',
        description: 'Browse the STAC catalog to see the IDs and titles of all available datasets.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'get_stac_details',
        description: 'Fetch metadata (parquet paths, column schemas) for a STAC collection by ID. Returns markdown.',
        inputSchema: {
            type: 'object',
            properties: { dataset_id: { type: 'string', description: 'Collection ID from browse_stac_catalog' } },
            required: ['dataset_id'],
        },
    },
    {
        name: 'query',
        description: [
            `Run one DuckDB SQL SELECT query in the user's browser and return the result as a markdown table (at most ${MAX_ROWS} rows).`,
            'There are no tables: read data with read_parquet(\'s3://...\'), using paths from get_stac_details or the server instructions verbatim.',
            'Filter or join on h0 so that only the needed partitions are read.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: { sql_query: { type: 'string', description: 'DuckDB SQL' } },
            required: ['sql_query'],
        },
    },
];

/**
 * @param {Object} engine
 * @param {(sql: string) => Promise<Object[]>} engine.query - rows as plain objects
 * @param {{browse: () => Promise<string>, details: (id: string) => Promise<string>}} engine.catalog
 * @param {string} engine.instructions
 */
export function createServer(engine) {
    const server = new Server(
        { name: 'glen-wasm', version: '0.2.0' },
        { capabilities: { tools: {} }, instructions: engine.instructions },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const { name, arguments: args = {} } = req.params;
        try {
            if (name === 'browse_stac_catalog') return text(await engine.catalog.browse());
            if (name === 'get_stac_details') {
                const id = args.dataset_id ?? args.collection_id;
                if (typeof id !== 'string' || !id.trim()) return text('Error: no dataset_id given');
                return text(await engine.catalog.details(id.trim()));
            }
        } catch (err) {
            return text(`Error: could not read the STAC catalog: ${err.message}`);
        }
        if (name === 'query') {
            const sql = args.sql_query ?? args.sql ?? args.query;
            if (typeof sql !== 'string' || !sql.trim()) return text('SQL Error: no sql_query given');
            try {
                const rows = await engine.query(sql);
                return text(markdownTable(rows, MAX_ROWS));
            } catch (err) {
                return text(`SQL Error: ${err.message}`);
            }
        }
        return text(`Error: unknown tool ${name}`);
    });

    return server;
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });
