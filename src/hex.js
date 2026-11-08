/**
 * geo-query's hex tiles in the browser: register_hex_tiles builds an H3
 * pyramid from the caller's SQL, and the tiles are encoded as MVT on request.
 *
 * geo-query writes the pyramid to object storage as parquet and serves it
 * over HTTP from /tiles. Here the pyramid is a table in one DuckDB instance's
 * memory, every resolution in one table, and a tile is one SELECT on it with
 * ST_AsMVT, the SQL geo-query's tile endpoint runs on its parquet
 * (tiles/endpoint.py). The tile URL uses the scheme `geoquerywasm:`:
 *
 *   geoquerywasm://tiles/hex/<hash>/{z}/{x}/{y}.pbf
 *   geoquerywasm://tiles/hex/<hash>/metadata.json
 *
 * The paths are geo-query's, so clients that read the hash or the metadata
 * URL from a tile URL find them. The worker serves both as MCP resources; a
 * page hands them to MapLibre with src/hex-protocol.js.
 *
 * The tile math, pyramid aggregation, render recipe and response texts follow
 * geo-query's tiles/tile_math.py, tiles/pyramid.py and server.py.
 */

import { REGISTER_HEX_TILES, GET_HEX_TILE_STATUS } from './hex-descriptions.js';

export { REGISTER_HEX_TILES, GET_HEX_TILE_STATUS };

export const SCHEME = 'geoquerywasm';
export const TILE_BASE = `${SCHEME}://tiles/hex/`;
export const MVT_LAYER_NAME = 'layer';
export const MVT_TYPE = 'application/vnd.mapbox-vector-tile';
/** Tilesets kept in memory; the least recently used is dropped beyond this. */
export const MAX_TILESETS = 8;

// Part of the content hash, so a change to the table layout gives new URLs.
const LAYOUT_VERSION = 'wasm-v1';
const AGGS = new Set(['AVG', 'SUM', 'MIN', 'MAX', 'COUNT', 'COUNT_DISTINCT']);
const HASH = /^[0-9a-f]{16}$/;
const INLINE_WAIT_SECONDS = 5;
const MAX_WAIT_SECONDS = 60;
const TARGET_CELLS_PER_TILE = 4000;
const BASE_ZOOM_OFFSET = 2;
const MAX_ZOOM = 24;
/** The fewest pixels along a hex's edge that a tile draws (hexEdgeRes). */
export const MIN_EDGE_PX = 3;

// ---------------------------------------------------------------- tile math

/** [west, south, east, north] in degrees for an XYZ tile. */
export function tileBounds(z, x, y) {
    const n = 2 ** z;
    const lat = (t) => Math.atan(Math.sinh(Math.PI * (1 - 2 * t / n))) * 180 / Math.PI;
    return [x / n * 360 - 180, lat(y + 1), (x + 1) / n * 360 - 180, lat(y)];
}

// Average H3 edge length (km) by resolution, which is also a cell's
// circumradius. https://h3geo.org/docs/core-library/restable/
const H3_EDGE_KM = [
    1107.712591, 418.6760055, 158.2446558, 59.81085794, 22.6063794,
    8.544408276, 3.229482772, 1.220629759, 0.461354684, 0.174375668,
    0.065907807, 0.024910561, 0.009415526, 0.003559893, 0.001348575,
    0.000509713,
];
const KM_PER_DEG = 111.195;

/**
 * [padLat, padLng] in degrees, about one cell circumradius at `res`. A tile
 * selects cells whose centre is within this of its edges, so a hex across a
 * tile seam is drawn on both sides (geo-query#188).
 */
export function edgePadding(res, lat) {
    const padLat = H3_EDGE_KM[Math.max(0, Math.min(15, res))] / KM_PER_DEG;
    return [padLat, padLat / Math.max(0.01, Math.cos(lat * Math.PI / 180))];
}

