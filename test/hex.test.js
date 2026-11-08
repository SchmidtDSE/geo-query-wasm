import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { PostMessageTransport } from '../src/transport.js';
import { createServer } from '../src/server.js';
import {
    tileBounds, edgePadding, hexEdgeRes, metresPerPixel, tilesCoveringBounds, zoomToH3Res, contentHash, parseTileUrl,
    tileUrlTemplate, pyramidSql, tileSql, propertiesSql, renderRecipe, suggestScale, createHexTiles,
    HANDOFF_NOTE, ROLLUP_NOTE,
} from '../src/hex.js';
import { hexFetch } from '../src/hex-protocol.js';

const CA = [-124.4, 32.5, -114.1, 42.0];

// Expected values come from geo-query's tiles/tile_math.py at 222cecf.
describe('tile math, as geo-query computes it', () => {
    it('gives tile bounds and seam padding', () => {
        const b = tileBounds(5, 5, 12);
        [-123.75, 31.952162238024968, -112.5, 40.97989806962013].forEach((v, i) => expect(b[i]).toBeCloseTo(v, 9));
        const [lat, lng] = edgePadding(7, 40);
        expect(lat).toBeCloseTo(0.010977379909168578, 12);
        expect(lng).toBeCloseTo(0.014329951751198368, 12);
    });

    it('picks the resolution for a zoom from the extent and cell count', () => {
        expect(tilesCoveringBounds(6, CA)).toBe(9);
        const res = [0, 4, 7, 10, 13].map(z => zoomToH3Res(z, { minRes: 2, finestRes: 8, featureCountFinest: 250000, bounds: CA }));
        expect(res).toEqual([6, 6, 8, 8, 8]);
        expect(zoomToH3Res(9, { minRes: 2, finestRes: 8 })).toBe(7);
    });

    it('uses the real cell counts when the data does not aggregate 7 to 1', () => {
        // A million scattered points: each level keeps most of its cells.
        const world = [-180, -60, 180, 70];
        const cellCounts = { 2: 4100, 3: 28000, 4: 190000, 5: 600000, 6: 950000, 7: 990000, 8: 999000 };
        const pick = (z, extra = {}) => zoomToH3Res(z, { minRes: 2, finestRes: 8, featureCountFinest: 999000, bounds: world, cellCounts, ...extra });
        expect(zoomToH3Res(0, { minRes: 2, finestRes: 8, featureCountFinest: 999000, bounds: world })).toBe(5);
        expect([0, 2, 3, 4].map(z => pick(z))).toEqual([2, 3, 4, 8]);
        expect(pick(0, { zoomOffset: 1 })).toBe(3);
        expect(pick(0, { cellCounts: { 2: 50000 } })).toBe(2);
    });

    it('hashes the registration as geo-query does, with its own layout version', async () => {
        const h = await contentHash({ sql: 'SELECT 1', finestRes: 8, minRes: 2, agg: 'COUNT', zoomOffset: 2 });
        expect(h).toMatch(/^[0-9a-f]{16}$/);
        // geo-query's layout version gives c101dfeaa0961f97 for these inputs.
        expect(h).not.toBe('c101dfeaa0961f97');
    });
});

describe('the pixel rule', () => {
    const SOCAL = [-119.5, 32.5, -114.1, 35.8];
    const counts = { 2: 6, 3: 16, 4: 72, 5: 407, 6: 2561, 7: 17194, 8: 118427, 9: 823799, 10: 5753032 };
    const pick = (z, extra = {}) => zoomToH3Res(z, { minRes: 2, finestRes: 10, featureCountFinest: 5753032, bounds: SOCAL, cellCounts: counts, ...extra });

    it('keeps hex edges at least 3 pixels long, where hexes look smallest', () => {
        expect(metresPerPixel(0, 0)).toBeCloseTo(78271.52, 1);
        // res 7 edges are 1.22 km, 2.4 px at zoom 7 and 32.5°N; res 6 edges are 6.4 px.
        expect([7, 10, 13].map(z => hexEdgeRes(z, SOCAL, 3))).toEqual([6, 8, 11]);
        // Bounds across the equator are measured there.
        expect(hexEdgeRes(7, [-10, -5, 10, 60], 3)).toBe(hexEdgeRes(7, [-10, 0, 10, 0], 3));
    });

    it('serves the coarser of the cell budget and the pixel rule', () => {
        // Measured on five southern California counties: the budget alone serves
        // res 7 and res 9, 17,500 and 32,600 hexes on a 1280x800 screen.
        expect([7, 10, 13].map(z => pick(z))).toEqual([7, 9, 10]);
        expect([7, 10, 13].map(z => pick(z, { minEdgePx: 3 }))).toEqual([6, 8, 10]);
        expect(pick(10, { minEdgePx: 3, zoomOffset: 1 })).toBe(9);
    });
});

