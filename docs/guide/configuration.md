# Configuration

An app configures the worker through its URL, as JSON in a `config` parameter, and an app that imports the engine passes the same options to `createEngine()`. S3 keys are not accepted in the worker URL, which is sent to the server that serves the file; [Private data](./private-data) describes how a page sends them.

## Worker options

| Option | Default | Use |
|---|---|---|
| `catalog` | The source.coop mirror of GLEN's catalog | STAC catalog URL, as geo-query's `STAC_CATALOG_URL`. The mirror lists GLEN's license-clear datasets, 140 in 21 groups, and a browser reads it much faster than NRP. NRP's canonical catalog is `NRP_CATALOG_URL` in `src/stac.js`. |
| `discovery` | true | false hides `browse_stac_catalog` and `catalog://list`, as `STAC_DISCOVERY=0`. |
| `extraInstructions` | false | true keeps the guidance meant for small models, as `EXTRA_INSTRUCTIONS`. |
| `guidanceRef` | `222cecf` | The geo-query commit the guidance is taken from. |
| `instructions` | none | Server instructions for the MCP handshake. geo-query sends none. |
| `maxTilesets` | 8 | Hex tilesets kept in memory. Beyond this, the least recently used is dropped, and its tile URL stops working. |
| `zonalStats` | false | true offers `zonal_stats` ([Zonal statistics](./zonal-statistics)). |
| `zonalMaxPixels` | 25,000,000 | Pixels one `zonal_stats` call may read, summed over its zones' windows. |

## Engine options

The worker also takes the engine's options, whose defaults are in `src/defaults.js`.

| Option | Default | Use |
|---|---|---|
| `timeout` | 600 | Seconds a query may run before it is cancelled. This is twice geo-query's limit, because reads in the browser are serial. `null` or `0` turns the limit off. Time spent waiting behind other queries does not count. |
| `workers` | 1 | DuckDB instances. Each runs one query at a time and reads one or two byte ranges at a time, so a page that sends several queries at once gains from more. A query goes to the least busy instance. |
| `secrets` | NRP Ceph, and source.coop on AWS | Anonymous S3 secrets: `{ name, scope, endpoint, region, url_style, use_ssl }`. |
| `allowedEndpoints` | NRP Ceph and the lab MinIO | S3 hosts a query's `s3_endpoint` may name, beyond the secrets' endpoints and AWS S3 hosts. |
| `rewrite` | none | `{ from, to }` text swapped in the SQL before it runs, such as an NRP prefix for its source.coop mirror. A URL that matches `fetchWhole` before or after the rewrites is fetched whole, so a rewrite never turns a whole-file fetch into range reads. |
| `fetchWhole` | none | URL prefixes whose `.parquet` files are fetched whole with `fetch()`, in parallel, and read from memory. GitHub Pages gzips responses and applies byte ranges to the compressed stream, which breaks DuckDB's range reads, so an app's own parquet on Pages needs this. |
| `settings` | geo-query's `preserve_insertion_order` and `disabled_optimizers` | DuckDB settings, merged over the defaults, so an app that adds one keeps the rest. A value of `null` leaves a default unset. |
| `allowedDirectories` | `s3://`, NRP and source.coop over https | The only places SQL may read. |
| `lock` | true | External access and extension loading off, configuration locked, SELECT only. The worker always sets it. |
| `duckdb` | `1.33.1-dev57.0` | The DuckDB-wasm version on jsDelivr, which is DuckDB 1.5.4. `1.33.1-dev114.0` is a build of DuckDB 2.0 that spills large aggregates and sorts; [Capabilities and limitations](../capabilities) compares the two. |

Rewrites are applied, and whole-fetch files substituted, before the SELECT check, so the check covers the SQL that runs.

glen-charts also sets `s3_allow_recursive_globbing = false`. It is not a default here, because the checks glob with `**`, but an app can set it in `settings`.
