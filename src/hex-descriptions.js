/**
 * The descriptions of the hex-tile tools, as geo-query gives them (the
 * docstrings of register_hex_tiles and get_hex_tile_status in server.py at
 * GEO_QUERY_REF). One phrase differs: the tiles are kept in the browser's
 * memory, not in object storage.
 */

export const REGISTER_HEX_TILES = `Aggregate an H3 hex visualization in the browser's memory and return a
paste-ready MapLibre render recipe.

The server always builds a vector tile pyramid and hands back a ready
\`source\` and \`layer\`. You render those verbatim.

WHEN TO USE — only when the user explicitly asks for an aggregate
density / heatmap / hex-grid visualization over a region. Trigger phrases:
"hex map", "density map", "heatmap", "show density of X", "hex grid",
"aggregate X by hex", "visualize density of X", "map the count of X per
area".

Call this ONLY to display a value your SQL COMPUTES that is not already a
servable field anywhere. If the value already lives somewhere renderable,
render that instead:
  - a raster field (effort, elevation, SST) -> the COG via titiler
  - a column already in a layer's PMTiles   -> data-driven paint (set_style)
  - a value your SQL computes, served by neither -> this tool
It also expects per-hex values across a region, large enough to exceed the
50-row \`query\` cap: a top-N answer is a \`query\` table, not a tile layer.
If intent is ambiguous, ask first.

Parameters:
- \`sql\`: a SELECT whose first column is an H3 index. The tool reads that
  column's H3 resolution and uses it as the pyramid's finest level. To get
  a coarser tileset, project upstream in the SQL (e.g.
  \`SELECT h3_cell_to_parent(h10, 6) AS h6, ...\`).
- \`agg\`: aggregation applied at each coarser pyramid level.
    - "COUNT" (default): SQL needs only the H3 column; output property
      is \`count\` (row count per hex). Use it for raw, un-grouped
      point/polygon rows. If your SELECT already produced one row per
      cell (you wrote \`GROUP BY h<H>\`), pass "SUM" to total that value up
      the pyramid, or "AVG"/"MAX" for an intensity — COUNT would count the
      single row per cell and drop your value column.
    - "AVG" / "SUM" / "MIN" / "MAX": SQL must return at least one
      numeric value column after the H3 index; each is aggregated by
      \`agg\` at every coarser level.
    - "COUNT_DISTINCT": SQL must return a KEY column after the H3 index
      (the thing counted distinctly, e.g. specieskey for species
      richness). Output property is that column, holding the distinct
      count per hex. Exact at the finest resolution; coarser pyramid
      levels roll up with MAX, a lower bound (see \`rollup_note\` in the
      result). Use this for richness maps — NOT plain COUNT, which
      measures sampling effort, not distinct species.
- \`color_scale\`: "linear" (default) or "log". Controls how the viridis
  ramp is spread across the data domain in the returned recipe; the tiles
  themselves are identical either way. Use "log" for right-skewed data
  (counts, populations) where a few hot cells otherwise wash everything
  else out. \`value_stats[<col>].suggested_scale\` (see below) is a free
  hint telling you when "log" is worth re-requesting — re-call with the
  same SQL and \`color_scale="log"\` for a cache hit that just re-styles.
- \`layer_style\`: "fill" (default, flat 2D) or "fill-extrusion" (3D — hex
  height also encodes the value). Like color_scale this only restyles the
  recipe, not the tiles. For 3D the map client must set pitch > 0 to see
  the extrusions; the returned \`layer\` is a \`fill-extrusion\` layer.

Returns a dict with \`status\` ∈ {"done", "running", "failed"}:
- status="done" (cache hit or fast build): the tiles exist. They are NOT
  on the map yet — display them by calling your client's map-display tool
  (\`add_hex_tile_layer\` in the geo-agent apps) with \`tile_url\` copied
  verbatim from \`tile_url_template\`, plus a \`value_column\`. \`next_step\` in
  the response says the same thing. Also \`value_columns\` and \`value_stats\`
  ({<col>: {"by_res": {"<res>": {"min","max","mean"}}, "suggested_scale":
  "linear"|"log"}}) if you want to customize the palette or honor the
  log-scale hint, plus \`hash\`, \`bounds\`, \`feature_count_finest\`.
- status="running": being built in the background. You get \`hash\` and
  \`tile_url_template\`. Call \`get_hex_tile_status(hash, wait_seconds=30)\`
  to poll — it long-polls server-side, so one call returns either the
  final recipe or a single "still running" response. Do NOT retry
  register_hex_tiles with different parameters; the original build still
  finishes, and re-submitting only queues more work.
- status="failed": build raised an error inline. \`error\` has the message.
  Safe to re-submit with adjusted parameters.

If your client has no map-display tool and you are driving MapLibre
directly, \`source\` and \`layer\` are paste-ready with a viridis ramp:
    map.addSource(id, result.source);
    map.addLayer({id: ..., source: id, ...result.layer});

SQL patterns — pick the one matching the ask; paste exact paths from
get_stac_details. \`<H>\` is the H3 resolution, usually 8.

1. Density (count features per hex):

   SELECT h<H> FROM read_parquet('<hex_path>') WHERE <filter>

   Call agg="COUNT". Works for pre-indexed points (GBIF) or polygons
   (PAD-US). For raw points with lat/lng:
   \`h3_latlng_to_cell(lat, lng, <H>) AS h<H>\`.

2. Masked aggregate (value dataset inside a geographic mask):

   SELECT a.h<H>, AVG(a.value) AS value         -- or MODE(class) / SUM / MAX
   FROM read_parquet('<values_hex>', hive_partitioning = true) a
   SEMI JOIN read_parquet('<mask_hex>', hive_partitioning = true) b
             USING (h<H>, h0)
   WHERE a.value IS NOT NULL
   GROUP BY a.h<H>;

   Call agg="AVG" (or the matching op). The SEMI JOIN must sit on the
   raw read_parquet(), upstream of GROUP BY — see h3-guide.md Problem 2.

3. Distinct-count per hex (e.g. species richness — distinct species
   per cell, NOT occurrence count):

   SELECT h<H>, specieskey                 -- H3 index, then the key to count
   FROM read_parquet('<hex_path>', hive_partitioning = true)
   WHERE <coordinate-quality filters>      -- see the gbif STAC data-quality note
   GROUP BY h<H>, specieskey               -- pre-dedup optional; the agg does the distinct

   Call agg="COUNT_DISTINCT". Exact at the finest resolution; coarser
   levels are a MAX-based lower bound (result carries \`rollup_note\`).

Always pass hive_partitioning = true so the planner can prune h0=* files.`;

