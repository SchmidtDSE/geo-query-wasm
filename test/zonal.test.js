import { describe, it, expect } from 'vitest';
import {
    coverage, windowOf, summarize, chooseLevel, rasterCrs, sameCrs, cogUrl, zonesSql,
    zonalStats, createZonalStats, MAX_ZONES,
} from '../src/zonal.js';
import { ALLOWED_DIRECTORIES } from '../src/defaults.js';
import { markdownTable } from '../src/format.js';

const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const sum = (a) => a.reduce((s, v) => s + v, 0);

describe('the pixel rule', () => {
    it('counts a pixel whose centre is inside', () => {
        const cov = coverage([square(1, 1, 3, 3)], 0, 0, 4, 4);
        expect([...cov]).toEqual([0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0]);
    });

    it('leaves out a pixel whose centre is outside, however much of it is covered', () => {
        expect(sum([...coverage([square(0, 0, 0.49, 1)], 0, 0, 1, 1)])).toBe(0);
        expect(sum([...coverage([square(0, 0, 0.51, 1)], 0, 0, 1, 1)])).toBe(1);
    });

    it('weights a pixel by its covered share with area sampling', () => {
        const cov = coverage([square(0, 0, 0.5, 1)], 0, 0, 1, 1, 8);
        expect(cov[0]).toBeCloseTo(0.5, 6);
        const tri = coverage([[[0, 0], [1, 0], [0, 1], [0, 0]]], 0, 0, 1, 1, 8);
        expect(tri[0]).toBeGreaterThan(0.4);
        expect(tri[0]).toBeLessThan(0.6);
    });

    it('cuts holes and joins the parts of a multipolygon', () => {
        const donut = coverage([square(0, 0, 3, 3), square(1, 1, 2, 2)], 0, 0, 3, 3);
        expect(sum([...donut])).toBe(8);
        expect(donut[4]).toBe(0);
        const two = coverage([square(0, 0, 1, 1), square(2, 2, 3, 3)], 0, 0, 3, 3);
        expect(sum([...two])).toBe(2);
    });

    it('works in a window that starts inside the image', () => {
        const cov = coverage([square(10, 20, 12, 21)], 10, 20, 2, 1);
        expect([...cov]).toEqual([1, 1]);
    });
});

describe('windows and statistics', () => {
    it('gives the pixel window a zone touches, clipped to the image', () => {
        expect(windowOf([square(1.2, 1.5, 3.1, 2.9)], 10, 10)).toEqual([1, 1, 4, 3]);
        expect(windowOf([square(-5, -5, 2, 2)], 10, 10)).toEqual([0, 0, 2, 2]);
        expect(windowOf([square(20, 20, 30, 30)], 10, 10)).toBeNull();
    });

    it('skips nodata and NaN', () => {
        const s = summarize([1, 2, -9, NaN, 5], new Float32Array([1, 1, 1, 1, 0]), -9, true);
        expect(s).toMatchObject({ sum: 3, count: 2, min: 1, max: 2 });
        expect([...s.counts]).toEqual([[1, 1], [2, 1]]);
        expect(summarize([1], new Float32Array([0]), null, false)).toMatchObject({ count: 0, min: null, max: null });
    });

    it('chooses the finest level that fits the cap', () => {
        const levels = [{ n: 100 }, { n: 25 }, { n: 4 }];
        const windows = lv => [[0, 0, lv.n, 1]];
        expect(chooseLevel(levels, windows, 100).index).toBe(0);
        expect(chooseLevel(levels, windows, 30).index).toBe(1);
        expect(chooseLevel(levels, windows, 3)).toBeNull();
    });
});

