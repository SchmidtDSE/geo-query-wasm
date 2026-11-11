# Development

## Running the demo locally

`index.html` runs an agent against the worker. Serve the repository as static files and open it:

```bash
python3 -m http.server 8000
# http://localhost:8000/
```

## Checks

- `pnpm test` runs the server over a `MessageChannel` with the MCP SDK's client, using a stub in place of DuckDB. It also tests the hex tiles' math, SQL and builds against geo-query's values, the STAC rendering against fixture collections and the Portolan fixture in `test/fixtures/portolan`, the guidance tiers, zonal statistics, and the engine's SQL planning and per-query secrets.
- `node scripts/e2e.mjs` runs the demo page in headless Chrome (`$CHROME`, a Chrome or Chromium on the PATH, or Playwright's download) against a scripted stand-in for the model, so no API key is needed. It reads the live catalogs and data on source.coop, which is faster from a browser than NRP and stays up when NRP is down; no check needs NRP. CI runs it on every push. It checks:
  - SQL globs and reads `s3://` paths, one `h0` partition of PAD-US and an `https://` URL, and calls h3 and spatial functions;
  - a full agent turn, geo-query's resources and prompt, `get_collection`, result formatting, per-query endpoints and refused credentials;
  - GLEN's catalog with its groups, and the St. Louis Portolan catalog, whose paths can only point at source.coop;
  - GeoParquet geometry read as GEOMETRY on both DuckDB builds;
  - a hex tileset built from one county's cells, a tile, its `metadata.json`, and the layer drawn with MapLibre;
  - `zonal_stats` on GHS-POP's ZSTD COG over the St. Louis wards against rasterio's total, and its refusal when the catalog lists a hex copy;
  - JSON results, a configured worker with two instances, a rewrite and whole-fetched files, and the engine imported into the page;
  - that SQL cannot read another host, change its settings, create a secret or attach a database.
- `node scripts/private-check.mjs` reads a private bucket in headless Chrome with keys sent by `sendSecrets()`. It checks that every read is signed and uses byte ranges, and that the keys never reach the model. It needs `PRIVATE_S3_ENDPOINT`, `PRIVATE_S3_KEY`, `PRIVATE_S3_SECRET` and `PRIVATE_S3_PATH`, and skips without them, so CI does not run it.
- `node scripts/duckdb-http-probe.mjs [httpfs|autoload|s3|locked]` measures the HTTP requests behind each query. [Architecture](./architecture) reports its results.
- `node scripts/benchmark.mjs` runs the benchmarks in [Capabilities and limitations](../capabilities) and rewrites its tables.

## Documentation

These pages are a VitePress site in `docs/`. `pnpm docs:dev` serves them locally, and `pnpm docs:build` builds them. The Pages workflow publishes them under the demo, at `/geo-query-wasm/docs/`.

## Vendored code

`vendor/mcp-server-sdk.js` is the server half of the MCP SDK 1.12.0, bundled by `pnpm run build:vendor`. CI regenerates it and fails if it differs from what is committed.

Development dependencies are installed with pnpm, which runs no dependency install scripts and installs no version less than a week old (`pnpm-workspace.yaml`).

## Releases

Releases are tagged on main, with notes on the [releases page](https://github.com/SchmidtDSE/geo-query-wasm/releases). The version is in `package.json` and in `VERSION` in `src/server.js`, which the server reports in the MCP handshake.