export const GET_HEX_TILE_STATUS = `Poll the status of a pyramid build started by register_hex_tiles.

Call this when register_hex_tiles returned {status: "running"}.

Long-poll: pass \`wait_seconds\` (clamped to [0, 60]) to let the server
block until either the build finishes OR the wait expires. Use
wait_seconds=30 as a default — you get the final result if it finishes
in that window, otherwise one "still running" response so you know to
call again. Do NOT poll faster than this; rapid polling wastes turns
without giving the build time to make progress. wait_seconds=0 returns
immediately (the legacy non-blocking poll).

\`color_scale\` ("linear" default, or "log") and \`layer_style\` ("fill"
default, or "fill-extrusion") restyle the recipe returned on completion,
exactly as in register_hex_tiles — pass them here so a build you polled
comes back already styled, without a second register call.

Returns one of:
- {hash, tile_url_template, status: "done", bounds, value_stats, ...} —
  pyramid is on disk and renderable. Use bounds + value_stats with the
  map client (fit_bounds, palette domain).
- {hash, tile_url_template, status: "running", elapsed_seconds} —
  still building. Call again with wait_seconds=30.
- {hash, tile_url_template, status: "failed", error} — build raised.
  You may re-submit register_hex_tiles with adjusted parameters.
- {hash, tile_url_template, status: "unknown"} — no record of this hash
  in the current server process and no completed tileset on disk. The
  hash may be for a different server, or the build may never have
  started. Re-submit register_hex_tiles to (re-)start it.

Idempotent — safe to call repeatedly. Hash is the value returned by
register_hex_tiles.`;
