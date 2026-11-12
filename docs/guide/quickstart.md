# Quick start

geo-query-wasm is [geo-query](https://github.com/SchmidtDSE/geo-query)'s MCP server running entirely in the browser. DuckDB-wasm runs in a Web Worker, and the worker serves geo-query's tools, resources and prompt over `postMessage` instead of HTTP. By default the worker reads the source.coop mirror of GLEN's catalog, which a browser reads much faster than NRP.

## Loading the files

Load the files from jsDelivr at a release tag or a commit, or serve a copy from the app's own origin:

```
https://cdn.jsdelivr.net/gh/SchmidtDSE/geo-query-wasm@v0.6.0/src/…
```

A page may start a Worker only from its own origin. An app that loads geo-query-wasm from jsDelivr therefore serves a one-line worker file of its own:

```js
// geo-query-worker.js, on the app's origin
import 'https://cdn.jsdelivr.net/gh/SchmidtDSE/geo-query-wasm@v0.6.0/src/worker.js';
```

## Connecting an MCP client

The page starts the worker and connects any MCP client over `postMessage`. The demo uses glen-harness's `MCPClient` and `PostMessageTransport`, loaded from jsDelivr:

```js
import { MCPClient, PostMessageTransport } from 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-harness@b808d616937e210fbb9cf9d9d071ba492b2342d6/src/index.js';

const worker = new Worker('./geo-query-worker.js', { type: 'module' });
const mcp = new MCPClient('worker:geo-query-wasm', {}, { transport: () => new PostMessageTransport(worker) });
await mcp.connect();

const answer = await mcp.callTool('query', {
    sql_query: "SELECT count(*) AS n FROM read_parquet('s3://us-west-2.opendata.source.coop/cboettig/padus/padus-4-1/combined/hex/h0=*/data_0.parquet') WHERE h0 = 576531121047601151",
});
```

An app built with a bundler can use the MCP SDK's `Client` instead, with `PostMessageTransport` from `src/transport.js` around the Worker.

DuckDB and its extensions load in about 4 seconds. The worker queues the client's first messages until DuckDB is ready.

## Configuring the worker

The app configures the worker through its URL, as JSON in a `config` parameter. [Configuration](./configuration) lists every option.

```js
const cfg = {
    workers: 2,
    discovery: false,
    instructions: 'Text for the MCP handshake.',
    rewrite: [{ from: 's3://public-', to: 's3://us-west-2.opendata.source.coop/cboettig/' }],
    fetchWhole: ['https://schmidtdse.github.io/my-app/'],
};
const worker = new Worker(`./geo-query-worker.js?config=${encodeURIComponent(JSON.stringify(cfg))}`, { type: 'module' });
```

The worker always locks its SQL to SELECT statements on the allowed directories, because a model may write it.

## Results for app code

With `format: "json"`, the `query` tool returns every row, with no row cap, as the JSON array that DuckDB's `to_json` writes. Cells with `|` or newlines come through intact, and geometry comes through as WKT text. The default, `format: "markdown"`, is geo-query's table of at most 50 rows, for a model.

## Using the engine without MCP

An app that writes its own SQL can import the engine into the page. `createEngine(options)` from `src/engine.js` returns these functions:

- `json(sql)` gives rows as `to_json` types them.
- `query(sql)` gives Arrow-typed rows, with 64-bit integers as BigInt.
- `arrow(sql)` gives the Arrow table itself, where geometry is WKB.
- `createTable(name, sql)` keeps a SELECT's result in one instance's memory, for later queries that pass that instance's index as `{ instance }`, as the hex tiles do.

```js
import { createEngine } from 'https://cdn.jsdelivr.net/gh/SchmidtDSE/geo-query-wasm@v0.6.0/src/engine.js';

const engine = createEngine({ workers: 2 });
const rows = await engine.json("SELECT 42 AS answer");
```

An app that writes its own SQL from fixed templates can pass `lock: false`, which leaves reads unrestricted unless it also gives `allowedDirectories`.

## The demo page

The [demo](https://schmidtdse.github.io/geo-query-wasm/) runs an agent against the worker. Enter an OpenAI-compatible endpoint, a model name and an API key, then **Start**. The key stays in the page's memory, and the endpoint and model name are remembered in the browser.

The demo gives the worker instructions about the [tpl-cities browser tile set](https://github.com/boettiger-lab/tpl-cities/blob/main/notes/in-browser.md), one small parquet file per California county for eight GLEN hex datasets. A browser reads one in under a second, whereas scans over the national hex files take many serial requests.