const mercYNorm = (lat) => {
    const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

/** Tiles at zoom z that a [w, s, e, n] box spans, at least 1. */
export function tilesCoveringBounds(z, [w, s, e, n]) {
    const nt = 2 ** z;
    const idx = (v) => Math.min(nt - 1, Math.max(0, Math.floor(v)));
    const cols = Math.max(1, idx((e + 180) / 360 * nt) - idx((w + 180) / 360 * nt) + 1);
    const rows = Math.max(1, idx(mercYNorm(s) * nt) - idx(mercYNorm(n) * nt) + 1);
    return cols * rows;
}

/**
 * The H3 resolution to serve at zoom z, in [minRes, finestRes]: the finest
 * whose cells per tile stay under the budget, over the tiles the data's
 * extent spans. zoomOffset below 2 biases one resolution finer per step.
 *
 * geo-query estimates each level's cells as the finest count over 7 per
 * level (tile_math.zoom_to_h3_res), which holds for contiguous data. Scattered
 * data, such as points over the globe, keeps one cell per point through
 * several levels, and the estimate then serves tiles of hundreds of thousands
 * of cells: 33 MB and a minute for one tile in the browser. With `cellCounts`,
 * the cells at each level, the choice uses the real counts, with the same
 * tolerance geo-query's rounding gives (half a level, a factor of √7).
 *
 * With `minEdgePx`, the level is also no finer than hexEdgeRes allows, so a
 * hex is at least that many pixels along an edge (hex.js uses 3). geo-query
 * has no such rule.
 */
export function zoomToH3Res(z, { minRes, finestRes, zoomOffset = 2, featureCountFinest, bounds, cellCounts,
    targetCellsPerTile = TARGET_CELLS_PER_TILE, minEdgePx = 0 }) {
    const bias = BASE_ZOOM_OFFSET - zoomOffset;
    const target = budgetRes(z, { minRes, finestRes, zoomOffset, featureCountFinest, bounds, cellCounts, targetCellsPerTile });
    const capped = minEdgePx > 0 ? Math.min(target, hexEdgeRes(z, bounds, minEdgePx) + bias) : target;
    return Math.max(minRes, Math.min(finestRes, capped));
}

/** Web Mercator metres per pixel at zoom z, for MapLibre's 512-pixel tiles. */
export const metresPerPixel = (z, lat) => 40075016.686 * Math.cos(lat * Math.PI / 180) / (512 * 2 ** z);

/**
 * The finest H3 level whose hexes have edges of at least `minEdgePx` pixels
 * at zoom z, at the latitude in the data's bounds nearest the equator, where
 * hexes look smallest. Finer levels draw specks rather than hexes, and each
 * hex costs time in the tile: about 0.25 ms in DuckDB-wasm.
 */
export function hexEdgeRes(z, bounds, minEdgePx) {
    const [, s, , n] = bounds ?? [0, 0, 0, 0];
    const lat = s <= 0 && n >= 0 ? 0 : Math.min(Math.abs(s), Math.abs(n), 85);
    const mpp = metresPerPixel(z, lat);
    for (let r = 15; r >= 0; r--) if (H3_EDGE_KM[r] * 1000 / mpp >= minEdgePx) return r;
    return 0;
}

function budgetRes(z, { minRes, finestRes, zoomOffset, featureCountFinest, bounds, cellCounts, targetCellsPerTile }) {
    let target;
    if (cellCounts && bounds) {
        const budget = targetCellsPerTile * tilesCoveringBounds(z, bounds) * Math.sqrt(7);
        target = minRes;
        for (let r = finestRes; r >= minRes; r--) {
            if ((cellCounts[r] ?? Infinity) <= budget) { target = r; break; }
        }
        target += BASE_ZOOM_OFFSET - zoomOffset;
    } else if (featureCountFinest > 0 && bounds) {
        const ratio = targetCellsPerTile * tilesCoveringBounds(z, bounds) / featureCountFinest;
        const delta = Math.log(ratio) / Math.log(7);
        target = Math.floor(finestRes + delta + 0.5) + (BASE_ZOOM_OFFSET - zoomOffset);
    } else {
        target = z - zoomOffset;
    }
    return target;
}

// ---------------------------------------------------------------- hashing and URLs

/** 16 hex characters of SHA-1 over the registration inputs, as geo-query hashes them. */
export async function contentHash({ sql, finestRes, minRes, agg, zoomOffset }) {
    const canonical = [LAYOUT_VERSION, sql, finestRes, minRes, agg, zoomOffset].join('\0');
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(canonical));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export const tileUrlTemplate = (hash) => `${TILE_BASE}${hash}/{z}/{x}/{y}.pbf`;
export const metadataUrl = (hash) => `${TILE_BASE}${hash}/metadata.json`;

/** { hash, z, x, y } for a tile URL, { hash, metadata: true } for a metadata URL, else null. */
export function parseTileUrl(url) {
    if (typeof url !== 'string' || !url.startsWith(TILE_BASE)) return null;
    const rest = url.slice(TILE_BASE.length).split(/[?#]/)[0];
    let m = rest.match(/^([0-9a-f]{16})\/(\d{1,2})\/(\d{1,8})\/(\d{1,8})\.pbf$/);
    if (m) return { hash: m[1], z: Number(m[2]), x: Number(m[3]), y: Number(m[4]) };
    m = rest.match(/^([0-9a-f]{16})\/metadata\.json$/);
    return m ? { hash: m[1], metadata: true } : null;
}

// ---------------------------------------------------------------- SQL

const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;
const bare = (sql) => sql.trim().replace(/;\s*$/, '');
// A CAST keeps a literal such as 0.2033… from being typed DECIMAL(18,17),
// which overflows in arithmetic (geo-query#204).
const num = (v) => `CAST(${Number(v)} AS DOUBLE)`;

/**
 * One SELECT that builds the whole pyramid: the caller's rows aggregated to
 * their own resolution, then rolled up to each coarser one down to minRes.
 * Columns: res, h, __lat and __lng (the cell's centre, for selecting a tile's
 * cells), then the value columns.
 *
 * Each level rolls up the one below it, as geo-query's builds do, in a
 * recursive CTE. On 5.75 million cells at res 10 in Chrome, the rollups took
 * 1.4 s and the cell centres 2.8 s. Centres stored once keep a tile's
 * selection to a range filter (0.01 s); sorting the table by them took 1.8 s
 * more and made no difference to it.
 */
export function pyramidSql({ sql, h3Column, valueColumns, agg, finestRes, minRes }) {
    const a = agg.toUpperCase();
    if (!AGGS.has(a)) throw new Error(`agg must be one of ${[...AGGS].join(', ')}, got ${JSON.stringify(agg)}`);
    if (a !== 'COUNT' && !valueColumns.length) {
        throw new Error("user SQL must return at least one value column after the H3 index (or use agg='COUNT')");
    }
    const cols = valueColumns.map(ident);
    const each = (f) => cols.map(f).join(', ');
    const [finest, parent] = {
        COUNT: ['COUNT(*) AS count', 'SUM(count) AS count'],
        SUM: [each(c => `SUM(${c}) AS ${c}`), each(c => `SUM(${c}) AS ${c}`)],
        MIN: [each(c => `MIN(${c}) AS ${c}`), each(c => `MIN(${c}) AS ${c}`)],
        MAX: [each(c => `MAX(${c}) AS ${c}`), each(c => `MAX(${c}) AS ${c}`)],
        // Exact only at the finest level; MAX of the children is a lower bound (geo-query#331).
        COUNT_DISTINCT: [each(c => `COUNT(DISTINCT ${c}) AS ${c}`), each(c => `MAX(${c}) AS ${c}`)],
        // A weight column makes the parents' averages weighted by row count.
        AVG: [`${each(c => `AVG(${c}) AS ${c}`)}, COUNT(*) AS __pyramid_weight`,
            `${each(c => `SUM(${c} * __pyramid_weight) / SUM(__pyramid_weight) AS ${c}`)}, SUM(__pyramid_weight) AS __pyramid_weight`],
    }[a];
    const h = ident(h3Column);
    return [
        'WITH RECURSIVE __src AS (',
        bare(sql),
        `), __finest AS (`,
        `  SELECT ${h} AS h, ${finest} FROM __src WHERE ${h} IS NOT NULL GROUP BY 1`,
        `), __levels AS (`,
        `  SELECT CAST(${Number(finestRes)} AS INTEGER) AS res, * FROM __finest`,
        `  UNION ALL`,
        `  SELECT res - 1 AS res, h3_cell_to_parent(h, res - 1) AS h, ${parent}`,
        `  FROM __levels WHERE res > ${Number(minRes)}`,
        `  GROUP BY 1, 2`,
        `)`,
        `SELECT res, h, h3_cell_to_lat(h) AS __lat, h3_cell_to_lng(h) AS __lng, * EXCLUDE (res, h)`,
        `FROM __levels`,
    ].join('\n');
}

/**
 * The cell's boundary in web mercator. Tiles at the antimeridian rebuild a
 * cell that crosses it in a continuous frame and project it by hand, as
 * geo-query does (tiles/endpoint.py, _boundary_geom_sql; geo-query#164, #201).
 */
function boundarySql(touchesDateline) {
    if (!touchesDateline) {
        return "ST_Transform(h3_cell_to_boundary_wkt(src.h)::GEOMETRY, 'EPSG:4326', 'EPSG:3857', true)";
    }
    const scale = 20037508.34 / 180;
    return `(
        WITH _v AS (
          SELECT ST_X(d.geom) AS x, ST_Y(d.geom) AS y, d.path[1] AS idx
          FROM UNNEST(ST_Dump(ST_Points(h3_cell_to_boundary_wkt(src.h)::GEOMETRY))) AS u(d)
        ),
        _c AS (
          SELECT (MAX(x) - MIN(x)) > 180 AS crosses, h3_cell_to_lng(src.h) AS ref FROM _v
        )
        SELECT ST_MakePolygon(ST_MakeLine(list(ST_Point(
          (CASE WHEN _c.crosses AND (_v.x - _c.ref) >  180 THEN _v.x - 360
                WHEN _c.crosses AND (_v.x - _c.ref) < -180 THEN _v.x + 360
                ELSE _v.x END) * ${scale},
          ln(tan((90.0 + _v.y) * pi() / 360.0)) / (pi() / 180.0) * ${scale}
          ) ORDER BY _v.idx)))
        FROM _v, _c
      )`;
}

const mercX = (lng) => lng * 20037508.34 / 180;
const mercY = (lat) => Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180) * 20037508.34 / 180;

// Property types ST_AsMVT writes as they are; others are cast.
const MVT_TYPES = /^(BOOLEAN|TINYINT|SMALLINT|INTEGER|BIGINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|VARCHAR)$/;
const NUMERIC = /^(HUGEINT|UHUGEINT|DECIMAL)/;

/** The tile's feature properties: every column but the cell and its centre. */
export function propertiesSql(columns) {
    return columns
        .filter(c => !['h', '__lat', '__lng'].includes(c.name))
        .map(c => (MVT_TYPES.test(c.type) ? `src.${ident(c.name)}`
            : `CAST(src.${ident(c.name)} AS ${NUMERIC.test(c.type) ? 'DOUBLE' : 'VARCHAR'}) AS ${ident(c.name)}`))
        .join(', ');
}

/**
 * The SELECT that returns one tile as MVT bytes: one row, or none when no
 * cell falls in the tile (geo-query answers 204 then).
 */
export function tileSql({ table, z, x, y, res, columns }) {
    const [w, s, e, n] = tileBounds(z, x, y);
    const [padLat, padLng] = edgePadding(res, Math.max(Math.abs(n), Math.abs(s)));
    const box = `{'min_x': ${num(mercX(w))}, 'min_y': ${num(mercY(s))}, 'max_x': ${num(mercX(e))}, 'max_y': ${num(mercY(n))}}::BOX_2D`;
    return `WITH src AS (
  SELECT * FROM ${ident(table)}
  WHERE res = ${Number(res)}
    AND __lat BETWEEN ${num(s - padLat)} AND ${num(n + padLat)}
    AND __lng BETWEEN ${num(w - padLng)} AND ${num(e + padLng)}
), projected AS (
  SELECT ST_AsMVTGeom(ST_MakeValid(${boundarySql(w <= -179.999 || e >= 179.999)}), ${box}, 4096, 256, true) AS geom,
         ${propertiesSql(columns)}
  FROM src
)
SELECT ST_AsMVT(projected) AS mvt FROM projected WHERE geom IS NOT NULL HAVING count(*) > 0`;
}

// ---------------------------------------------------------------- render recipe (tiles/pyramid.py)

// matplotlib's viridis at six points (geo-query#238).
const VIRIDIS = [[0, '#440154'], [0.2, '#414487'], [0.4, '#2a788e'], [0.6, '#22a884'], [0.8, '#7ad151'], [1, '#fde725']];
const EXTRUSION_MAX_HEIGHT = 50000;

/** "log" when the finest level's max is more than ten times its mean. */
export function suggestScale(byRes, finestRes) {
    const { max, mean } = byRes[String(finestRes)] ?? {};
    return mean > 0 && max != null && max / mean > 10 ? 'log' : 'linear';
}

function rampValue(frac, vmin, vmax, scale) {
    if (scale === 'log') {
        const lo = vmin > 0 ? vmin : (vmax > 0 ? vmax / 1000 : 1);
        const hi = vmax > lo ? vmax : lo * 10;
        return lo * (hi / lo) ** frac;
    }
    return vmin + frac * (vmax - vmin);
}

/** { source, layer }: a MapLibre vector source and a layer with a viridis ramp over the first value column. */
export function renderRecipe(meta, url, colorScale = 'linear', layerStyle = 'fill') {
    const col = meta.value_columns[0];
    const byRes = meta.value_stats?.[col]?.by_res ?? {};
    const stats = byRes[String(meta.finest_res)] ?? Object.values(byRes)[0];
    const vmin = stats?.min ?? 0;
    let vmax = stats?.max ?? vmin;
    if (vmax === vmin) vmax = vmin + 1;
    const stops = (out) => VIRIDIS.flatMap(([f, c]) => [rampValue(f, vmin, vmax, colorScale), out(f, c)]);
    const color = ['interpolate', ['linear'], ['get', col], ...stops((f, c) => c)];
    const sourceLayer = meta.layer_name ?? MVT_LAYER_NAME;
    const layer = layerStyle === 'fill-extrusion'
        ? { type: 'fill-extrusion', 'source-layer': sourceLayer, paint: {
            'fill-extrusion-color': color,
            'fill-extrusion-height': ['interpolate', ['linear'], ['get', col], ...stops(f => f * EXTRUSION_MAX_HEIGHT)],
            'fill-extrusion-base': 0,
            'fill-extrusion-opacity': 0.85,
        } }
        : { type: 'fill', 'source-layer': sourceLayer, paint: { 'fill-color': color, 'fill-opacity': 0.7 } };
    return { source: { type: 'vector', tiles: [url], minzoom: 0, maxzoom: 14 }, layer };
}

export const ROLLUP_NOTE = 'COUNT_DISTINCT is exact at the finest resolution (finest_res); coarser '
    + 'pyramid levels roll up with MAX, a lower bound on the true distinct count '
    + "(a parent's richness is at least its largest child, but siblings may share "
    + 'keys). Values are accurate at high zoom and under-count at low zoom.';

export const HANDOFF_NOTE = 'Tiles are built, but they are NOT on the map yet. To display them, call '
    + "your client's map-display tool (`add_hex_tile_layer` in the geo-agent "
    + 'apps) with `tile_url` copied verbatim from `tile_url_template` above, '
    + 'plus a `value_column` from `value_columns`. If your client has no such '
    + 'tool, `source` and `layer` are a paste-ready MapLibre recipe.';

/** A status="done" response, as geo-query's _done_response and cached_result_dict build it. */
export function doneResponse(hash, meta, { cacheHit = false, colorScale = 'linear', layerStyle = 'fill' } = {}) {
    const url = tileUrlTemplate(hash);
    return {
        tile_url_template: url,
        hash,
        bounds: meta.bounds,
        finest_res: meta.finest_res,
        min_res: meta.min_res,
        zoom_offset: meta.zoom_offset,
        value_columns: meta.value_columns,
        value_stats: meta.value_stats,
        layer_name: meta.layer_name,
        feature_count_finest: meta.feature_count_finest,
        ...(cacheHit ? { cache_hit: true } : {}),
        ...(meta.agg.toUpperCase() === 'COUNT_DISTINCT' ? { rollup_note: ROLLUP_NOTE } : {}),
        next_step: HANDOFF_NOTE,
        ...renderRecipe(meta, url, String(colorScale ?? 'linear').toLowerCase(), String(layerStyle ?? 'fill').toLowerCase()),
        status: 'done',
    };
}

// ---------------------------------------------------------------- tilesets

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * The hex-tile tools over an engine (engine.js, or a stand-in with the same
 * arrow, json, createTable and dropTable).
 *
 * Tilesets live in this object, keyed by content hash: { status, started,
 * promise, meta, table, instance, columns, error, used }. A build runs in the
 * background; register waits up to 5 seconds for it, and status up to 60.
 */
export function createHexTiles(engine, { maxTilesets = MAX_TILESETS, inlineWaitSeconds = INLINE_WAIT_SECONDS,
    targetCellsPerTile = TARGET_CELLS_PER_TILE, minEdgePx = MIN_EDGE_PX } = {}) {
    const sets = new Map();

    const firstCell = async (sql) => {
        const table = await engine.arrow(`SELECT * FROM (\n${bare(sql)}\n) __q LIMIT 0`);
        return table.schema.fields.map(f => f.name);
    };

    const prepare = async ({ sql, agg = 'COUNT', finest_res: finestRes = null, min_res: minRes = 2, zoom_offset: zoomOffset = 2 }) => {
        agg = String(agg ?? 'COUNT');
        if (!AGGS.has(agg.toUpperCase())) throw new Error(`agg must be one of ${[...AGGS].join(', ')}, got ${JSON.stringify(agg)}`);
        const [h3Column, ...rest] = await firstCell(sql);
        if (!h3Column) throw new Error('user SQL returned no columns');
        if (finestRes == null) {
            const [probe] = await engine.json(`SELECT h3_get_resolution(${ident(h3Column)}) AS r FROM (\n${bare(sql)}\n) __q LIMIT 1`);
            if (probe?.r == null) {
                throw new Error('Cannot auto-detect finest_res: user SQL returned no rows, or the first column '
                    + `('${h3Column}') is not an H3 cell. Narrow the SQL until it returns at least one row whose `
                    + 'first column is an H3 index.');
            }
            finestRes = Number(probe.r);
        }
        if (finestRes < minRes) throw new Error(`finest_res (${finestRes}) must be >= min_res (${minRes})`);
        // Carried H3 index columns (h0, h8, …) are keys, not values (geo-query#319).
        const valueColumns = agg.toUpperCase() === 'COUNT' ? ['count'] : rest.filter(c => !/^h\d+$/.test(c));
        if (!valueColumns.length) {
            throw new Error("user SQL must return at least one value column after the H3 index (or use agg='COUNT')");
        }
        const hash = await contentHash({ sql, finestRes, minRes, agg, zoomOffset });
        return { hash, sql, agg, finestRes, minRes, zoomOffset, h3Column, valueColumns };
    };

    const build = async (plan, set) => {
        const table = `hex_${plan.hash}`;
        set.table = table;
        set.instance = await engine.createTable(table, pyramidSql(plan));
        const on = { instance: set.instance };
        try {
            set.columns = await engine.json(`SELECT column_name AS name, data_type AS type FROM information_schema.columns
                WHERE table_name = '${table}' ORDER BY ordinal_position`, on);
            const [b] = await engine.json(`SELECT MIN(__lng) AS w, MIN(__lat) AS s, MAX(__lng) AS e, MAX(__lat) AS n,
                COUNT(*) AS ct FROM ${ident(table)} WHERE res = ${plan.finestRes}`, on);
            const counts = await engine.json(`SELECT res, COUNT(*) AS n FROM ${ident(table)} GROUP BY res`, on);
            const valueStats = {};
            for (const col of plan.valueColumns) {
                const rows = await engine.json(`SELECT res, MIN(${ident(col)}) AS min, MAX(${ident(col)}) AS max,
                    AVG(${ident(col)}) AS mean FROM ${ident(table)} GROUP BY res ORDER BY res`, on);
                const byRes = Object.fromEntries(rows.map(r => [String(r.res), { min: r.min, max: r.max, mean: r.mean }]));
                valueStats[col] = { by_res: byRes, suggested_scale: suggestScale(byRes, plan.finestRes) };
            }
            return {
                finest_res: plan.finestRes,
                min_res: plan.minRes,
                agg: plan.agg,
                zoom_offset: plan.zoomOffset,
                value_columns: plan.valueColumns,
                value_stats: valueStats,
                layer_name: MVT_LAYER_NAME,
                bounds: [b.w, b.s, b.e, b.n],
                feature_count_finest: Number(b.ct),
                // Cells at each level, which pick the level for a zoom (zoomToH3Res).
                cell_counts: Object.fromEntries(counts.map(r => [String(r.res), Number(r.n)])),
            };
        } catch (err) {
            await engine.dropTable(table, set.instance).catch(() => {});
            throw err;
        }
    };

    // Drop the least recently used tilesets beyond the limit.
    const evict = async () => {
        const done = [...sets.entries()].filter(([, s]) => s.status === 'done').sort((a, b) => a[1].used - b[1].used);
        for (const [hash, s] of done.slice(0, Math.max(0, done.length - maxTilesets))) {
            sets.delete(hash);
            await engine.dropTable(s.table, s.instance).catch(() => {});
        }
    };

    const start = (plan) => {
        const set = { status: 'running', started: Date.now(), used: Date.now() };
        set.promise = build(plan, set).then(
            (meta) => { Object.assign(set, { status: 'done', meta, used: Date.now() }); return evict(); },
            (err) => { Object.assign(set, { status: 'failed', error: String(err?.message ?? err) }); },
        );
        sets.set(plan.hash, set);
        return set;
    };

    const report = (hash, set, opts) => {
        const base = { hash, tile_url_template: tileUrlTemplate(hash) };
        if (!set) return { ...base, status: 'unknown' };
        if (set.status === 'done') return doneResponse(hash, set.meta, opts);
        if (set.status === 'failed') return { ...base, status: 'failed', error: set.error };
        return { ...base, status: 'running', elapsed_seconds: Math.round((Date.now() - set.started) / 100) / 10 };
    };

    const waitFor = (set, seconds) => (set?.status === 'running' && seconds > 0
        ? Promise.race([set.promise, sleep(seconds * 1000)]) : Promise.resolve());

    return {
        /** register_hex_tiles: the response object. Throws on bad SQL or arguments, as geo-query raises. */
        async register(args = {}) {
            const sql = args.sql || args.sql_query;
            if (typeof sql !== 'string' || !sql.trim()) {
                return { status: 'failed', error: 'no query provided — pass the SQL as `sql` (the alias `sql_query` is also accepted).' };
            }
            const plan = await prepare({ ...args, sql });
            const opts = { colorScale: args.color_scale, layerStyle: args.layer_style };
            let set = sets.get(plan.hash);
            if (set?.status === 'done') {
                set.used = Date.now();
                return doneResponse(plan.hash, set.meta, { ...opts, cacheHit: true });
            }
            // A failed build is tried again: in a browser, failures are often the network's.
            if (!set || set.status === 'failed') set = start(plan);
            await waitFor(set, inlineWaitSeconds);
            return report(plan.hash, set, opts);
        },

        /** get_hex_tile_status: the response object. */
        async status(args = {}) {
            const hash = String(args.hash ?? '');
            const wait = Math.max(0, Math.min(Number.parseInt(args.wait_seconds ?? 0, 10) || 0, MAX_WAIT_SECONDS));
            const set = HASH.test(hash) ? sets.get(hash) : undefined;
            await waitFor(set, wait);
            return report(hash, set, { colorScale: args.color_scale, layerStyle: args.layer_style });
        },

        /** The tileset's metadata, as geo-query's metadata.json, or null. */
        metadata(hash) {
            const set = sets.get(hash);
            return set?.status === 'done' ? set.meta : null;
        },

        /** One tile as MVT bytes (empty when no cell falls in it), or null for an unknown tileset. */
        async tile(hash, z, x, y) {
            const set = sets.get(hash);
            if (set?.status !== 'done') return null;
            if (!(z >= 0 && z <= MAX_ZOOM && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z)) {
                throw new Error(`no tile ${z}/${x}/${y}`);
            }
            set.used = Date.now();
            const m = set.meta;
            const res = zoomToH3Res(z, {
                minRes: m.min_res, finestRes: m.finest_res, zoomOffset: m.zoom_offset,
                featureCountFinest: m.feature_count_finest, bounds: m.bounds, cellCounts: m.cell_counts,
                targetCellsPerTile,
                minEdgePx,
            });
            const table = await engine.arrow(tileSql({ table: set.table, z, x, y, res, columns: set.columns }), { instance: set.instance });
            return table.getChildAt(0)?.get(0) ?? new Uint8Array(0);
        },
    };
}
