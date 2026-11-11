# Architecture

```
page: any MCP client (the demo uses glen-harness)
        │  postMessage (MCP JSON-RPC)
        ▼
Web Worker (src/worker.js)
  MCP server (src/server.js): geo-query's tools, resources and prompt
        │                      │
        │                      ├── STAC JSON ◀── source.coop mirror (cboettig/glen/catalog.json)
        │                      └── guidance ◀── geo-query at a pinned commit, from jsDelivr
        ▼
  engine (src/engine.js)
  DuckDB-wasm, one or more instances, each in its own worker
        ◀── parquet byte ranges ◀── source.coop, NRP S3
```

- **The worker is the server's container.** Its only interface is `postMessage`, and a page talks to it only in MCP. This is the browser counterpart of geo-query in a Docker container behind a TCP port. `src/transport.js` implements the MCP SDK's transport interface over `postMessage`, for both ends.
- **The server depends only on the MCP SDK and DuckDB-wasm.** The server half of the MCP SDK is bundled into `vendor/mcp-server-sdk.js`, and DuckDB-wasm comes from jsDelivr at a pinned version. The demo page's agent, glen-harness, is a separate project that the page loads from jsDelivr at a pinned commit.
- **The worker reads S3 as geo-query does.** It loads httpfs, h3 and spatial, creates geo-query's anonymous S3 secrets for NRP Ceph and the source.coop bucket on AWS, and applies geo-query's settings. `s3://` paths, globs and `h0=` hive partitions work as they do on the server.
- **The SQL can read only the data hosts.** DuckDB's `allowed_directories` limits reads to `s3://` paths and to `https://` URLs on NRP and source.coop. The worker turns external access and extension loading off, locks the configuration, and runs only SELECT queries.
- **Hex tiles stay in the worker.** `register_hex_tiles` keeps its H3 pyramid as a table in DuckDB's memory, and the worker encodes each tile when the map asks for it (`src/hex.js`). The page passes the map's tile requests to the worker as MCP resource reads (`src/hex-protocol.js`).
- **The engine is a module of its own.** `src/engine.js` holds the DuckDB-wasm setup: start-up, extensions, secrets, settings, access limits, a pool of instances and row conversion. The worker serves MCP on it, and an app can import it into the page to run its own SQL without MCP framing.
- **The worker loads its dependencies at start-up.** DuckDB-wasm, its extensions and geo-query's guidance come from jsDelivr and DuckDB's extension repositories. An offline version would serve them from the same origin.

## DuckDB-wasm extensions and remote reads

