# geo-query-wasm

geo-query-wasm is [geo-query](https://github.com/SchmidtDSE/geo-query)'s MCP server running entirely in the browser. DuckDB-wasm runs in a Web Worker, and the worker serves geo-query's tools, resources and prompt over `postMessage` instead of HTTP. A client that works with geo-query works with it unchanged: the tool names, arguments, descriptions and output follow geo-query's, and the model-facing guidance is geo-query's own, fetched at a pinned commit. No server is involved. The worker is a set of static files, the data are public files on source.coop and NRP, and the user's questions go only to the language model endpoint the client uses. By default the worker reads the source.coop mirror of GLEN's catalog, which a browser reads much faster than NRP.

## Architecture

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
- **The SQL can read only the data hosts.** DuckDB's `allowed_directories` limits reads to `s3://` paths and to `https://` URLs on NRP and source.coop. The worker turns external access and extension loading off, locks the configuration, and runs only SELECT queries. The details are in the DuckDB-wasm section below.
- **Hex tiles stay in the worker.** `register_hex_tiles` keeps its H3 pyramid as a table in DuckDB's memory, and the worker encodes each tile as MVT with DuckDB's `ST_AsMVT` when the map asks for it (`src/hex.js`). The page passes the map's tile requests to the worker as MCP resource reads (`src/hex-protocol.js`).
- **The engine is a module of its own.** `src/engine.js` holds the DuckDB-wasm setup: start-up, extensions, secrets, settings, access limits, a pool of instances and row conversion. The worker serves MCP on it, and an app can import it into the page to run its own SQL without MCP framing.

## Parity with geo-query

We compared geo-query at commit `222cecf` ([server.py](https://github.com/SchmidtDSE/geo-query/blob/222cecfd964438c82547c15a8069a85f86b8fa4c/server.py), [stac.py](https://github.com/SchmidtDSE/geo-query/blob/222cecfd964438c82547c15a8069a85f86b8fa4c/stac.py)).

| geo-query feature | geo-query-wasm |
|---|---|
| `browse_stac_catalog`, with an inline `catalog` | Same markdown |
| `get_stac_details`, with an inline `collection` | Same markdown |
| `get_collection`, with an inline `collection` | Same JSON, with `s3://` hrefs, routing hints and nested children, which round-trip into `collection` |
| `query` with `sql_query` or `sql` | Same arguments and errors. Adds `format: "json"` for app code. |
| Results as a markdown table of 50 rows | Same truncation note, "No results found.", 64-bit integers in full, floats to 10 significant figures, dates as `YYYY-MM-DD`, NULL as an empty cell |
| `s3_endpoint`, `s3_scope`, `s3_region`, `s3_url_style` for an anonymous source | Same per-query secret and endpoint allow-list |
| `s3_key` and `s3_secret` for a private bucket | Refused as query arguments, because the model writes them. The page sends keys with `sendSecrets()`, and the SQL reads the bucket through `s3://` paths (see Private data). |
| `catalog://list` and `catalog://{dataset_id}` resources | Same |
| `geospatial-analyst` prompt | Same text (`assistant-role.md`) |
| `query` description with `query-optimization.md` and `h3-guide.md` | The same files at a pinned commit, with `tier=extra` sections dropped unless `extraInstructions` is set, plus a section on the browser |
| `STAC_CATALOG_URL`, `STAC_DISCOVERY`, `EXTRA_INSTRUCTIONS` | `catalog`, `discovery` and `extraInstructions` in the worker's configuration. The default catalog is the source.coop mirror, where geo-query's is NRP's. |
| Locked DuckDB configuration | Locked, and also SELECT only, because the lock does not cover secrets |
| `register_hex_tiles` and `get_hex_tile_status` | Same arguments, statuses and responses. The pyramid is a table in the worker's memory, not parquet in object storage, and the tile URL is `geoquerywasm://tiles/hex/<hash>/{z}/{x}/{y}.pbf` (below). |
| MVT tiles and `metadata.json` from `/tiles` over HTTP | MCP resources at the same paths under `geoquerywasm://`. `metadata.json` adds `cell_counts`, the cells at each level. |
| The H3 level a zoom serves, from the data's extent and an estimate of each level's cells | From the extent and each level's real cell count, and no finer than hexes with edges of 3 pixels (`minEdgePx` in `createHexTiles`). See below. |
| Bearer-token auth, `/healthz`, `/version` | Not applicable in a browser |

The server reports itself as `geo-query-wasm` in the MCP handshake. geo-query sends no server instructions, and neither does this server unless an app configures them.

## Using geo-query-wasm from an app

Load the files from jsDelivr at a pinned commit, `https://cdn.jsdelivr.net/gh/SchmidtDSE/geo-query-wasm@<commit>/src/…`, or serve a copy from the app's own origin.

**Over MCP, from a worker.** The page starts `src/worker.js` and connects any MCP client over `postMessage`: the MCP SDK's `Client` with `PostMessageTransport` from `src/transport.js`, or glen-harness's `MCPClient` and `PostMessageTransport`, as the demo does. The app configures the worker through its URL, as JSON in a `config` parameter:

```js
const cfg = {
    workers: 2,
    discovery: false,
    instructions: 'Text for the MCP handshake.',
    rewrite: [{ from: 's3://public-', to: 's3://us-west-2.opendata.source.coop/cboettig/' }],
    fetchWhole: ['https://schmidtdse.github.io/my-app/'],
};
const worker = new Worker(`${BASE}/src/worker.js?config=${encodeURIComponent(JSON.stringify(cfg))}`, { type: 'module' });
```

With `format: "json"`, the `query` tool returns every row, with no row cap, as the JSON array that DuckDB's `to_json` writes, so cells with `|` or newlines come through intact. The worker always locks its SQL to SELECT statements on the allowed directories, because a model may write it.

**Hex tiles on a map.** `register_hex_tiles` returns a tile URL such as `geoquerywasm://tiles/hex/<hash>/{z}/{x}/{y}.pbf`, with geo-query's paths, so a client that reads the hash or the `metadata.json` URL from a tile URL finds them. The worker serves each tile and each tileset's `metadata.json` as an MCP resource at its URL. The page registers the scheme with MapLibre GL JS (version 4 or later), and can read the metadata with a `fetch` that knows the scheme:

```js
import { addHexTileProtocol, hexFetch } from 'https://cdn.jsdelivr.net/gh/SchmidtDSE/geo-query-wasm@<commit>/src/hex-protocol.js';
addHexTileProtocol(maplibregl, client);  // client: the MCP SDK's Client, or glen-harness's MCPClient
const meta = await (await hexFetch(client)(metadataUrl)).json();
```

glen's map client (`add_hex_tile_layer`) needs both: MapLibre fetches the tiles through the protocol, and the client fetches `metadata.json` with the page's `fetch`, which an app can replace with `hexFetch(client)`. A tile with no cells is empty, where geo-query answers 204.

**In the page, without MCP.** `createEngine(options)` from `src/engine.js` returns `json(sql)`, which gives rows as `to_json` types them, and `query(sql)`, which gives Arrow-typed rows with 64-bit integers as BigInt. `arrow(sql)` gives the Arrow table itself, and `createTable(name, sql)` keeps a SELECT's result in one instance's memory for later queries that pass that instance's index as `{ instance }`, as the hex tiles do. An app that writes its own SQL from fixed templates can pass `lock: false`, which leaves reads unrestricted unless it also gives `allowedDirectories`. glen-charts' wasm engine can use the engine this way ([glen-charts#28](https://github.com/SchmidtDSE/glen-charts/issues/28)).

The worker's own options:

| Option | Default | Use |
|---|---|---|
| `catalog` | The source.coop mirror of GLEN's catalog | STAC catalog URL, as `STAC_CATALOG_URL`. The mirror lists the license-clear collections, about 30, and a browser reads it much faster than NRP. NRP's canonical catalog, with about 80, is `NRP_CATALOG_URL` in `src/stac.js`. |
| `discovery` | true | false hides `browse_stac_catalog` and `catalog://list`, as `STAC_DISCOVERY=0` |
| `extraInstructions` | false | true keeps the guidance meant for small models, as `EXTRA_INSTRUCTIONS` |
| `guidanceRef` | `222cecf` | geo-query commit to take the guidance from |
| `instructions` | none | Server instructions for the MCP handshake |
| `maxTilesets` | 8 | Hex tilesets kept in memory. Beyond this, the least recently used is dropped, and its tile URL stops working. |

The engine's options, with the defaults in `src/defaults.js`, which the worker also takes:

| Option | Default | Use |
|---|---|---|
| `timeout` | 600 | Seconds a query may run before it is cancelled, twice geo-query's limit because reads in the browser are serial. `null` or `0` turns the limit off. Time spent waiting behind other queries does not count. |
| `workers` | 1 | DuckDB instances. Each runs one query at a time and reads one or two byte ranges at a time, so a page that sends several queries at once gains from more. A query goes to the least busy instance. |
| `secrets` | NRP Ceph, and source.coop on AWS | Anonymous S3 secrets: `{ name, scope, endpoint, region, url_style, use_ssl }`. |
| `allowedEndpoints` | NRP Ceph and the lab MinIO | S3 hosts a query's `s3_endpoint` may name, beyond the secrets' endpoints and AWS S3 hosts. |
| `rewrite` | none | `{ from, to }` text swapped in the SQL before it runs, such as an NRP prefix for its source.coop mirror. A URL that matches `fetchWhole` before or after the rewrites is fetched whole, so a rewrite never turns a whole-file fetch into range reads. |
| `fetchWhole` | none | URL prefixes whose `.parquet` files are fetched whole with `fetch()`, in parallel, and read from memory. GitHub Pages gzips responses and applies byte ranges to the compressed stream, which breaks DuckDB's range reads, so an app's own parquet on Pages needs this. |
| `settings` | geo-query's `preserve_insertion_order` and `disabled_optimizers` | DuckDB settings, merged over the defaults, so an app that adds one keeps the rest. A value of `null` leaves a default unset. |
| `allowedDirectories` | `s3://`, NRP and source.coop over https | The only places SQL may read. |
| `lock` | true | External access and extension loading off, configuration locked, SELECT only. The worker always sets it. |
| `duckdb` | `1.33.1-dev57.0` | The DuckDB-wasm version on jsDelivr. `1.33.1-dev114.0` is a build of DuckDB 2.0 that spills large aggregates and sorts; [docs/capabilities.md](docs/capabilities.md) compares the two. |

Rewrites are applied, and whole-fetch files substituted, before the SELECT check, so the check covers the SQL that runs. glen-charts also sets `s3_allow_recursive_globbing = false`. It is not a default here, because the checks glob with `**`; an app can set it in `settings`.

## Demo page

`index.html` runs an agent against the worker. Serve the repository as static files and open it:

```bash
python3 -m http.server 8000
# http://localhost:8000/
```

Enter an OpenAI-compatible endpoint, a model name and an API key, then **Start**. DuckDB and its extensions load in about 4 seconds. The key stays in the page's memory; the endpoint and model name are remembered in the browser. The page gives the worker instructions about the [tpl-cities browser tile set](https://github.com/boettiger-lab/tpl-cities/blob/main/notes/in-browser.md), one small parquet file per California county for eight GLEN hex datasets (`src/california.js`). A browser reads one in under a second, whereas scans over the national hex files take many serial requests.

## Checks

- `pnpm test` runs the server over a `MessageChannel` with the MCP SDK's client, using a stub in place of DuckDB. It also tests the hex tiles' math, SQL and builds against geo-query's values, the STAC rendering against fixture collections, the guidance tiers, and the engine's SQL planning and per-query secrets.
- `node scripts/e2e.mjs` runs the demo page in headless Chrome (`$CHROME`, a Chrome or Chromium on the PATH, or Playwright's download) against a scripted stand-in for the model, so no API key is needed. It reads the live catalog and data on the source.coop mirror, which is faster from a browser than NRP and stays up when NRP is down; no check needs NRP. It checks that SQL can glob and read `s3://` paths, read one `h0` partition of PAD-US, read an `https://` URL, and call h3 and spatial functions. It runs a full agent turn, and checks geo-query's resources, prompt, `get_collection`, result formatting, per-query endpoints and refused credentials. It builds a hex tileset from one county's cells, reads a tile and its `metadata.json`, and draws the layer with MapLibre through the `geoquerywasm:` protocol. It also checks JSON results, a configured worker with two instances, a rewrite and whole-fetched files, and the engine imported into the page. Last, it checks that SQL cannot read another host, change its settings, create a secret or attach a database. CI runs it on every push.
- `node scripts/private-check.mjs` reads a private bucket in headless Chrome with keys sent by `sendSecrets()`. It checks that every read is signed and uses byte ranges, and that the keys never reach the model: the `query` schema has no key arguments, keys passed by the model or put in the worker URL are refused, `duckdb_secrets()` is refused, and no MCP message contains them. It needs `PRIVATE_S3_ENDPOINT`, `PRIVATE_S3_KEY`, `PRIVATE_S3_SECRET` and `PRIVATE_S3_PATH`, and skips without them, so CI does not run it.
- `node scripts/duckdb-http-probe.mjs [httpfs|autoload|s3|locked]` measures the HTTP requests behind each query. The DuckDB-wasm section below reports its results.

## Vendored code

`vendor/mcp-server-sdk.js` is the server half of the MCP SDK 1.12.0, bundled by `pnpm run build:vendor`. CI regenerates it and fails if it differs from what is committed. Development dependencies are installed with pnpm, which runs no dependency install scripts and installs no version less than a week old (`pnpm-workspace.yaml`).

## DuckDB-wasm extensions and remote reads

We pin `@duckdb/duckdb-wasm@1.33.1-dev57.0`, which is DuckDB v1.5.4. The measurements below come from `scripts/duckdb-http-probe.mjs` in headless Chrome on 2026-11-06. [docs/capabilities.md](docs/capabilities.md) compares this build with a build of DuckDB 2.0 and explains the request headers the engine drops. The official documentation is the [DuckDB-wasm pages](https://duckdb.org/docs/stable/clients/wasm/overview) on duckdb.org, especially [Extensions](https://duckdb.org/docs/stable/clients/wasm/extensions) and [Troubleshoot](https://duckdb.org/docs/stable/clients/wasm/troubleshoot).

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

**The range requests run one at a time.** In every query we measured, no more than two requests were in flight. Native DuckDB issues these reads in parallel, and geo-query's server reads with 100 threads next to the data. In the browser, latency rather than bandwidth sets the speed of a scan. Filtering on `h0` reads only the matching partition, so a scoped query is quick, but a query that opens every partition of a global dataset pays a round trip per footer and per column chunk. That is why the demo page points the model at the California county files first.

**Limiting what the SQL can reach.** DuckDB's `allowed_directories` setting, combined with `enable_external_access = false` and `lock_configuration = true`, lets SQL read only the listed prefixes. A read from any other host, or from a look-alike host such as `s3-west.nrp-nautilus.io.example.org`, fails with a permission error, and the settings cannot be changed afterwards. We found three details in testing:

- Each entry is a directory, so `s3://public-wdpa/` allows that bucket but `s3://public-` allows nothing. The worker allows `s3://`, which reaches any bucket but only through the endpoints its secrets name. A query's own `s3_endpoint` must be on the allow-list (`allowedEndpoints`).
- Extensions cannot be autoloaded once external access is off, so parquet, json, httpfs, h3 and spatial have to be loaded before the lock.
- The lock does not cover secrets. `CREATE SECRET` still works, and a new secret could send an allowed `s3://` path to another endpoint. The worker therefore checks every query with `json_serialize_sql()`, which DuckDB refuses for anything but a SELECT statement, and runs only queries that pass. `DESCRIBE`, `SUMMARIZE` and FROM-first queries pass, while `SET`, `CREATE`, `ATTACH`, `COPY`, `INSTALL` and `PRAGMA` do not.

**Other limits from the documentation.**

- The data host must send CORS headers that allow the page's origin, for `GET` and `HEAD`. NRP and source.coop do.
- Every request is upgraded to HTTPS.
- DuckDB-wasm's built-in HTTP reader sends no authentication headers ([duckdb-wasm#1967](https://github.com/duckdb/duckdb-wasm/issues/1967)). The engine does not use that reader. With httpfs loaded, an S3 secret with a key and secret signs every request (see Private data).
- Range requests can fail on Firefox ([duckdb-wasm#1932](https://github.com/duckdb/duckdb-wasm/issues/1932)). Some S3 pre-signed URLs are not detected as supporting ranges ([duckdb-wasm#2228](https://github.com/duckdb/duckdb-wasm/issues/2228)), which forces a whole-file download.
- WebAssembly memory is capped at 4 GB, and browsers may allow less. With the DuckDB 2.0 build, an aggregate or sort that needs more than `memory_limit` spills to buffers outside the WebAssembly heap instead of failing.
- DuckDB-wasm runs single-threaded unless the page is cross-origin isolated (COOP and COEP headers), which GitHub Pages does not provide. Multithreading is experimental.

## Limitations

[docs/capabilities.md](docs/capabilities.md) is the guide for deciding which queries to run in the browser.

- **Scans of global datasets are slow.** Reads are serial, as described above, so a query that scans every partition of a large dataset can take minutes. A query stops after 600 seconds, twice geo-query's limit (the `timeout` option). [docs/capabilities.md](docs/capabilities.md) lists which queries run well in the browser, with benchmarks against geo-query.
- **Private buckets need keys from the page and CORS rules on the bucket.** The page sends the keys with `sendSecrets()`; the model cannot pass them. The bucket must allow the page's origin and the signing headers (see Private data).
- **Hex tiles are coarser than geo-query's at low and middle zooms.** Each tile is made on request, at about 0.25 ms per hex in DuckDB-wasm, and a DuckDB instance makes one tile at a time. Two rules keep tiles small. First, the level for a zoom uses each level's real cell count: geo-query's estimate assumes seven cells roll up into one, and scattered data, such as a million points over the globe, then got a 33 MB tile at zoom 0 that took a minute to make; with the real counts it is 240 KB in half a second. Second, a hex's edge is at least 3 pixels long at the latitude in the data's bounds nearest the equator; finer levels draw specks rather than hexes. On 5.75 million res-10 cells in five southern California counties, a 1280×800 view filled in 0.8, 1.0 and 1.0 s at zooms 7, 10 and 13, at res 6, 8 and 10. geo-query's rule served res 7, 9 and 10, 17,500 and 32,600 hexes at zooms 7 and 10, and took 1.9 and 3.5 s.
- **Hex tilesets last as long as the worker, and must fit in its memory.** A tileset is a table in one DuckDB instance; a page reload, or `maxTilesets` newer ones, removes it. WebAssembly memory is capped at 4 GB. In headless Chrome, the five counties' 5.75 million cells took 12.5 s to register: 7 s to read the parquet and the rest to build the levels and each cell's centre. A pyramid from 3 million synthetic cells held about 1 GB. A build waits behind the queries before it on its DuckDB instance, and tile requests for that tileset go to the same instance, so with one instance they also wait behind queries.
- **DuckDB-wasm, its extensions and geo-query's guidance come from jsDelivr and DuckDB's extension repositories** at start-up. An offline version would serve them from the same origin.

## Private data

With httpfs loaded, DuckDB-wasm signs S3 requests and reads private objects with byte ranges, as native DuckDB does. An S3 secret with a key and secret signs each request with AWS Signature Version 4. We measured this on 2026-11-09 against a private bucket on the lab MinIO, with both the DuckDB 1.5.4 and 2.0 builds. Every request carried an `AWS4-HMAC-SHA256` signature, `count(*)` over a 144 MB parquet file read 0.26 MB, and a glob listed the bucket. Without keys the same file returned 403. The older finding that DuckDB-wasm sends no signature describes its built-in HTTP reader, which the engine never uses because it loads httpfs.

**Keys come from the page.** A user enters their own keys to their own bucket in the page, as they enter their own language model key, and the page sends them to the worker:

```js
import { sendSecrets } from 'https://cdn.jsdelivr.net/gh/SchmidtDSE/geo-query-wasm@<commit>/src/secrets.js';
await sendSecrets(worker, [{ scope: 's3://my-bucket', endpoint: 'minio.example.org', key, secret }]);
```

The worker makes each one a DuckDB S3 secret on every instance, and the SQL then reads the bucket through ordinary `s3://` paths. A secret with the name of an earlier one replaces it. A page that imports the engine itself passes `secrets` with keys to `createEngine()`, or calls `engine.setSecrets()`.

**The model never sees the keys.** The worker keeps them out of everything that reaches the language model.

- The `query` tool has no `s3_key` or `s3_secret` argument, and a call that passes them is refused. Keys in a tool call would have passed through the model and would stay in the conversation it is sent.
- Keys are not accepted in the worker's URL configuration, because that URL is sent to the server that serves `worker.js`.
- The SQL cannot read `duckdb_secrets()` or `which_secret()`.
- Error text has each key and secret replaced by `[REDACTED]`, because an S3 error can repeat the request's key ID.

`scripts/private-check.mjs` checks each of these in headless Chrome against a private bucket named in its environment.

**The bucket needs CORS rules.** It must allow the page's origin for `GET` and `HEAD`, allow the request headers `Authorization`, `x-amz-content-sha256` and `x-amz-date`, and expose `ETag`, `Content-Length`, `Content-Range` and `Accept-Ranges`. The lab MinIO already does. An AWS bucket has no CORS rules until its owner adds them.

**Conditions.**

- We have read a private bucket on MinIO. AWS S3 checks the same signature, and a read on AWS with made-up keys was signed and refused with 403, but we have not yet read a private AWS bucket.
- Signed reads cost a little more than public ones. `Authorization` is not a header a browser sends without asking, so each range read needs a CORS preflight whenever the browser's cached answer for that file has lapsed. A bucket that sends a long `Access-Control-Max-Age` avoids most of them.
- The keys live in the page's memory, like the language model key, so any script the page loads could read them. Users should give read-only keys limited to the bucket in question.
- An app's own keys do not belong in the page. Every user would receive them, and revoking them would cut off every user at once. Data that the app operator holds should stay behind a server: geo-query with credentials of its own, or a proxy on the app's origin behind its sign-in.

## License

Apache-2.0. See [LICENSE](LICENSE) and [DISCLOSURE.md](DISCLOSURE.md).