describe('tile URLs', () => {
    it("use geo-query's paths under the geoquerywasm scheme", () => {
        const url = tileUrlTemplate('0123456789abcdef');
        expect(url).toBe('geoquerywasm://tiles/hex/0123456789abcdef/{z}/{x}/{y}.pbf');
        // The patterns glen's map client reads the hash and metadata URL with.
        expect(url.match(/\/tiles\/hex\/([^/]+)\//)[1]).toBe('0123456789abcdef');
        expect(url.replace(/^(.*\/tiles\/hex\/[^/]+\/)\{z\}\/\{x\}\/\{y\}\.pbf$/, '$1metadata.json'))
            .toBe('geoquerywasm://tiles/hex/0123456789abcdef/metadata.json');
    });

    it('parse into a tile or the metadata, and nothing else', () => {
        expect(parseTileUrl('geoquerywasm://tiles/hex/0123456789abcdef/6/10/24.pbf')).toEqual({ hash: '0123456789abcdef', z: 6, x: 10, y: 24 });
        expect(parseTileUrl('geoquerywasm://tiles/hex/0123456789abcdef/metadata.json')).toEqual({ hash: '0123456789abcdef', metadata: true });
        for (const bad of ['geoquerywasm://tiles/hex/xyz/1/2/3.pbf', 'https://x/tiles/hex/0123456789abcdef/1/2/3.pbf',
            'geoquerywasm://tiles/hex/0123456789abcdef/1/2/3.pbf/../x', "geoquerywasm://tiles/hex/0123456789abcdef'/1/2/3.pbf"]) {
            expect(parseTileUrl(bad)).toBeNull();
        }
    });
});

describe('pyramid and tile SQL', () => {
    const base = { sql: 'SELECT h8, v FROM t;', h3Column: 'h8', valueColumns: ['v'], finestRes: 8, minRes: 2 };

    it('aggregates each agg as geo-query rolls it up', () => {
        expect(pyramidSql({ ...base, agg: 'COUNT' })).toContain('COUNT(*) AS count FROM __src');
        expect(pyramidSql({ ...base, agg: 'COUNT' })).toContain('SUM(count) AS count');
        const avg = pyramidSql({ ...base, agg: 'avg' });
        expect(avg).toContain('AVG("v") AS "v", COUNT(*) AS __pyramid_weight');
        expect(avg).toContain('SUM("v" * __pyramid_weight) / SUM(__pyramid_weight) AS "v"');
        const cd = pyramidSql({ ...base, agg: 'COUNT_DISTINCT' });
        expect(cd).toContain('COUNT(DISTINCT "v") AS "v"');
        expect(cd).toContain('MAX("v") AS "v"');
        expect(avg).toContain('WHERE res > 2');
        expect(avg).toContain('SELECT CAST(8 AS INTEGER) AS res');
        expect(avg).not.toContain('FROM t;');
        expect(() => pyramidSql({ ...base, agg: 'MEDIAN' })).toThrow(/agg must be one of/);
        expect(() => pyramidSql({ ...base, valueColumns: [], agg: 'SUM' })).toThrow(/at least one value column/);
    });

    it('selects a tile by res and padded cell centres, and casts properties MVT cannot hold', () => {
        const columns = [
            { name: 'res', type: 'INTEGER' }, { name: 'h', type: 'UBIGINT' }, { name: '__lat', type: 'DOUBLE' },
            { name: '__lng', type: 'DOUBLE' }, { name: 'total', type: 'HUGEINT' }, { name: 'day', type: 'DATE' },
        ];
        expect(propertiesSql(columns)).toBe('src."res", CAST(src."total" AS DOUBLE) AS "total", CAST(src."day" AS VARCHAR) AS "day"');
        const sql = tileSql({ table: 'hex_0123456789abcdef', z: 5, x: 5, y: 12, res: 6, columns });
        expect(sql).toContain('FROM "hex_0123456789abcdef"');
        expect(sql).toContain('WHERE res = 6');
        expect(sql).toContain("ST_Transform(h3_cell_to_boundary_wkt(src.h)::GEOMETRY, 'EPSG:4326', 'EPSG:3857', true)");
        expect(tileSql({ table: 't', z: 2, x: 0, y: 1, res: 2, columns })).toContain('_c.crosses');
    });
});

describe('render recipe', () => {
    const meta = {
        finest_res: 8, value_columns: ['count'], layer_name: 'layer',
        value_stats: { count: { by_res: { 8: { min: 1, max: 100, mean: 2 } } } },
    };

    it('ramps viridis over the finest level, linear or log, flat or extruded', () => {
        const { source, layer } = renderRecipe(meta, 'u');
        expect(source).toEqual({ type: 'vector', tiles: ['u'], minzoom: 0, maxzoom: 14 });
        expect(layer.paint['fill-color'].slice(3, 6)).toEqual([1, '#440154', 20.8]);
        expect(layer.paint['fill-color'].at(-1)).toBe('#fde725');
        const log = renderRecipe(meta, 'u', 'log', 'fill-extrusion').layer;
        expect(log.type).toBe('fill-extrusion');
        expect(log.paint['fill-extrusion-color'][5]).toBeCloseTo(100 ** 0.2, 9);
        expect(log.paint['fill-extrusion-height'].at(-1)).toBe(50000);
        expect(suggestScale(meta.value_stats.count.by_res, 8)).toBe('log');
    });
});

// A stand-in engine that records SQL and answers the build's queries.
function stubEngine({ gate = Promise.resolve(), fail = null } = {}) {
    const log = [];
    return {
        log,
        arrow: async (sql, opts) => {
            log.push(['arrow', sql, opts]);
            if (sql.includes('LIMIT 0')) {
                if (sql.includes('bad')) throw new Error('Catalog Error: Table with name bad does not exist!');
                return { schema: { fields: sql.includes('richness') ? [{ name: 'h8' }, { name: 'h0' }, { name: 'specieskey' }] : [{ name: 'h8' }] } };
            }
            return { getChildAt: () => ({ get: () => (sql.includes('res = 2') ? null : new Uint8Array([26, 2, 1, 2])) }) };
        },
        json: async (sql, opts) => {
            log.push(['json', sql, opts]);
            if (sql.includes('h3_get_resolution')) return sql.includes('empty') ? [] : [{ r: 8 }];
            if (sql.includes('information_schema')) return [{ name: 'res', type: 'INTEGER' }, { name: 'h', type: 'UBIGINT' }, { name: '__lat', type: 'DOUBLE' }, { name: '__lng', type: 'DOUBLE' }, { name: 'count', type: 'HUGEINT' }];
            if (sql.includes('COUNT(*) AS ct')) return [{ w: -122.3, s: 37.4, e: -121.5, n: 37.9, ct: 5000 }];
            if (sql.includes('COUNT(*) AS n')) return [{ res: 7, n: 800 }, { res: 8, n: 5000 }];
            return [{ res: 7, min: 1, max: 40, mean: 7 }, { res: 8, min: 1, max: 10, mean: 1.5 }];
        },
        createTable: async (name, sql) => {
            log.push(['create', name, sql]);
            await gate;
            if (fail) throw new Error(fail);
            return 1;
        },
        dropTable: async (name, instance) => { log.push(['drop', name, instance]); },
    };
}

describe('tilesets', () => {
    it('builds, reports done with the recipe, and caches by hash', async () => {
        const engine = stubEngine();
        const hex = createHexTiles(engine);
        const out = await hex.register({ sql: 'SELECT h8 FROM gbif' });
        expect(out.status).toBe('done');
        expect(out.tile_url_template).toBe(tileUrlTemplate(out.hash));
        expect(out).toMatchObject({ finest_res: 8, min_res: 2, zoom_offset: 2, value_columns: ['count'], layer_name: 'layer',
            bounds: [-122.3, 37.4, -121.5, 37.9], feature_count_finest: 5000, next_step: HANDOFF_NOTE });
        expect(out.value_stats.count).toEqual({ by_res: { 7: { min: 1, max: 40, mean: 7 }, 8: { min: 1, max: 10, mean: 1.5 } }, suggested_scale: 'linear' });
        expect(out.cache_hit).toBeUndefined();
        expect(engine.log.find(l => l[0] === 'create')[1]).toBe(`hex_${out.hash}`);
        const again = await hex.register({ sql_query: 'SELECT h8 FROM gbif', color_scale: 'log' });
        expect(again).toMatchObject({ hash: out.hash, cache_hit: true, status: 'done' });
        expect(again.layer.paint['fill-color'][3]).toBe(1);
        expect(engine.log.filter(l => l[0] === 'create')).toHaveLength(1);
        expect(hex.metadata(out.hash)).toMatchObject({ agg: 'COUNT', feature_count_finest: 5000, cell_counts: { 7: 800, 8: 5000 } });
    });

    it('serves tiles from the instance that holds the table, and empty tiles as no bytes', async () => {
        const engine = stubEngine();
        const hex = createHexTiles(engine);
        const { hash } = await hex.register({ sql: 'SELECT h8 FROM gbif' });
        expect([...await hex.tile(hash, 10, 165, 396)]).toEqual([26, 2, 1, 2]);
        const call = engine.log.at(-1);
        expect(call[2]).toEqual({ instance: 1 });
        expect(call[1]).toContain('CAST(src."count" AS DOUBLE)');
        expect(await hex.tile('ffffffffffffffff', 1, 0, 0)).toBeNull();
        await expect(hex.tile(hash, 2, 4, 0)).rejects.toThrow(/no tile/);
    });

    it('answers running, then done, through a long poll', async () => {
        let open;
        const engine = stubEngine({ gate: new Promise(r => { open = r; }) });
        const hex = createHexTiles(engine, { inlineWaitSeconds: 0.05 });
        const first = await hex.register({ sql: 'SELECT h8 FROM gbif' });
        expect(first.status).toBe('running');
        expect(first.elapsed_seconds).toBeGreaterThanOrEqual(0);
        expect((await hex.status({ hash: first.hash })).status).toBe('running');
        setTimeout(open, 20);
        const done = await hex.status({ hash: first.hash, wait_seconds: 5, layer_style: 'fill-extrusion' });
        expect(done.status).toBe('done');
        expect(done.layer.type).toBe('fill-extrusion');
        expect(await hex.status({ hash: 'nope' })).toEqual({ hash: 'nope', tile_url_template: tileUrlTemplate('nope'), status: 'unknown' });
    });

    it('reports a failed build, and builds again when registered again', async () => {
        const engine = stubEngine({ fail: 'Out of Memory Error: could not allocate' });
        const hex = createHexTiles(engine);
        const out = await hex.register({ sql: 'SELECT h8 FROM gbif' });
        expect(out).toMatchObject({ status: 'failed', error: 'Out of Memory Error: could not allocate' });
        await hex.register({ sql: 'SELECT h8 FROM gbif' });
        expect(engine.log.filter(l => l[0] === 'create')).toHaveLength(2);
    });

    it('drops H3 key columns from the values, and rolls COUNT_DISTINCT up with a note', async () => {
        const hex = createHexTiles(stubEngine());
        const out = await hex.register({ sql: 'SELECT h8, h0, specieskey FROM richness', agg: 'COUNT_DISTINCT' });
        expect(out.value_columns).toEqual(['specieskey']);
        expect(out.rollup_note).toBe(ROLLUP_NOTE);
    });

    it('refuses what geo-query refuses', async () => {
        const hex = createHexTiles(stubEngine());
        expect(await hex.register({})).toMatchObject({ status: 'failed', error: expect.stringMatching(/^no query provided/) });
        await expect(hex.register({ sql: 'SELECT h8 FROM empty' })).rejects.toThrow(/Cannot auto-detect finest_res/);
        await expect(hex.register({ sql: 'SELECT h8 FROM t', agg: 'SUM' })).rejects.toThrow(/at least one value column/);
        await expect(hex.register({ sql: 'SELECT h8 FROM t', agg: 'median' })).rejects.toThrow(/agg must be one of/);
        await expect(hex.register({ sql: 'SELECT h8 FROM bad' })).rejects.toThrow(/does not exist/);
    });

    it('keeps at most maxTilesets, dropping the least recently used', async () => {
        const engine = stubEngine();
        const hex = createHexTiles(engine, { maxTilesets: 2 });
        const a = await hex.register({ sql: 'SELECT h8 FROM a' });
        await hex.register({ sql: 'SELECT h8 FROM b' });
        await new Promise(r => setTimeout(r, 5));
        await hex.tile(a.hash, 0, 0, 0); // a is now more recent than b
        const c = await hex.register({ sql: 'SELECT h8 FROM c' });
        const dropped = engine.log.filter(l => l[0] === 'drop').map(l => l[1]);
        expect(dropped).toHaveLength(1);
        expect(hex.metadata(a.hash)).not.toBeNull();
        expect(hex.metadata(c.hash)).not.toBeNull();
    });
});

describe('the hex tools over MCP', () => {
    let client, port1;
    afterEach(async () => { await client?.close(); port1?.close(); });

    it('offers both tools and serves tiles and metadata as resources', async () => {
        const channel = new MessageChannel();
        port1 = channel.port1;
        const hex = createHexTiles(stubEngine());
        const catalog = { discovery: true, browse: async () => '', details: async () => '', collection: async () => ({}) };
        await createServer({ catalog, hex, query: async () => [], json: async () => '[]' }).connect(new PostMessageTransport(channel.port2));
        client = new Client({ name: 'test', version: '0' });
        await client.connect(new PostMessageTransport(port1));

        const { tools } = await client.listTools();
        expect(tools.map(t => t.name)).toEqual(['browse_stac_catalog', 'get_stac_details', 'get_collection', 'query', 'register_hex_tiles', 'get_hex_tile_status']);
        const reg = tools.find(t => t.name === 'register_hex_tiles');
        expect(reg.description).toMatch(/^Aggregate an H3 hex visualization in the browser's memory/);
        expect(reg.description).toContain('COUNT_DISTINCT');

        const out = JSON.parse((await client.callTool({ name: 'register_hex_tiles', arguments: { sql: 'SELECT h8 FROM gbif' } })).content[0].text);
        expect(out.status).toBe('done');
        const status = JSON.parse((await client.callTool({ name: 'get_hex_tile_status', arguments: { hash: out.hash } })).content[0].text);
        expect(status.status).toBe('done');
        const bad = await client.callTool({ name: 'register_hex_tiles', arguments: { sql: 'SELECT h8 FROM empty' } });
        expect(bad.isError).toBe(true);
        expect(bad.content[0].text).toMatch(/^Error executing tool register_hex_tiles: Cannot auto-detect/);

        const { resourceTemplates } = await client.listResourceTemplates();
        expect(resourceTemplates.map(t => t.uriTemplate)).toContain('geoquerywasm://tiles/hex/{hash}/{z}/{x}/{y}.pbf');
        const tile = out.tile_url_template.replace('{z}/{x}/{y}', '10/165/396');
        const read = await client.readResource({ uri: tile });
        expect(read.contents[0]).toEqual({ uri: tile, mimeType: 'application/vnd.mapbox-vector-tile', blob: 'GgIBAg==' });

        // The page's fetch() for the metadata URL glen's map client derives.
        const fetchHex = hexFetch(client, async () => { throw new Error('not here'); });
        const meta = await (await fetchHex(out.tile_url_template.replace('{z}/{x}/{y}.pbf', 'metadata.json'))).json();
        expect(meta).toMatchObject({ finest_res: 8, value_columns: ['count'], feature_count_finest: 5000 });
        expect([...new Uint8Array(await (await fetchHex(tile)).arrayBuffer())]).toEqual([26, 2, 1, 2]);
        expect((await fetchHex('geoquerywasm://tiles/hex/ffffffffffffffff/metadata.json')).status).toBe(404);
    });
});
