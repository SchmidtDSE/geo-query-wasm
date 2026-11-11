# geo-query-wasm

geo-query-wasm is [geo-query](https://github.com/SchmidtDSE/geo-query)'s MCP server running entirely in the browser. DuckDB-wasm runs in a Web Worker, and the worker serves geo-query's tools, resources and prompt over `postMessage` instead of HTTP. A client that works with geo-query works with it unchanged: the tool names, arguments, descriptions and output follow geo-query's, and the model-facing guidance is geo-query's own, fetched at a pinned commit. No server is involved. The worker is a set of static files, the data are public files on source.coop and NRP, and the user's questions go only to the language model endpoint the client uses.

- **Documentation:** https://schmidtdse.github.io/geo-query-wasm/docs/
- **Demo:** https://schmidtdse.github.io/geo-query-wasm/
- **Releases:** https://github.com/SchmidtDSE/geo-query-wasm/releases

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

## Using it from an app

Load the files from jsDelivr at a release tag, `https://cdn.jsdelivr.net/gh/SchmidtDSE/geo-query-wasm@v0.6.0/src/…`, or serve a copy from the app's own origin. A page starts `src/worker.js`, configures it with JSON in the worker URL's `config` parameter, and connects any MCP client over `postMessage`. An app that writes its own SQL can import `src/engine.js` into the page instead.

The documentation covers each part:

- [Quick start](https://schmidtdse.github.io/geo-query-wasm/docs/guide/quickstart.html) and [Configuration](https://schmidtdse.github.io/geo-query-wasm/docs/guide/configuration.html)
- [Parity with geo-query](https://schmidtdse.github.io/geo-query-wasm/docs/guide/parity.html)
- [Hex tiles](https://schmidtdse.github.io/geo-query-wasm/docs/guide/hex-tiles.html), [Zonal statistics](https://schmidtdse.github.io/geo-query-wasm/docs/guide/zonal-statistics.html) and [Private data](https://schmidtdse.github.io/geo-query-wasm/docs/guide/private-data.html)
- [Capabilities and limitations](https://schmidtdse.github.io/geo-query-wasm/docs/capabilities.html), with benchmarks against geo-query
- [Architecture](https://schmidtdse.github.io/geo-query-wasm/docs/guide/architecture.html), including DuckDB-wasm's extensions, remote reads and access limits
- [Development](https://schmidtdse.github.io/geo-query-wasm/docs/guide/development.html): the demo, the checks and the vendored code

The pages are written in `docs/`, and `pnpm docs:dev` serves them locally.

## Checks

`pnpm test` runs the unit tests, and `node scripts/e2e.mjs` runs the demo page in headless Chrome against the live catalogs and data on source.coop. CI runs both on every push. [Development](docs/guide/development.md) lists what each checks.

## License

Apache-2.0. See [LICENSE](LICENSE) and [DISCLOSURE.md](DISCLOSURE.md).
