import { describe, it, expect } from 'vitest';
import {
    coverage, windowOf, summarize, chooseLevel, rasterCrs, sameCrs, cogUrl, zonesSql,
    zonalStats, createZonalStats, MAX_ZONES, binOf, binBounds, checkBreaks, MAX_BREAKS,
    exactCoverage, ringArea, polygonParts, pixelAreaM2,
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

describe('the exact pixel rule', () => {
    const reverse = (ring) => [...ring].reverse();
    // A seeded generator, so the random polygons are the same on every run.
    const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    // A star-shaped polygon around (cx, cy): concave, with edges at every angle.
    const star = (rand, cx, cy, r, n) => {
        const ring = Array.from({ length: n }, (_, k) => {
            const t = (2 * Math.PI * k) / n;
            const rr = r * (0.3 + 0.7 * rand());
            return [cx + rr * Math.cos(t), cy + rr * Math.sin(t)];
        });
        return [...ring, ring[0]];
    };

    it('gives a pixel the area of its square inside the zone', () => {
        expect(exactCoverage([[square(0, 0, 0.5, 1)]], 0, 0, 1, 1)[0]).toBeCloseTo(0.5, 12);
        expect(exactCoverage([[[[0, 0], [1, 0], [0, 1], [0, 0]]]], 0, 0, 1, 1)[0]).toBeCloseTo(0.5, 12);
        expect(exactCoverage([[square(0.2, 0.3, 0.7, 0.4)]], 0, 0, 1, 1)[0]).toBeCloseTo(0.05, 12);
        // A pixel the zone only touches gets nothing, unlike under the area rule's samples.
        expect([...exactCoverage([[square(0, 0, 1, 1)]], 0, 0, 2, 1)]).toEqual([1, 0]);
    });

    it('splits a diagonal edge between the pixels it crosses', () => {
        // The diamond with corners at the middles of a 2 × 2 block's sides covers half of each pixel.
        const diamond = [[1, 0], [2, 1], [1, 2], [0, 1], [1, 0]];
        expect([...exactCoverage([[diamond]], 0, 0, 2, 2)].map(c => Math.round(c * 1e12) / 1e12)).toEqual([0.5, 0.5, 0.5, 0.5]);
    });

    it('sums to the polygon\'s area, whichever way its rings run', () => {
        const rand = rng(7);
        for (let k = 0; k < 20; k++) {
            const ring = star(rand, 10 + 5 * rand(), 10 + 5 * rand(), 3 + 4 * rand(), 5 + Math.floor(20 * rand()));
            const area = Math.abs(ringArea(ring));
            expect(sum([...exactCoverage([[ring]], 0, 0, 30, 30)])).toBeCloseTo(area, 9);
            expect(sum([...exactCoverage([[reverse(ring)]], 0, 0, 30, 30)])).toBeCloseTo(area, 9);
        }
    });

    it('matches dense point sampling pixel by pixel', () => {
        const rand = rng(11);
        const ring = star(rand, 4, 4, 3.5, 40);
        const exact = exactCoverage([[ring]], 0, 0, 8, 8);
        const sampled = coverage([ring], 0, 0, 8, 8, 400);
        for (let i = 0; i < 64; i++) expect(Math.abs(exact[i] - sampled[i])).toBeLessThan(0.01);
    });

    it('cuts holes and joins multipolygon parts, whichever way the rings run', () => {
        const hole = square(1.25, 1.25, 1.75, 1.75);
        for (const outer of [square(0, 0, 3, 3), reverse(square(0, 0, 3, 3))]) {
            for (const inner of [hole, reverse(hole)]) {
                const cov = exactCoverage([[outer, inner]], 0, 0, 3, 3);
                expect(cov[4]).toBeCloseTo(0.75, 12);
                expect(sum([...cov])).toBeCloseTo(8.75, 12);
            }
        }
        const two = exactCoverage(polygonParts({
            type: 'MultiPolygon', coordinates: [[square(0, 0, 0.5, 1)], [reverse(square(2.5, 2, 3, 3))]],
        }), 0, 0, 3, 3);
        expect(two[0]).toBeCloseTo(0.5, 12);
        expect(two[8]).toBeCloseTo(0.5, 12);
        expect(sum([...two])).toBeCloseTo(1, 12);
    });

    it('caps a pixel at 1 where multipolygon parts overlap', () => {
        const cov = exactCoverage([[square(0, 0, 1, 1)], [square(0, 0, 1, 1)]], 0, 0, 1, 1);
        expect(cov[0]).toBe(1);
    });

    it('gives a window the same shares as the whole image, for zones that run past its edges', () => {
        const rand = rng(3);
        const ring = star(rand, 6, 6, 5.5, 30);
        const whole = exactCoverage([[ring]], 0, 0, 12, 12);
        const part = exactCoverage([[ring]], 3, 4, 5, 6);
        for (let j = 0; j < 6; j++) {
            for (let i = 0; i < 5; i++) expect(part[j * 5 + i]).toBeCloseTo(whole[(j + 4) * 12 + (i + 3)], 12);
        }
    });

    it('lists a geometry\'s polygons with their rings', () => {
        expect(polygonParts({ type: 'Polygon', coordinates: [[1], [2]] })).toEqual([[[1], [2]]]);
        expect(polygonParts({ type: 'MultiPolygon', coordinates: [[[1]], [[2]]] })).toEqual([[[1]], [[2]]]);
        expect(polygonParts({ type: 'Point', coordinates: [0, 0] })).toBeNull();
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

    it('puts a value in its histogram bin, lower bound included', () => {
        const breaks = [0, 0.5, 1];
        expect([-1, 0, 0.25, 0.5, 0.99, 1, 7].map(v => binOf(v, breaks))).toEqual([0, 1, 1, 2, 2, 3, 3]);
        expect(binBounds([0.5])).toEqual([{ lower: null, upper: 0.5 }, { lower: 0.5, upper: null }]);
    });

    it('accumulates histogram bins by coverage, skipping nodata and NaN', () => {
        const s = summarize([0.1, 0.6, 0.7, -9, NaN, 0.9], new Float32Array([1, 0.5, 1, 1, 1, 0]), -9, false, [0.5]);
        expect([...s.bins]).toEqual([1, 1.5]);
        expect(summarize([1], new Float32Array([1]), null, false).bins).toBeNull();
    });

    it('accepts only finite, strictly increasing breaks', () => {
        expect(checkBreaks([0.5])).toBeNull();
        expect(checkBreaks([-0.1, 0, 0.27, 0.66])).toBeNull();
        expect(checkBreaks(undefined)).toMatch(/needs breaks/);
        expect(checkBreaks([])).toMatch(/needs breaks/);
        expect(checkBreaks([1, 1])).toMatch(/strictly increasing/);
        expect(checkBreaks([2, 1])).toMatch(/strictly increasing/);
        expect(checkBreaks([0, '1'])).toMatch(/finite numbers/);
        expect(checkBreaks([0, Infinity])).toMatch(/finite numbers/);
        expect(checkBreaks(Array.from({ length: MAX_BREAKS + 1 }, (_, k) => k))).toMatch(/at most/);
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
function fakeTiff({ nodata = null, geoKeys = { GeographicTypeGeoKey: 4326 } } = {}) {
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
        getGeoKeys: () => geoKeys,
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

    it('counts pixels in histogram bins, including empty bins and zones that are not polygons', async () => {
        // Pixel values are 10 * row + column, rows 0 to 3.
        const out = await zonalStats(fakeTiff(), [
            zone('all', 100, 50, 104, 46),
            { id: 'line', geometry: { type: 'LineString', coordinates: [[100, 50], [101, 49]] } },
        ], { stats: ['histogram'], breaks: [10, 30, 100] });
        expect(out.rows).toEqual([
            { id: 'all', lower: null, upper: 10, count: 4, sum: 6, mean: 1.5 },
            { id: 'all', lower: 10, upper: 30, count: 8, sum: 132, mean: 16.5 },
            { id: 'all', lower: 30, upper: 100, count: 4, sum: 126, mean: 31.5 },
            { id: 'all', lower: 100, upper: null, count: 0, sum: 0, mean: null },
            { id: 'line', lower: null, upper: 10, count: null, sum: null, mean: null },
            { id: 'line', lower: 10, upper: 30, count: null, sum: null, mean: null },
            { id: 'line', lower: 30, upper: 100, count: null, sum: null, mean: null },
            { id: 'line', lower: 100, upper: null, count: null, sum: null, mean: null },
        ]);
    });

    it('weights histogram bins by covered share under the area rule', async () => {
        // Pixel (0, 0), value 0, is covered whole; pixel (1, 0), value 1, half, with its centre on the edge.
        const z = [zone('half', 100, 50, 101.5, 49)];
        const centre = await zonalStats(fakeTiff(), z, { stats: ['histogram'], breaks: [1] });
        expect(centre.rows.map(r => r.count)).toEqual([1, 0]);
        const area = await zonalStats(fakeTiff(), z, { stats: ['histogram'], breaks: [1], pixelRule: 'area' });
        expect(area.rows.map(r => r.count)).toEqual([1, 0.5]);
    });

    it('weights histogram bins by the exact covered share under the exact rule', async () => {
        // A triangle over pixels (0, 0) and (1, 0), values 0 and 1, with its long edge from map (101.7, 50) to
        // (100, 49). Of its 0.85 pixels, 0.245 / 1.7 lie in pixel (1, 0) and the rest in pixel (0, 0). Sampling
        // 64 points gives 0.71875 and 0.140625; the exact rule gives the areas.
        const tri = { id: 'tri', geometry: { type: 'Polygon', coordinates: [[[100, 50], [101.7, 50], [100, 49], [100, 50]]] } };
        const exact = await zonalStats(fakeTiff(), [tri], { stats: ['histogram'], breaks: [1], pixelRule: 'exact' });
        expect(exact.rows).toEqual([
            { id: 'tri', lower: null, upper: 1, count: 0.705882, sum: 0, mean: 0 },
            { id: 'tri', lower: 1, upper: null, count: 0.144118, sum: 0.144118, mean: 1 },
        ]);
        const area = await zonalStats(fakeTiff(), [tri], { stats: ['histogram'], breaks: [1], pixelRule: 'area' });
        expect(area.rows.map(r => r.count)).toEqual([0.71875, 0.140625]);
    });

    it('gives the mean of the values in each bin, weighted by coverage', async () => {
        // Pixels (2, 0) and (3, 0), values 2 and 3, covered whole and half.
        const out = await zonalStats(fakeTiff(), [zone('z', 102, 50, 103.5, 49)],
            { stats: ['histogram'], breaks: [2], pixelRule: 'exact' });
        expect(out.rows[1]).toEqual({ id: 'z', lower: 2, upper: null, count: 1.5, sum: 3.5, mean: 2.333333 });
    });

    it('agrees with the whole-pixel rules where a zone follows pixel edges', async () => {
        const z = [zone('top-left', 100, 50, 102, 48)];
        const centre = await zonalStats(fakeTiff(), z, { stats: ['sum', 'mean', 'count'] });
        const exact = await zonalStats(fakeTiff(), z, { stats: ['sum', 'mean', 'count'], pixelRule: 'exact' });
        expect(exact.rows).toEqual(centre.rows);
    });

    it('cuts holes and joins multipolygon parts under the exact rule', async () => {
        // The whole raster less a 1 × 1 hole over pixel (1, 1), value 11; plus nothing else.
        const donut = {
            id: 'donut',
            geometry: { type: 'Polygon', coordinates: [square(100, 50, 104, 46), square(101, 49, 102, 48)] },
        };
        const two = {
            id: 'two',
            geometry: { type: 'MultiPolygon', coordinates: [[square(100, 50, 100.5, 49)], [square(103, 47, 104, 46.5)]] },
        };
        const out = await zonalStats(fakeTiff(), [donut, two], { stats: ['sum', 'count'], pixelRule: 'exact' });
        expect(out.rows[0]).toEqual({ id: 'donut', sum: 264 - 11, count: 15 });
        // Half of pixel (0, 0), value 0, and half of pixel (3, 3), value 33.
        expect(out.rows[1]).toEqual({ id: 'two', sum: 16.5, count: 1 });
    });

    it('scales histogram counts read from an overview', async () => {
        // Overview values are 5.5, 7.5, 25.5 and 27.5, each standing for 4 pixels.
        const out = await zonalStats(fakeTiff(), [zone('all', 100, 50, 104, 46)], { stats: ['histogram'], breaks: [10, 30], maxPixels: 4 });
        expect(out.level).toBe(1);
        expect(out.rows.map(r => r.count)).toEqual([8, 8, 0]);
    });

    it('refuses a histogram without usable breaks', async () => {
        await expect(zonalStats(fakeTiff(), [zone('all', 100, 50, 104, 46)], { stats: ['histogram'] }))
            .rejects.toThrow(/needs breaks/);
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
            open: async () => fakeTiff(overrides.tiff),
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
        expect(await run({ ...args, stats: ['histogram', 'sum'], breaks: [1] })).toBe('Error: "histogram" cannot be combined with other stats');
        expect(await run({ ...args, stats: ['histogram'] })).toMatch(/^Error: "histogram" needs breaks/);
        expect(await run({ ...args, stats: ['histogram'], breaks: [1, 0] })).toBe('Error: breaks must be strictly increasing');
        expect(calls).toHaveLength(0);
    });

    it('renders a histogram as one row per bin', async () => {
        const { run } = tool();
        const out = await run({ ...args, stats: ['histogram'], breaks: [10] });
        expect(out).toContain('| id | lower | upper | count |');
        expect(JSON.parse(await run({ ...args, stats: ['histogram'], breaks: [10], format: 'json' }))).toEqual([
            { id: 'top-left', lower: null, upper: 10, count: 2, sum: 1, mean: 0.5 },
            { id: 'top-left', lower: 10, upper: null, count: 2, sum: 21, mean: 10.5 },
        ]);
    });

    it('takes the exact pixel rule and says so', async () => {
        const out = await tool().run({ ...args, pixel_rule: 'exact' });
        expect(out).toContain('| top-left | 22 | 5.5 | 4 |');
        expect(out).toContain('Pixel rule: pixels weighted by the exact share inside each zone, as exactextract.');
        expect(await tool().run({ ...args, pixel_rule: 'touch' })).toBe('Error: pixel_rule must be "centre", "area" or "exact"');
    });

    it('explains a zones query that fails', async () => {
        const out = await tool({ query: async () => { throw new Error('Binder Error: column "id" not found'); } }).run(args);
        expect(out).toMatch(/^SQL Error: Binder Error.*\n\nzones_sql must be one SELECT returning columns `id` and `geometry`\.$/s);
    });
});

describe('hectares beside counts', () => {
    const utm = { ProjectedCSTypeGeoKey: 32611 };

    it('knows a pixel area only for CRSs in true ground metres', () => {
        expect(pixelAreaM2({ ProjectedCSTypeGeoKey: 32611 }, [20, -20])).toBe(400);
        expect(pixelAreaM2({ ProjectedCSTypeGeoKey: 26911 }, [30, -30])).toBe(900);
        expect(pixelAreaM2({ ProjectedCSTypeGeoKey: 5070 }, [30, -30])).toBe(900);
        expect(pixelAreaM2({ ProjectedCSTypeGeoKey: 3857 }, [20, -20])).toBeNull();
        expect(pixelAreaM2({ GeographicTypeGeoKey: 4326 }, [0.001, -0.001])).toBeNull();
        expect(pixelAreaM2({}, [20, -20])).toBeNull();
    });

    it('adds hectares to histogram, classes and count rows for a UTM raster', async () => {
        // The fake's pixels are 1 × 1, so a hectare is 10,000 pixels.
        const z = [zone('z', 102, 50, 103.5, 49)];
        const hist = await zonalStats(fakeTiff({ geoKeys: utm }), z, { stats: ['histogram'], breaks: [3], pixelRule: 'exact' });
        expect(hist.pixelArea).toBe(1);
        expect(hist.rows.map(r => r.hectares)).toEqual([0.0001, 0.00005]);
        expect(hist.rows.map(r => r.count)).toEqual([1, 0.5]);
        const counts = await zonalStats(fakeTiff({ geoKeys: utm }), z, { stats: ['mean', 'count'] });
        // Centre rule: only the pixel centred at 102.5 is inside.
        expect(counts.rows).toEqual([{ id: 'z', mean: 2, count: 1, hectares: 0.0001 }]);
        const sums = await zonalStats(fakeTiff({ geoKeys: utm }), z, { stats: ['sum'] });
        expect(sums.rows[0]).not.toHaveProperty('hectares');
        const classes = await zonalStats(fakeTiff({ geoKeys: utm }), z, { stats: ['classes'] });
        expect(classes.rows).toEqual([{ id: 'z', value: 2, count: 1, hectares: 0.0001 }]);
    });

    it('leaves hectares out for a raster in degrees', async () => {
        const out = await zonalStats(fakeTiff(), [zone('z', 102, 50, 103.5, 49)], { stats: ['histogram'], breaks: [3] });
        expect(out.pixelArea).toBeNull();
        expect(out.rows[0]).not.toHaveProperty('hectares');
    });

    it('says the pixel area in the tool output', async () => {
        const run = createZonalStats({
            open: async () => fakeTiff({ geoKeys: utm }),
            query: async () => [{ id: 'z', geojson: JSON.stringify(zone('x', 100, 50, 102, 48).geometry) }],
            allowed: ALLOWED_DIRECTORIES,
            format: markdownTable,
        });
        const out = await run({ cog_url: 's3://us-west-2.opendata.source.coop/x/y.tif', zones_sql: 'SELECT 1', stats: ['count'], zones_crs: 'EPSG:32611' });
        expect(out).toContain('| z | 4 | 0.0004 |');
        expect(out).toContain('Pixel area: 1 m²; `hectares` is the covered pixel count × that area.');
    });
});
