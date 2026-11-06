# glen-wasm

A prototype of a GLEN MCP data server that runs inside the browser. DuckDB-wasm runs in a Web Worker and serves MCP tools to the page. The tools follow [geo-query](https://github.com/SchmidtDSE/geo-query): the model finds datasets in GLEN's STAC catalog and reads them by URL in SQL, with `read_parquet('s3://...')`. The page runs the [glen-harness](https://github.com/SchmidtDSE/glen-harness) agent loop and reaches the worker over `postMessage`, not HTTP. No server of ours is involved: the page and the worker are static files, the data are public files on NRP and source.coop, and the only party that sees the user's questions is the language model endpoint the user chooses.

## Architecture

```
page (index.html, src/app.js)
  glen-harness Agent ──── HTTPS ────▶ OpenAI-compatible model endpoint
        │
  MCPClient + PostMessageTransport
        │  postMessage (MCP JSON-RPC)
        ▼
Web Worker (src/worker.js, src/server.js, src/stac.js)
  MCP server: browse_stac_catalog, get_stac_details, query
        │                      │
        │                      └── STAC JSON ◀── NRP S3 (public-data/stac/catalog.json)
        ▼
  DuckDB-wasm (its own worker) ◀── parquet byte ranges ◀── NRP S3, source.coop
```

- **The worker is the server's container.** Its only interface is `postMessage`, and the page talks to it only in MCP. This is the browser counterpart of an MCP server in a Docker container behind a TCP port.
- **The tools match geo-query's.** `browse_stac_catalog` lists the catalog's datasets, and `get_stac_details` gives a collection's `read_parquet()` paths and columns in geo-query's markdown. `query` takes `sql_query` and reports failures as `SQL Error: …`. There are no tables, so the model's SQL names its data by `s3://` path, as on geo-query.
- **The worker reads S3 as geo-query does.** It loads httpfs, h3 and spatial, and creates the same anonymous S3 secrets: one for NRP Ceph and one scoped to the source.coop bucket on AWS. `s3://` paths, globs and `h0=` hive partitions work as they do on the server.
- **The SQL can read only the data hosts.** DuckDB's `allowed_directories` limits reads to `s3://` paths (which go only to the endpoints the two secrets name) and to `https://` URLs on NRP and source.coop. The worker turns external access off, locks the configuration, and runs only SELECT queries. A query that reads another host, changes a setting, creates a secret or attaches a database fails. The details are in the DuckDB-wasm section below.
- **California county files are the fast path.** The [tpl-cities browser tile set](https://github.com/boettiger-lab/tpl-cities/blob/main/notes/in-browser.md) holds one small parquet file per California county for eight GLEN hex datasets, a few hundred kilobytes to a few megabytes each. The server's instructions give the model their paths. A browser reads them in under a second, whereas scans over the national hex files take many serial requests.

## Datasets

The STAC catalog at `https://s3-west.nrp-nautilus.io/public-data/stac/catalog.json` lists about 80 collections. The California county files cover ACS 2020–2024 block groups, Census 2024 tracts and places, CalEnviroScreen 5.0, DWR disadvantaged communities (2023), CAL FIRE fire perimeters, USFS Wildfire Hazard Potential (2023), and FEMA flood hazard zones, one row per H3 cell (resolution 10, or 9 for wildfire hazard) per feature. `src/datasets.js` lists them with the guidance the server sends to the model.

## Try it

Serve the repository as static files and open it:

```bash
python3 -m http.server 8000
# http://localhost:8000/
```

Enter an OpenAI-compatible endpoint, a model name and an API key, then **Start**. DuckDB and its extensions load in about 4 seconds. The key stays in the page's memory; the endpoint and model name are remembered in the browser.

## Checks

- `pnpm test` runs the server over a `MessageChannel` with glen-harness's `MCPClient`, using a stub in place of DuckDB, and tests the STAC rendering against fixture collections.
- `node scripts/e2e.mjs` runs the page in headless Chrome against a scripted stand-in for the model, so no API key is needed. It reads the live catalog and checks that SQL can glob and read `s3://` paths on NRP and source.coop, read an `https://` URL, and call h3 and spatial functions. It runs a full agent turn (model → `browse_stac_catalog` → `query` → answer), checks that numbers come back correctly, and checks that SQL cannot read another host, change its settings, create a secret or attach a database. CI runs it on every push.
- `node scripts/duckdb-http-probe.mjs [httpfs|autoload|s3|locked]` measures the HTTP requests behind each query. The DuckDB-wasm section below reports its results.

## Vendored code

The page and the worker load everything by relative path from the same origin, apart from DuckDB-wasm itself (pinned, from jsDelivr):

- `vendor/glen-harness/`: glen-harness at the commit in `HARNESS_REF`, copied by `pnpm run vendor:harness`.
- `vendor/mcp-server-sdk.js`: the server half of the MCP SDK 1.12.0, bundled by `pnpm run build:vendor`.

CI regenerates both and fails if they differ from what is committed. Development dependencies are installed with pnpm, which runs no dependency install scripts and installs no version less than a week old (`pnpm-workspace.yaml`).

## DuckDB-wasm extensions and remote reads

We pin `@duckdb/duckdb-wasm@1.33.1-dev57.0`, which is DuckDB v1.5.4. The measurements below come from `scripts/duckdb-http-probe.mjs` in headless Chrome on 2026-11-06. The official documentation is the [DuckDB-wasm pages](https://duckdb.org/docs/stable/clients/wasm/overview) on duckdb.org, especially [Extensions](https://duckdb.org/docs/stable/clients/wasm/extensions) and [Troubleshoot](https://duckdb.org/docs/stable/clients/wasm/troubleshoot).

**Extensions.** `LOAD httpfs;`, `INSTALL spatial; LOAD spatial;` and `INSTALL h3 FROM community; LOAD h3;` all work in this build. h3 is a community extension, so a bare `LOAD h3` fails. In DuckDB-wasm, `INSTALL` stores nothing, because the browser keeps no storage between sessions. `LOAD` fetches the extension's wasm build from DuckDB's extension repository each time the page starts. Core extensions are also autoloaded on first use, but not once external access is off.

**The httpfs extension must be loaded explicitly.** DuckDB-wasm has two HTTP paths, and they read remote files very differently. On a 1 GB CHELSA hex parquet on source.coop with 3,780 row groups:

| Query on the 1 GB file | Without `LOAD httpfs` | With `LOAD httpfs` |
|---|---|---|
| First read (`count(*)`) | 1 plain GET of the whole file, 1,013 MB, 28 s | 2 range GETs of the footer, 0.3 MB, 1 s |
| `avg()` of one column over all rows | served from the downloaded copy | 64 range GETs, 18 MB, 10 s |
| One row selected by a filter on `h8` | served from the downloaded copy | 1 range GET, 0.08 MB |

Without the explicit `LOAD`, DuckDB-wasm's built-in HTTP file system sends a GET with no `Range` header, so the browser downloads the whole file. This is open issue [duckdb-wasm#2153](https://github.com/duckdb/duckdb-wasm/issues/2153), and a maintainer's workaround there is to run `LOAD httpfs` first. The [overview](https://duckdb.org/docs/stable/clients/wasm/overview) describes the same behaviour the other way round, saying the httpfs path "may currently download the whole file". Our measurement agrees with the issue. An earlier version of this prototype fetched whole county files with `fetch()`, all at once, to avoid DuckDB-wasm's serial range requests (below). With httpfs loaded, reading a county file by URL takes under a second, so the worker now leaves reads to DuckDB.

With httpfs loaded, DuckDB-wasm reads parquet the way native DuckDB does. It reads the footer, fetches only the column chunks a query needs, and skips row groups whose min/max statistics rule them out. A selective filter on a sorted column such as an H3 index therefore reads a tiny part of the file.

**S3 paths and globs work in the browser.** With an anonymous S3 secret, DuckDB-wasm reads the same `s3://` paths that geo-query does. Both NRP Ceph (`s3-west.nrp-nautilus.io`) and the source.coop bucket on AWS send CORS headers that allow any origin to make GET and range requests and to list a bucket. A glob such as `s3://public-wdpa/wdpa/hex/**` becomes an S3 ListObjects request, and DuckDB reads the `h0=` hive partitions from the paths. A plain `https://` server cannot list a directory, so globs need `s3://` paths. On WDPA's hex files (114 files, 4.6 GB in all) we measured:

| Query | Time | Requests | Data read |
|---|---|---|---|
| `glob()` over the 114 files | 0.1 s | 1 | the bucket listing |
| `count(*)` over all 114 files | 17–20 s | 323, at most 2 at once | 11.7 MB of footers |
| One `h0` partition, `count(DISTINCT h8)` | 10 s | 71, one at a time | 19.3 MB |
| `count(*)` of one file by `https://` URL | 0.3 s | 2–3 | 0.3 MB |

**The range requests run one at a time.** In every query we measured, no more than two requests were in flight. Native DuckDB issues these reads in parallel, and geo-query's server reads with 100 threads next to the data. In the browser, latency rather than bandwidth sets the speed of a scan. Filtering on `h0` reads only the matching partition, so a scoped query is quick, but a query that opens every partition of a global dataset pays a round trip per footer and per column chunk. That is why the server points the model at the California county files first.

**Limiting what the SQL can reach.** DuckDB's `allowed_directories` setting, combined with `enable_external_access = false` and `lock_configuration = true`, lets SQL read only the listed prefixes. A read from any other host, or from a look-alike host such as `s3-west.nrp-nautilus.io.example.org`, fails with a permission error, and the settings cannot be changed afterwards. We found three details in testing:

- Each entry is a directory, so `s3://public-wdpa/` allows that bucket but `s3://public-` allows nothing. The worker allows `s3://`, which reaches any bucket but only through the two endpoints its secrets name.
- Extensions cannot be autoloaded once external access is off, so parquet, json, httpfs, h3 and spatial have to be loaded before the lock.
- The lock does not cover secrets. `CREATE SECRET` still works, and a new secret could send an allowed `s3://` path to another endpoint. The worker therefore checks every query with `json_serialize_sql()`, which DuckDB refuses for anything but a SELECT statement, and runs only queries that pass. `DESCRIBE`, `SUMMARIZE` and FROM-first queries pass, while `SET`, `CREATE`, `ATTACH`, `COPY`, `INSTALL` and `PRAGMA` do not.

**Other limits from the documentation.**

- The data host must send CORS headers that allow the page's origin, for `GET` and `HEAD`. NRP and source.coop do.
- Every request is upgraded to HTTPS.
- HTTP authentication headers are not supported ([duckdb-wasm#1967](https://github.com/duckdb/duckdb-wasm/issues/1967)), so private buckets that need signed headers cannot be read directly.
- Range requests can fail on Firefox ([duckdb-wasm#1932](https://github.com/duckdb/duckdb-wasm/issues/1932)). Some S3 pre-signed URLs are not detected as supporting ranges ([duckdb-wasm#2228](https://github.com/duckdb/duckdb-wasm/issues/2228)), which forces a whole-file download.
- WebAssembly memory is capped at 4 GB, and browsers may allow less.
- DuckDB-wasm runs single-threaded unless the page is cross-origin isolated (COOP and COEP headers), which GitHub Pages does not provide. Multithreading is experimental.

## Limits of the prototype

- **Scans of global datasets are slow.** Reads are serial, as described above, and a query has no time limit, so a model that scans every partition of a large dataset can keep the user waiting for minutes. geo-query stops a query at 300 seconds.
- **Only the query and discovery tools are ported.** geo-query's `get_collection`, its hex map tiles, its per-request credentials for private buckets, and its full query guidance are not here. Results are capped at 200 rows, where geo-query shows 50.
- **DuckDB-wasm and its extensions come from jsDelivr and DuckDB's extension repositories** at start-up. An offline version would serve them from the same origin.
- **Answers are shown as plain text,** so markdown tables are not rendered.

## License

Apache-2.0. See [LICENSE](LICENSE) and [DISCLOSURE.md](DISCLOSURE.md).
