/**
 * Zonal statistics on a Cloud-Optimized GeoTIFF, for a raster with no H3 hex
 * copy (issue #14). geotiff.js reads the windows the zones cover by range
 * request and decodes them (DEFLATE, LZW, ZSTD and others), and the zones are
 * rasterized here. DuckDB's `raster` extension has no wasm build, and its GDAL
 * has no ZSTD codec, so it cannot do this in the browser.
 *
 * Pixel rule: a pixel belongs to a zone when its centre falls inside the zone
 * (holes and multipolygons by the even-odd rule), as rasterio and exactextract
 * count by default. `pixel_rule: "area"` weights each pixel by the share of it
 * the zone covers, estimated from an 8 × 8 grid of points in the pixel.
 *
 * Everything here but zonalStats' reads is pure, so it is tested without a
 * browser.
 */

/** geotiff.js on jsDelivr, as the worker loads it. */
export const GEOTIFF_URL = 'https://cdn.jsdelivr.net/npm/geotiff@3.0.5/+esm';

/** The most pixels one call reads, summed over its zones' windows. */
export const MAX_PIXELS = 25_000_000;

/** The most zones one call summarizes. */
export const MAX_ZONES = 10_000;

/** Points per side of the grid that estimates a pixel's covered share. */
export const AREA_SAMPLES = 8;

export const STATS = ['sum', 'mean', 'min', 'max', 'count', 'classes'];

/**
 * The share of each pixel of a w × h window that the rings cover, by the
 * even-odd rule. Ring coordinates are in pixels of the whole image, whose
 * pixel (i, j) has its centre at (i + 0.5, j + 0.5); the window starts at
 * pixel (x0, y0). With n = 1 a pixel is in or out by its centre; with n > 1
 * its share is the part of an n × n grid of points inside.
 */
export function coverage(rings, x0, y0, w, h, n = 1) {
    const cov = new Float32Array(w * h);
    const edges = [];
    for (const ring of rings) {
        for (let k = 0; k < ring.length; k++) {
            const a = ring[k];
            const b = ring[(k + 1) % ring.length];
            if (a[1] !== b[1]) edges.push([a[0], a[1], b[0], b[1]]);
        }
    }
    const weight = 1 / (n * n);
    const xs = [];
    for (let j = 0; j < h; j++) {
        for (let s = 0; s < n; s++) {
            const y = y0 + j + (s + 0.5) / n;
            xs.length = 0;
            for (const [ax, ay, bx, by] of edges) {
                if ((ay <= y) !== (by <= y)) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
            }
            if (xs.length < 2) continue;
            xs.sort((p, q) => p - q);
            for (let k = 0; k + 1 < xs.length; k += 2) {
                // Sample columns m, at x = x0 + (m + 0.5) / n, with xa <= x < xb.
                const first = Math.max(0, Math.ceil((xs[k] - x0) * n - 0.5));
                const last = Math.min(w * n - 1, Math.ceil((xs[k + 1] - x0) * n - 0.5) - 1);
                for (let m = first; m <= last; m++) cov[j * w + Math.floor(m / n)] += weight;
            }
        }
    }
    return cov;
}

/** The outer and inner rings of a GeoJSON Polygon or MultiPolygon, or null. */
export function polygonRings(geometry) {
    if (geometry?.type === 'Polygon') return geometry.coordinates;
    if (geometry?.type === 'MultiPolygon') return geometry.coordinates.flat();
    return null;
}

/**
 * Where a raster level sits: geographic origin, pixel size and dimensions.
 * Map coordinates (x, y) fall on pixel ((x - ox) / rx, (y - oy) / ry).
 */
export function toPixels(rings, { ox, oy, rx, ry }) {
    return rings.map(r => r.map(([x, y]) => [(x - ox) / rx, (y - oy) / ry]));
}

