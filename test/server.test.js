import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MCPClient, PostMessageTransport, isFailedToolResult } from '../vendor/glen-harness/index.js';
import { createServer, MAX_ROWS } from '../src/server.js';

// The worker's server with a stub engine, reached the way the page reaches it:
// glen-harness's MCPClient over a PostMessageTransport. A MessageChannel stands
// in for page ↔ Worker.

const stubEngine = {
    instructions: 'No tables exist; read parquet by URL.',
    catalog: {
        browse: async () => '# Available Datasets (1 collections)\n\n- **wdpa**: **WDPA**',
        details: async (id) => {
            if (id === 'down') throw new Error('HTTP 503');
            return `**WDPA**\nCollection ID: \`${id}\``;
        },
    },
    query: async (sql) => {
        if (/fail/.test(sql)) throw new Error('Parser Error: syntax error');
        if (/many/.test(sql)) return Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({ i }));
        return [{ NAME: 'Oakland', h10: 622203768917753855n, n: 3 }];
    },
};

let consoleSpies, mcp, port1;
beforeEach(async () => {
    consoleSpies = ['log', 'warn', 'error'].map(m => vi.spyOn(console, m).mockImplementation(() => {}));
    const channel = new MessageChannel();
    port1 = channel.port1;
    await createServer(stubEngine).connect(new PostMessageTransport(channel.port2));
    mcp = new MCPClient('worker:test', {}, { transport: () => new PostMessageTransport(port1) });
    await mcp.connect();
});
afterEach(async () => {
    await mcp.disconnect();
    port1.close();
    consoleSpies.forEach(s => s.mockRestore());
});

describe('in-browser MCP server', () => {
    it("offers geo-query's discovery and query tools, and sends its instructions in the handshake", () => {
        expect(mcp.getTools().map(t => t.name)).toEqual(['browse_stac_catalog', 'get_stac_details', 'query']);
        expect(mcp.client.getInstructions()).toBe('No tables exist; read parquet by URL.');
    });

    it('browses the catalog and describes a collection', async () => {
        expect(await mcp.callTool('browse_stac_catalog', {})).toContain('- **wdpa**: **WDPA**');
        expect(await mcp.callTool('get_stac_details', { dataset_id: 'wdpa' })).toContain('Collection ID: `wdpa`');
    });

    it('reports a catalog that cannot be read', async () => {
        expect(await mcp.callTool('get_stac_details', { dataset_id: 'down' })).toBe('Error: could not read the STAC catalog: HTTP 503');
        expect(await mcp.callTool('get_stac_details', {})).toBe('Error: no dataset_id given');
    });

    it('returns query rows as a markdown table, with H3 ids in full', async () => {
        const out = await mcp.callTool('query', { sql_query: 'SELECT NAME FROM x' });
        expect(out).toContain('| NAME | h10 | n |');
        expect(out).toContain('| Oakland | 622203768917753855 | 3 |');
    });

    it('accepts the sql alias, as geo-query does', async () => {
        expect(await mcp.callTool('query', { sql: 'SELECT 1' })).toContain('Oakland');
    });

    it('reports a failed query as "SQL Error:", which glen-harness counts as a failure', async () => {
        const out = await mcp.callTool('query', { sql_query: 'fail' });
        expect(out).toBe('SQL Error: Parser Error: syntax error');
        expect(isFailedToolResult({ result: out })).toBe(true);
    });

    it('caps long results and says so', async () => {
        const out = await mcp.callTool('query', { sql_query: 'many' });
        expect(out.split('\n').filter(l => l.startsWith('| ')).length).toBe(MAX_ROWS + 2); // header, separator, rows
        expect(out).toContain(`(${MAX_ROWS + 5} rows; first ${MAX_ROWS} shown`);
    });
});