We pin `@duckdb/duckdb-wasm@1.33.1-dev57.0`, which is DuckDB v1.5.4. The measurements below come from `scripts/duckdb-http-probe.mjs` in headless Chrome on 2026-11-06. [Capabilities and limitations](../capabilities) compares this build with a build of DuckDB 2.0 and explains the request headers the engine drops. The official documentation is the [DuckDB-wasm pages](https://duckdb.org/docs/stable/clients/wasm/overview) on duckdb.org, especially [Extensions](https://duckdb.org/docs/stable/clients/wasm/extensions) and [Troubleshoot](https://duckdb.org/docs/stable/clients/wasm/troubleshoot).

### Extensions

`LOAD httpfs;`, `INSTALL spatial; LOAD spatial;` and `INSTALL h3 FROM community; LOAD h3;` all work in this build. h3 is a community extension, so a bare `LOAD h3` fails. In DuckDB-wasm, `INSTALL` stores nothing, because the browser keeps no storage between sessions. `LOAD` fetches the extension's wasm build from DuckDB's extension repository each time the page starts. Core extensions are also autoloaded on first use, but not once external access is off.

### Loading httpfs

DuckDB-wasm has two HTTP paths, and they read remote files very differently, so the engine loads httpfs explicitly. On a 1 GB CHELSA hex parquet on source.coop with 3,780 row groups:

| Query on the 1 GB file | Without `LOAD httpfs` | With `LOAD httpfs` |
|---|---|---|
| First read (`count(*)`) | 1 plain GET of the whole file, 1,013 MB, 28 s | 2 range GETs of the footer, 0.3 MB, 1 s |
| `avg()` of one column over all rows | served from the downloaded copy | 64 range GETs, 18 MB, 10 s |
| One row selected by a filter on `h8` | served from the downloaded copy | 1 range GET, 0.08 MB |

Without the explicit `LOAD`, DuckDB-wasm's built-in HTTP file system sends a GET with no `Range` header, so the browser downloads the whole file. This is open issue [duckdb-wasm#2153](https://github.com/duckdb/duckdb-wasm/issues/2153), and a maintainer's workaround there is to run `LOAD httpfs` first. With httpfs loaded, DuckDB-wasm reads parquet the way native DuckDB does. It reads the footer, fetches only the column chunks a query needs, and skips row groups whose min/max statistics rule them out. A selective filter on a sorted column such as an H3 index therefore reads a tiny part of the file.

### S3 paths and globs

With an anonymous S3 secret, DuckDB-wasm reads the same `s3://` paths that geo-query does. Both NRP Ceph (`s3-west.nrp-nautilus.io`) and the source.coop bucket on AWS send CORS headers that allow any origin to make GET and range requests and to list a bucket. A glob such as `s3://public-wdpa/wdpa/hex/**` becomes an S3 ListObjects request, and DuckDB reads the `h0=` hive partitions from the paths. A plain `https://` server cannot list a directory, so globs need `s3://` paths. On WDPA's hex files (114 files, 4.6 GB in all) we measured:

| Query | Time | Requests | Data read |
|---|---|---|---|
| `glob()` over the 114 files | 0.1 s | 1 | the bucket listing |
| `count(*)` over all 114 files | 17–20 s | 323, at most 2 at once | 11.7 MB of footers |
| One `h0` partition, `count(DISTINCT h8)` | 10 s | 71, one at a time | 19.3 MB |
| `count(*)` of one file by `https://` URL | 0.3 s | 2–3 | 0.3 MB |

### Serial range requests

In every query we measured, no more than two requests were in flight. Native DuckDB issues these reads in parallel, and geo-query's server reads with 100 threads next to the data. In the browser, latency rather than bandwidth sets the speed of a scan. Filtering on `h0` reads only the matching partition, so a scoped query is quick, but a query that opens every partition of a global dataset pays a round trip per footer and per column chunk. That is why the demo page points the model at the California county files first.

### Access limits

DuckDB's `allowed_directories` setting, combined with `enable_external_access = false` and `lock_configuration = true`, lets SQL read only the listed prefixes. A read from any other host, or from a look-alike host such as `s3-west.nrp-nautilus.io.example.org`, fails with a permission error, and the settings cannot be changed afterwards. We found three details in testing:

- Each entry is a directory, so `s3://public-wdpa/` allows that bucket but `s3://public-` allows nothing. The worker allows `s3://`, which reaches any bucket but only through the endpoints its secrets name. A query's own `s3_endpoint` must be on the allow-list (`allowedEndpoints`).
- Extensions cannot be autoloaded once external access is off, so parquet, json, httpfs, h3 and spatial have to be loaded before the lock.
- The lock does not cover secrets. `CREATE SECRET` still works, and a new secret could send an allowed `s3://` path to another endpoint. The worker therefore checks every query with `json_serialize_sql()`, which DuckDB refuses for anything but a SELECT statement, and runs only queries that pass. `DESCRIBE`, `SUMMARIZE` and FROM-first queries pass, while `SET`, `CREATE`, `ATTACH`, `COPY`, `INSTALL` and `PRAGMA` do not.

### Other limits

- The data host must send CORS headers that allow the page's origin, for `GET` and `HEAD`. NRP and source.coop do.
- Every request is upgraded to HTTPS.
- DuckDB-wasm's built-in HTTP reader sends no authentication headers ([duckdb-wasm#1967](https://github.com/duckdb/duckdb-wasm/issues/1967)). The engine does not use that reader. With httpfs loaded, an S3 secret with a key and secret signs every request ([Private data](./private-data)).
- Range requests can fail on Firefox ([duckdb-wasm#1932](https://github.com/duckdb/duckdb-wasm/issues/1932)). Some S3 pre-signed URLs are not detected as supporting ranges ([duckdb-wasm#2228](https://github.com/duckdb/duckdb-wasm/issues/2228)), which forces a whole-file download.
- WebAssembly memory is capped at 4 GB, and browsers may allow less. With the DuckDB 2.0 build, an aggregate or sort that needs more than `memory_limit` spills to buffers outside the WebAssembly heap instead of failing.
- DuckDB-wasm runs single-threaded unless the page is cross-origin isolated (COOP and COEP headers), which GitHub Pages does not provide. Multithreading is experimental.