describe('paths, coordinate systems and SQL', () => {
    it('reads the CRS from GeoKeys, unless it is user-defined', () => {
        expect(rasterCrs({ GeographicTypeGeoKey: 4326 })).toBe('EPSG:4326');
        expect(rasterCrs({ ProjectedCSTypeGeoKey: 5070, GeographicTypeGeoKey: 4269 })).toBe('EPSG:5070');
        expect(rasterCrs({ ProjectedCSTypeGeoKey: 32767 })).toBeNull();
        expect(sameCrs('OGC:CRS84', 'epsg:4326')).toBe(true);
        expect(sameCrs('EPSG:5070', 'EPSG:4326')).toBe(false);
    });

    it('takes COG paths SQL may read, as https', () => {
        expect(cogUrl('s3://us-west-2.opendata.source.coop/cboettig/x.tif', ALLOWED_DIRECTORIES))
            .toEqual({ url: 'https://data.source.coop/cboettig/x.tif' });
        expect(cogUrl('s3://public-x/y.tif', ALLOWED_DIRECTORIES)).toEqual({ url: 'https://s3-west.nrp-nautilus.io/public-x/y.tif' });
        expect(cogUrl('https://data.source.coop/a/b.tif', ALLOWED_DIRECTORIES)).toEqual({ url: 'https://data.source.coop/a/b.tif' });
        expect(cogUrl('https://example.org/b.tif', ALLOWED_DIRECTORIES).error).toMatch(/outside the allowed directories/);
        expect(cogUrl('https://data.source.coop.example.org/b.tif', ALLOWED_DIRECTORIES).error).toMatch(/outside/);
        expect(cogUrl('file:///etc/passwd', ALLOWED_DIRECTORIES).error).toMatch(/https:\/\/ or s3:\/\//);
        expect(cogUrl('s3://public-x/y.tif', ['https://data.source.coop/']).error).toMatch(/outside/);
    });

    it('wraps the zones SQL, reprojecting only when the CRS differs', () => {
        const same = zonesSql('SELECT name AS id, geometry FROM t;', 'EPSG:4326', 'OGC:CRS84');
        expect(same).toBe('SELECT CAST(id AS VARCHAR) AS id, ST_AsGeoJSON(geometry::GEOMETRY) AS geojson FROM (\nSELECT name AS id, geometry FROM t\n) AS zones');
        const other = zonesSql('SELECT 1 -- note', 'EPSG:4326', "ESRI:'x");
        expect(other).toContain("ST_Transform(geometry::GEOMETRY, 'EPSG:4326', 'ESRI:''x', always_xy := true)");
        expect(other).toContain('-- note\n) AS zones');
    });
});

// A 4 × 4 raster with a 2 × 2 overview, as geotiff.js presents a COG. Pixel
// (i, j) of the base holds 10 * j + i; the overview averages 2 × 2 blocks.
function fakeTiff({ nodata = null } = {}) {
    const base = Array.from({ length: 16 }, (_, k) => 10 * Math.floor(k / 4) + (k % 4));
    const over = [0, 1, 2, 3].map(k => {
        const i = (k % 2) * 2; const j = Math.floor(k / 2) * 2;
        return (base[j * 4 + i] + base[j * 4 + i + 1] + base[(j + 1) * 4 + i] + base[(j + 1) * 4 + i + 1]) / 4;
    });
    const image = (w, data) => ({
        getWidth: () => w,
        getHeight: () => w,
        getSamplesPerPixel: () => 1,
        getOrigin: () => [100, 50],
        getResolution: () => [1, -1],
        getGDALNoData: () => nodata,
        getGeoKeys: () => ({ GeographicTypeGeoKey: 4326 }),
        readRasters: async ({ window: [x0, y0, x1, y1] }) => {
            const out = [];
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out.push(data[y * w + x]);
            return [out];
        },
    });
    const images = [image(4, base), image(2, over)];
    return { getImageCount: async () => 2, getImage: async i => images[i] };
}

// Map coordinates: x from 100 to 104, y from 50 down to 46.
const zone = (id, x0, y0, x1, y1) => ({ id, geometry: { type: 'Polygon', coordinates: [square(x0, y0, x1, y1)] } });

describe('zonalStats', () => {
    it('sums the pixels whose centres fall in each zone', async () => {
        const out = await zonalStats(fakeTiff(), [zone('top-left', 100, 50, 102, 48), zone('all', 100, 50, 104, 46)],
            { stats: ['sum', 'mean', 'min', 'max', 'count'] });
        expect(out.level).toBe(0);
        expect(out.rows[0]).toEqual({ id: 'top-left', sum: 0 + 1 + 10 + 11, mean: 5.5, min: 0, max: 11, count: 4 });
        expect(out.rows[1]).toMatchObject({ sum: 4 * (0 + 10 + 20 + 30) + 4 * 6, count: 16 });
        expect(out.notes).toEqual([]);
    });

    it('reads an overview past the cap, scales sums and counts, and says so', async () => {
        const out = await zonalStats(fakeTiff(), [zone('all', 100, 50, 104, 46)], { stats: ['sum', 'count'], maxPixels: 4 });
        expect(out.level).toBe(1);
        expect(out.rows[0]).toEqual({ id: 'all', sum: 264, count: 16 });
        expect(out.notes[0]).toMatch(/^Read at overview 1 \(2 × 2 pixels, 2× coarser/);
        await expect(zonalStats(fakeTiff(), [zone('all', 100, 50, 104, 46)], { maxPixels: 3 }))
            .rejects.toThrow(/cover 4 pixels even on the coarsest overview, more than the 3/);
    });

    it('counts classes, skips nodata, and keeps zones that are not polygons', async () => {
        const out = await zonalStats(fakeTiff({ nodata: 1 }), [
            zone('a', 100, 50, 102, 49),
            { id: 'line', geometry: { type: 'LineString', coordinates: [[100, 50], [101, 49]] } },
        ], { stats: ['classes'] });
        expect(out.rows).toEqual([{ id: 'a', value: 0, count: 1 }, { id: 'line', value: null, count: null }]);
        expect(out.notes[0]).toMatch(/1 zone\(s\) are not polygons/);
    });

    it('gives a zone outside the raster empty statistics', async () => {
        const out = await zonalStats(fakeTiff(), [zone('far', 0, 0, 1, 1)], { stats: ['sum', 'mean', 'count'] });
        expect(out.rows[0]).toEqual({ id: 'far', sum: 0, mean: null, count: 0 });
    });
});

describe('the zonal_stats tool', () => {
    const tool = (overrides = {}) => {
        const calls = [];
        const run = createZonalStats({
            open: async () => fakeTiff(),
            query: async (sql, opts) => {
                calls.push({ sql, opts });
                return [{ id: 'top-left', geojson: JSON.stringify(zone('x', 100, 50, 102, 48).geometry) }];
            },
            allowed: ALLOWED_DIRECTORIES,
            catalog: null,
            format: markdownTable,
            ...overrides,
        });
        return { run, calls };
    };
    const args = { cog_url: 's3://us-west-2.opendata.source.coop/x/y.tif', zones_sql: 'SELECT name AS id, geometry FROM t' };

    it('reads the zones through the locked engine and renders a table', async () => {
        const { run, calls } = tool();
        const out = await run(args);
        expect(out).toContain('| id | sum | mean | count |');
        expect(out).toContain('| top-left | 22 | 5.5 | 4 |');
        expect(out).toContain('Pixel rule: pixels whose centre is inside each zone. Raster CRS: EPSG:4326.');
        expect(calls[0].opts).toEqual({ limit: MAX_ZONES + 1 });
        expect(calls[0].sql).not.toContain('ST_Transform');
        expect(JSON.parse(await run({ ...args, format: 'json' }))).toEqual([{ id: 'top-left', sum: 22, mean: 5.5, count: 4 }]);
    });

    it('declines a COG whose collection has a hex copy, naming it', async () => {
        const catalog = {
            assetFor: async () => ({ collection: 'ghs-pop-2020', asset: 'cog', crs: null, hex: [{ key: 'ghs-pop-2020-hex', path: 's3://b/hex/**' }] }),
        };
        const out = await tool({ catalog }).run(args);
        expect(out).toMatch(/^Declined: ghs-pop-2020 has an H3 hex copy of this raster, asset `ghs-pop-2020-hex`: `read_parquet\('s3:\/\/b\/hex\/\*\*'\)`/);
    });

    it('refuses bad arguments before reading anything', async () => {
        const { run, calls } = tool({ open: async () => { throw new Error('should not open'); } });
        expect(await run({ ...args, cog_url: 'https://example.org/y.tif' })).toMatch(/^Error: cog_url is outside the allowed directories/);
        expect(await run({ ...args, stats: ['classes', 'sum'] })).toBe('Error: "classes" cannot be combined with other stats');
        expect(await run({ ...args, stats: ['median'] })).toMatch(/^Error: stats must be a list of/);
        expect(await run({ ...args, zones_sql: ' ' })).toBe('Error: no zones_sql given');
        expect(await run({ ...args, pixel_rule: 'touch' })).toMatch(/^Error: pixel_rule/);
        expect(calls).toHaveLength(0);
    });

    it('explains a zones query that fails', async () => {
        const out = await tool({ query: async () => { throw new Error('Binder Error: column "id" not found'); } }).run(args);
        expect(out).toMatch(/^SQL Error: Binder Error.*\n\nzones_sql must be one SELECT returning columns `id` and `geometry`\.$/s);
    });
});