/** The window of whole pixels a set of pixel-space rings touches, clipped to the image, or null. */
export function windowOf(rings, width, height) {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const r of rings) {
        for (const [x, y] of r) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    const x0 = Math.max(0, Math.floor(minX));
    const y0 = Math.max(0, Math.floor(minY));
    const x1 = Math.min(width, Math.ceil(maxX));
    const y1 = Math.min(height, Math.ceil(maxY));
    return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

/** Accumulates one zone's statistics over a window's values and coverage. */
export function summarize(values, cov, nodata, classes) {
    let sum = 0; let count = 0; let min = Infinity; let max = -Infinity;
    const counts = classes ? new Map() : null;
    for (let i = 0; i < cov.length; i++) {
        const c = cov[i];
        if (c <= 0) continue;
        const v = Number(values[i]);
        if (Number.isNaN(v) || (nodata != null && v === nodata)) continue;
        sum += v * c;
        count += c;
        if (v < min) min = v;
        if (v > max) max = v;
        if (counts) counts.set(v, (counts.get(v) ?? 0) + c);
    }
    return { sum, count, min: count ? min : null, max: count ? max : null, counts };
}

/**
 * The finest level whose windows, summed, fit in maxPixels. Levels are
 * [{ width, height, ... }], finest first; `windows(level)` gives the zones'
 * windows on a level. Returns { index, windows, pixels } or null.
 */
export function chooseLevel(levels, windows, maxPixels) {
    for (let i = 0; i < levels.length; i++) {
        const ws = windows(levels[i]);
        const pixels = ws.reduce((n, w) => n + (w ? (w[2] - w[0]) * (w[3] - w[1]) : 0), 0);
        if (pixels <= maxPixels) return { index: i, windows: ws, pixels };
    }
    return null;
}

/**
 * The raster's CRS from its GeoKeys as `EPSG:<code>`, or null when it is
 * user-defined (code 32767) or missing.
 */
export function rasterCrs(geoKeys = {}) {
    for (const k of ['ProjectedCSTypeGeoKey', 'GeographicTypeGeoKey']) {
        const code = geoKeys[k];
        if (Number.isInteger(code) && code > 0 && code !== 32767) return `EPSG:${code}`;
    }
    return null;
}

const LONLAT = new Set(['EPSG:4326', 'OGC:CRS84', 'CRS84']);

/** Whether two CRS names are the same, counting EPSG:4326 and OGC:CRS84 as one, since zones are read lon/lat. */
export function sameCrs(a, b) {
    const norm = (c) => (LONLAT.has(String(c).toUpperCase()) ? 'LONLAT' : String(c).toUpperCase());
    return norm(a) === norm(b);
}

// s3:// paths the engine reads, as the https URLs geotiff.js fetches.
const HTTPS_FOR_S3 = [
    ['s3://us-west-2.opendata.source.coop/', 'https://data.source.coop/'],
    ['s3://', 'https://s3-west.nrp-nautilus.io/'],
];

/**
 * The https URL for a COG path, or an error message when the path is not in
 * the allowed directories (the same ones SQL may read).
 */
export function cogUrl(path, allowed) {
    if (typeof path !== 'string' || !path.trim()) return { error: 'no cog_url given' };
    let url = path.trim();
    for (const [from, to] of HTTPS_FOR_S3) {
        if (url.startsWith(from)) { url = to + url.slice(from.length); break; }
    }
    if (!/^https:\/\//.test(url)) return { error: `cog_url must be an https:// or s3:// path, not ${path}` };
    const ok = (allowed ?? []).some(d => d.startsWith('https://') && url.startsWith(d))
        || ((allowed ?? []).includes('s3://') && HTTPS_FOR_S3.some(([s3, https]) => s3 !== 's3://' && url.startsWith(https)));
    if (!ok) return { error: `cog_url is outside the allowed directories: ${path}` };
    return { url };
}

/** SQL that gives each zone's id and its geometry as GeoJSON in the raster's CRS. */
export function zonesSql(sql, zonesCrs, crs) {
    const body = sql.trim().replace(/;+\s*$/, '');
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const geom = sameCrs(zonesCrs, crs)
        ? 'geometry::GEOMETRY'
        : `ST_Transform(geometry::GEOMETRY, ${q(zonesCrs)}, ${q(crs)}, always_xy := true)`;
    // The newline ends a trailing -- comment in the caller's SQL.
    return `SELECT CAST(id AS VARCHAR) AS id, ST_AsGeoJSON(${geom}) AS geojson FROM (\n${body}\n) AS zones`;
}

/**
 * Zonal statistics over an open GeoTIFF.
 *
 * @param {Object} tiff - geotiff.js GeoTIFF
 * @param {{id: string, geometry: Object}[]} zones - GeoJSON in the raster's CRS
 * @param {Object} opts
 *   band       1-based band (default 1)
 *   stats      names from STATS (default sum, mean, count)
 *   pixelRule  'centre' (default) or 'area'
 *   maxPixels  cap on pixels read, summed over the zones' windows
 * @returns {{ rows, level, scale, pixels, notes }}
 */
export async function zonalStats(tiff, zones, { band = 1, stats = ['sum', 'mean', 'count'], pixelRule = 'centre', maxPixels = MAX_PIXELS } = {}) {
    const base = await tiff.getImage(0);
    const bands = base.getSamplesPerPixel();
    if (!Number.isInteger(band) || band < 1 || band > bands) throw new Error(`band must be 1 to ${bands}`);
    const [ox, oy] = base.getOrigin();
    const [rx, ry] = base.getResolution();
    const W = base.getWidth();
    const H = base.getHeight();
    const count = await tiff.getImageCount();
    const levels = [];
    for (let i = 0; i < count; i++) {
        const im = i === 0 ? base : await tiff.getImage(i);
        // Masks are images too; an overview keeps the base's bands.
        if (im.getSamplesPerPixel() !== bands) continue;
        const w = im.getWidth();
        const h = im.getHeight();
        levels.push({ image: im, width: w, height: h, ox, oy, rx: (rx * W) / w, ry: (ry * H) / h });
    }
    levels.sort((a, b) => b.width - a.width);

    const shapes = zones.map(z => ({ id: z.id, rings: polygonRings(z.geometry) }));
    const windows = (lv) => shapes.map(s => (s.rings ? windowOf(toPixels(s.rings, lv), lv.width, lv.height) : null));
    const chosen = chooseLevel(levels, windows, maxPixels);
    if (!chosen) {
        const coarsest = windows(levels.at(-1)).reduce((n, w) => n + (w ? (w[2] - w[0]) * (w[3] - w[1]) : 0), 0);
        throw new Error(`the zones cover ${coarsest.toLocaleString('en-US')} pixels even on the coarsest overview, `
            + `more than the ${maxPixels.toLocaleString('en-US')} one call may read. Use fewer or smaller zones.`);
    }
    const level = levels[chosen.index];
    // Sums and counts on an overview are scaled to full-resolution pixels.
    const scale = (W * H) / (level.width * level.height);
    const nodata = base.getGDALNoData();
    const n = pixelRule === 'area' ? AREA_SAMPLES : 1;
    const classes = stats.includes('classes');

    const rows = [];
    for (let i = 0; i < shapes.length; i++) {
        const { id, rings } = shapes[i];
        const win = chosen.windows[i];
        let s = { sum: 0, count: 0, min: null, max: null, counts: classes ? new Map() : null };
        if (win) {
            const [x0, y0, x1, y1] = win;
            const [values] = await level.image.readRasters({ window: win, samples: [band - 1] });
            const cov = coverage(toPixels(rings, level), x0, y0, x1 - x0, y1 - y0, n);
            s = summarize(values, cov, nodata, classes);
        }
        if (classes) {
            const entries = [...s.counts].sort((a, b) => a[0] - b[0]);
            for (const [value, c] of entries) rows.push({ id, value, count: round(c * scale) });
            if (!rings) rows.push({ id, value: null, count: null });
            continue;
        }
        const row = { id };
        for (const k of stats) {
            if (k === 'sum') row.sum = rings ? round(s.sum * scale) : null;
            if (k === 'mean') row.mean = s.count ? round(s.sum / s.count) : null;
            if (k === 'min') row.min = s.min;
            if (k === 'max') row.max = s.max;
            if (k === 'count') row.count = rings ? round(s.count * scale) : null;
        }
        rows.push(row);
    }

    const notes = [];
    const skipped = shapes.filter(s => !s.rings).length;
    if (skipped) notes.push(`${skipped} zone(s) are not polygons and have no statistics.`);
    if (chosen.index > 0) {
        notes.push(`Read at overview ${chosen.index} (${level.width} × ${level.height} pixels, ${Math.round(Math.sqrt(scale))}× coarser than full resolution), `
            + `because full resolution needs more than ${maxPixels.toLocaleString('en-US')} pixels. Sums and counts are scaled to full-resolution pixels; all values are approximate.`);
    }
    return { rows, level: chosen.index, scale, pixels: chosen.pixels, notes };
}

const round = (v) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : v);

export const ZONAL_STATS = [
    'Summarize a raster (a Cloud-Optimized GeoTIFF) over polygon zones: sum, mean, min, max and pixel count per zone, or',
    'the pixel count of each value for a categorical raster ("classes").',
    '',
    'Use this ONLY for a raster that has no H3 hex copy. When get_stac_details lists an H3 hex parquet for the dataset,',
    'join your zones to the hex in SQL with the `query` tool instead: it is faster and covers any area. This tool declines',
    'a COG whose collection lists a hex asset, and names that asset.',
    '',
    '- `cog_url`: the COG\'s path from get_stac_details or get_collection, as s3:// or https://.',
    '- `zones_sql`: a SELECT that returns one row per zone with columns `id` and `geometry` (a GEOMETRY), e.g.',
    '  `SELECT name AS id, geometry FROM read_parquet(\'s3://.../wards.parquet\')`.',
    '- `zones_crs`: the zones\' coordinate system, default EPSG:4326 (longitude, latitude). They are reprojected to the raster\'s.',
    '- `raster_crs`: only when the COG\'s own coordinate system is not an EPSG code; otherwise it is read from the file.',
    '- `pixel_rule`: "centre" (default) counts a pixel when its centre is inside the zone, as rasterio does; "area" weights',
    '  each pixel by the share of it inside the zone.',
    '',
    'One call reads at most a fixed number of pixels. Larger zones are read from a coarser overview, and the result says so;',
    'sums and counts are then scaled to full-resolution pixels and approximate.',
].join('\n');

export const ZONAL_SCHEMA = {
    type: 'object',
    properties: {
        cog_url: { type: 'string' },
        zones_sql: { type: 'string' },
        stats: { type: 'array', items: { type: 'string', enum: STATS }, default: ['sum', 'mean', 'count'] },
        band: { type: 'integer', default: 1 },
        pixel_rule: { type: 'string', enum: ['centre', 'area'], default: 'centre' },
        zones_crs: { type: 'string', default: 'EPSG:4326' },
        raster_crs: { type: 'string' },
        format: { type: 'string', enum: ['markdown', 'json'], default: 'markdown' },
    },
    required: ['cog_url', 'zones_sql'],
};

/**
 * The zonal_stats tool.
 *
 * @param {Object} deps
 *   open       (url) => Promise of a geotiff.js GeoTIFF
 *   query      the engine's query(sql, { limit }), locked as for `query`
 *   allowed    the directories SQL may read; the COG must be in one
 *   catalog    createCatalog() from stac.js, for hex copies of the COG
 *   maxPixels  cap on pixels read per call
 *   format     markdownTable from format.js
 * @returns {(args) => Promise<string>}
 */
export function createZonalStats({ open, query, allowed, catalog, maxPixels = MAX_PIXELS, format }) {
    const tiffs = new Map();
    const tiffFor = (url) => {
        if (!tiffs.has(url)) {
            if (tiffs.size >= 4) tiffs.delete(tiffs.keys().next().value);
            tiffs.set(url, open(url).catch((e) => { tiffs.delete(url); throw e; }));
        }
        return tiffs.get(url);
    };
    return async (args = {}) => {
        const stats = args.stats ?? ['sum', 'mean', 'count'];
        if (!Array.isArray(stats) || !stats.length || stats.some(s => !STATS.includes(s))) {
            return `Error: stats must be a list of ${STATS.join(', ')}`;
        }
        if (stats.includes('classes') && stats.length > 1) return 'Error: "classes" cannot be combined with other stats';
        const pixelRule = args.pixel_rule ?? 'centre';
        if (pixelRule !== 'centre' && pixelRule !== 'area') return 'Error: pixel_rule must be "centre" or "area"';
        const fmt = args.format ?? 'markdown';
        if (fmt !== 'markdown' && fmt !== 'json') return `Error: unknown format ${fmt}`;
        if (typeof args.zones_sql !== 'string' || !args.zones_sql.trim()) return 'Error: no zones_sql given';
        const { url, error } = cogUrl(args.cog_url, allowed);
        if (error) return `Error: ${error}`;

        const known = await catalog?.assetFor?.(url);
        if (known?.hex?.length) {
            const h = known.hex[0];
            return `Declined: ${known.collection} has an H3 hex copy of this raster, asset \`${h.key}\`: `
                + `\`read_parquet('${h.path}')\`. Join the zones to it with the \`query\` tool instead `
                + `(get_stac_details('${known.collection}') gives its columns).`;
        }

        let tiff;
        try {
            tiff = await tiffFor(url);
        } catch (err) {
            return `Error: could not open ${url} as a GeoTIFF: ${err.message}`;
        }
        const base = await tiff.getImage(0);
        const crs = args.raster_crs || rasterCrs(base.getGeoKeys()) || known?.crs;
        if (!crs) return 'Error: the COG\'s coordinate system is not an EPSG code; pass it as raster_crs (e.g. "ESRI:54009").';

        let rows;
        try {
            rows = await query(zonesSql(args.zones_sql, args.zones_crs || 'EPSG:4326', crs), { limit: MAX_ZONES + 1 });
        } catch (err) {
            return `SQL Error: ${err.message}\n\nzones_sql must be one SELECT returning columns \`id\` and \`geometry\`.`;
        }
        if (rows.length > MAX_ZONES) return `Error: zones_sql returned more than ${MAX_ZONES} zones`;
        const zones = rows.map(r => ({ id: r.id, geometry: r.geojson ? JSON.parse(r.geojson) : null }));

        let out;
        try {
            out = await zonalStats(tiff, zones, { band: args.band ?? 1, stats, pixelRule, maxPixels });
        } catch (err) {
            return `Error: ${err.message}`;
        }
        if (fmt === 'json') return JSON.stringify(out.rows);
        const rule = pixelRule === 'area' ? 'pixels weighted by the share inside each zone' : 'pixels whose centre is inside each zone';
        return [format(out.rows), '', `Pixel rule: ${rule}. Raster CRS: ${crs}.`, ...out.notes].join('\n');
    };
}
