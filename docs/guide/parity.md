# Parity with geo-query

geo-query-wasm is meant to be a drop-in for geo-query: a client that works with one works with the other. The tools, their arguments and their output follow geo-query's, and the differences below come from running in a browser.

We compared the tools with geo-query at commit `222cecf` ([server.py](https://github.com/SchmidtDSE/geo-query/blob/222cecfd964438c82547c15a8069a85f86b8fa4c/server.py), [stac.py](https://github.com/SchmidtDSE/geo-query/blob/222cecfd964438c82547c15a8069a85f86b8fa4c/stac.py)), and the catalog code with geo-query at `262db76`, where geo-query#487 merged.

| geo-query feature | geo-query-wasm |
|---|---|
| `browse_stac_catalog`, with an inline `catalog` | Same markdown |
| `get_stac_details`, with an inline `collection` | Same markdown |
| `get_collection`, with an inline `collection` | Same JSON, with `s3://` hrefs, routing hints and nested children, which round-trip into `collection` |
| STAC catalogs at any depth, including [Portolan](https://www.portolan-sdi.org) catalogs | The same walk and output. Browse listings, `get_stac_details` markdown and `get_collection` dicts match geo-query `262db76` on the St. Louis and GLEN mirror catalogs and the fixture in `test/fixtures/portolan`. |
| `query` with `sql_query` or `sql` | Same arguments and errors. Adds `format: "json"` for app code. |
| Results as a markdown table of 50 rows | Same truncation note, "No results found.", 64-bit integers in full, floats to 10 significant figures, dates as `YYYY-MM-DD`, NULL as an empty cell |
| `s3_endpoint`, `s3_scope`, `s3_region` and `s3_url_style` for an anonymous source | Same per-query secret and endpoint allow-list |
| `s3_key` and `s3_secret` for a private bucket | Refused as query arguments, because the model writes them. The page sends keys with `sendSecrets()`, and the SQL reads the bucket through `s3://` paths ([Private data](./private-data)). |
| `catalog://list` and `catalog://{dataset_id}` resources | Same |
| `geospatial-analyst` prompt | Same text (`assistant-role.md`) |
| `query` description with `query-optimization.md` and `h3-guide.md` | The same files at a pinned commit, with `tier=extra` sections dropped unless `extraInstructions` is set, plus a section on the browser |
| `STAC_CATALOG_URL`, `STAC_DISCOVERY` and `EXTRA_INSTRUCTIONS` | `catalog`, `discovery` and `extraInstructions` in the worker's configuration. The default catalog is the source.coop mirror, where geo-query's is NRP's. |
| Locked DuckDB configuration | Locked, and also SELECT only, because the lock does not cover secrets |
| `register_hex_tiles` and `get_hex_tile_status` | Same arguments, statuses and responses. The pyramid is a table in the worker's memory, not parquet in object storage, and the tile URL is `geoquerywasm://tiles/hex/<hash>/{z}/{x}/{y}.pbf` ([Hex tiles](./hex-tiles)). |
| MVT tiles and `metadata.json` from `/tiles` over HTTP | MCP resources at the same paths under `geoquerywasm://`. `metadata.json` adds `cell_counts`, the cells at each level. |
| The H3 level a zoom serves, from the data's extent and an estimate of each level's cells | From the extent and each level's real cell count, and no finer than hexes with edges of 3 pixels |
| Bearer-token auth, `/healthz` and `/version` | Not applicable in a browser |
| No zonal statistics on rasters | `zonal_stats`, off by default, for a COG with no hex copy ([Zonal statistics](./zonal-statistics)) |

The server reports itself as `geo-query-wasm` in the MCP handshake. geo-query sends no server instructions, and neither does this server unless an app configures them.
