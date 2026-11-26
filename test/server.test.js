import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { PostMessageTransport } from '../src/transport.js';
import { createServer, MAX_ROWS } from '../src/server.js';
import { TRUNCATED_NOTE } from '../src/format.js';

// The worker's server with a stub engine, reached as a page reaches it: an MCP
// client over postMessage. A MessageChannel stands in for page ↔ Worker.

const calls = [];
const stubEngine = () => ({
    instructions: 'App instructions.',
    guidance: { optim: 'OPTIM TEXT', h3: 'H3 TEXT', role: 'You are a geospatial analyst.' },
    query: async (sql, opts) => {
        calls.push({ sql, opts });
        if (/fail/.test(sql)) throw new Error('Parser Error: syntax error');
        if (/many/.test(sql)) return Array.from({ length: opts.limit }, (_, i) => ({ i }));
        if (/none/.test(sql)) return [];
        return [{ NAME: 'Oakland', h10: 622203768917753855n, x: 26471500.123456, n: 3, z: null }];
    },
    json: async (sql, opts) => {
        calls.push({ sql, opts });
        if (/fail/.test(sql)) throw new Error('Parser Error: syntax error');
        return '[{"NAME":"a|b\\nc","n":3}]';
    },
});

let client, port1;
async function connect(engine = stubEngine()) {
    const channel = new MessageChannel();
    port1 = channel.port1;
    await createServer(engine).connect(new PostMessageTransport(channel.port2));
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new PostMessageTransport(port1));
}
afterEach(async () => {
    await client?.close();
    port1?.close();
    calls.length = 0;
});

const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;

describe("geo-query's tools in the browser", () => {
    it("offers geo-query's tools, with no STAC tools, and the app's instructions in the handshake", async () => {
        await connect();
        const { tools } = await client.listTools();
        expect(tools.map(t => t.name)).toEqual(['query']);
        expect(await call('get_stac_details', { dataset_id: 'wdpa' })).toBe('Unknown tool: get_stac_details');
        expect(client.getServerVersion().name).toBe('geo-query-wasm');
        expect(client.getInstructions()).toBe('App instructions.');
    });

    it("puts geo-query's guidance in the query description", async () => {
        await connect();
        const q = (await client.listTools()).tools.find(t => t.name === 'query');
        expect(q.description).toContain('NO TABLES EXIST');
        expect(q.description).toContain('OPTIM TEXT');
        expect(q.description).toContain('H3 TEXT');
        expect(q.description).toContain("1. Get the dataset's read_parquet() paths and column names from its STAC metadata (your catalog tool");
        expect(q.description).toContain('Published https:// paths work as-is.');
        expect(q.description).not.toContain('Call `browse_stac_catalog`');
        expect(q.description).toContain('RUNS IN THE USER\'S BROWSER');
        expect(Object.keys(q.inputSchema.properties)).toEqual(expect.arrayContaining(['sql_query', 's3_endpoint', 's3_scope', 's3_region', 's3_url_style', 'sql']));
        // Keys never come from the model, so the schema does not offer them.
        expect(Object.keys(q.inputSchema.properties)).not.toContain('s3_key');
        expect(Object.keys(q.inputSchema.properties)).not.toContain('s3_secret');
        expect(q.description).not.toMatch(/pass s3_key, s3_secret/);
    });

    it('serves the analyst prompt, and no catalog resources', async () => {
        await connect();
        expect((await client.listResources()).resources).toEqual([]);
        expect((await client.listResourceTemplates()).resourceTemplates).toEqual([]);
        await expect(client.readResource({ uri: 'catalog://wdpa' })).rejects.toThrow(/Unknown resource/);
        expect((await client.listPrompts()).prompts.map(p => p.name)).toEqual(['geospatial-analyst']);
        expect((await client.getPrompt({ name: 'geospatial-analyst' })).messages[0].content.text).toBe('You are a geospatial analyst.');
    });

    it("prints rows as geo-query does: H3 ids in full, floats to 10 figures, NULL blank", async () => {
        await connect();
        const out = await call('query', { sql_query: 'SELECT NAME FROM x' });
        expect(out).toContain('| NAME | h10 | x | n | z |');
        expect(out).toContain('| Oakland | 622203768917753855 | 26471500.12 | 3 |  |');
        expect(calls[0].opts).toEqual({ limit: MAX_ROWS + 1 });
        expect(await call('query', { sql_query: 'none' })).toBe('No results found.');
    });

    it('accepts the sql alias, and says when no SQL is given', async () => {
        await connect();
        expect(await call('query', { sql: 'SELECT 1' })).toContain('Oakland');
        expect(await call('query', {})).toBe('SQL Error: no query provided — pass the SQL as `sql_query` (the alias `sql` is also accepted).');
    });

    it('passes per-query S3 arguments to the engine, keys included so the engine can refuse them', async () => {
        await connect();
        await call('query', { sql_query: 'SELECT 1', s3_key: 'k', s3_secret: 's', s3_endpoint: 'minio.example', s3_scope: 's3://private-x' });
        expect(calls[0].opts.s3).toEqual({ key: 'k', secret: 's', endpoint: 'minio.example', scope: 's3://private-x', region: undefined, url_style: undefined });
    });

    it('reports a failed query as "SQL Error:"', async () => {
        await connect();
        expect(await call('query', { sql_query: 'fail' })).toBe('SQL Error: Parser Error: syntax error');
    });

    it("caps long results at 50 rows with geo-query's note", async () => {
        await connect();
        const out = await call('query', { sql_query: 'many' });
        expect(out.split('\n').filter(l => l.startsWith('| ')).length).toBe(MAX_ROWS + 2); // header, separator, rows
        expect(out.endsWith(TRUNCATED_NOTE)).toBe(true);
    });

    it('returns every row as JSON text when asked, with cells unescaped', async () => {
        await connect();
        expect(JSON.parse(await call('query', { sql_query: 'SELECT 1', format: 'json' }))).toEqual([{ NAME: 'a|b\nc', n: 3 }]);
        expect(await call('query', { sql_query: 'fail', format: 'json' })).toBe('SQL Error: Parser Error: syntax error');
        expect(await call('query', { sql_query: 'SELECT 1', format: 'csv' })).toBe('SQL Error: unknown format csv');
    });
});
