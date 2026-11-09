# Capabilities and limitations

This page is for app authors deciding which of their queries can run in the browser on geo-query-wasm and which should stay on geo-query. The numbers come from `scripts/benchmark.mjs`, which anyone can re-run. The measurements behind each claim are in the [README](../README.md#duckdb-wasm-extensions-and-remote-reads).

## Browser constraints

Four properties of DuckDB-wasm set which queries run well.

- **Remote reads run one at a time.** Each footer and column chunk is a separate HTTP range request, and DuckDB-wasm sends them serially, with at most two in flight. Native DuckDB reads in parallel, and geo-query runs next to the data with many threads. In the browser the number of requests, times the time each takes, sets the time of a query. In the benchmarks below a request to source.coop took about 70 ms, so a query that sends 1,000 requests takes over a minute however few bytes it reads.
- **The page runs on one thread.** DuckDB-wasm is single-threaded unless the page is cross-origin isolated (COOP and COEP headers), which GitHub Pages cannot provide.
- **Memory is capped.** WebAssembly memory stops at 4 GB, and DuckDB's default `memory_limit` in the browser is 3.1 GiB. With the default build (DuckDB 1.5.4) a query that needs more fails with "Out of Memory", because there is no disk to spill to. Most of the benchmark queries peaked at 0.5 to 0.7 GB for the whole tab, but the Alpine County panel below peaked at 3.9 GB, so a page that runs such queries together can reach the cap. The DuckDB 2.0 build spills large aggregates and sorts, but not every operator (see DuckDB 2.0 below).
- **Private data needs keys from the page.** With httpfs, DuckDB-wasm signs S3 requests, so a private bucket reads with byte ranges like a public one once the page sends a user's keys with `sendSecrets()`. The bucket must allow the page's origin and the signing headers in its CORS rules. The README's Private data section has the details.

## Suitable queries

These queries run in seconds in the browser.

- **Reads scoped to one `h0` partition or one small file.** A filter on `h0` skips every other partition, so the query opens one file.
- **Filters on a column the file is sorted by.** DuckDB skips row groups whose min/max statistics rule them out. A file sorted by an H3 column answers a lookup on that column with a few requests.
- **Globs over `s3://` paths.** A glob is one bucket listing.
- **Hex tile pyramids of a few million cells.** The README's Limitations section gives build times.

## Unsuitable queries

These queries take a minute or more in the browser, or fail.

- **Scans of every partition of a national or global dataset.** Each partition costs a footer read and a request per column chunk, so time grows with the number of files and row groups.
- **Lookups on a column the file is not sorted by.** GLEN's hex files are ordered by feature, so a filter on `h8` or `h10` within a partition still reads most of that partition's index column. The PAD-US point lookup below takes 8 seconds and 132 requests to return one row.
- **Joins of two large hex datasets.** Both sides are read in full before the join, and the hash table has to fit in memory.

## Alternatives

- **Small per-region files.** tpl-cities writes one parquet file per county with only the columns its SQL uses, and the client reads the files for the place a user picks. A county profile of 21 queries fell from 11.5 minutes to between 2 and 11 seconds (tpl-cities `notes/in-browser.md`).
- **Precomputed results.** Statewide and per-jurisdiction values that every visitor sees can be computed once on geo-query and published as JSON.
- **geo-query for the rest.** An app can send the queries that scan national data to geo-query and run the scoped ones in the browser.

## Time limit

A query stops after 600 seconds by default, twice geo-query's 300-second limit because reads in the browser are serial, with an error that tells the model to filter on `h0` or read fewer columns. The engine sends each query with `conn.send()` and cancels it with `cancelSent()`, which in Chrome stops a query within 0.2 seconds, even during a remote scan, and leaves the connection usable. An app sets the limit with the engine's `timeout` option, in seconds, and `null` or `0` turns it off.

## Request headers

The engine drops two headers from DuckDB's requests, in a few lines that run in DuckDB's worker before its script (`WORKER_SHIM` in `src/engine.js`).

- **X-Host-Override.** duckdb-wasm renames DuckDB's `Host` header to `X-Host-Override` and sends it with every request. The browser sets `Host` itself, and the request's signature, when it has one, covers that `Host`, so the header does nothing. Signed reads of a private bucket work with it dropped. As a custom header, though, it makes every range read a CORS request that needs a preflight, an OPTIONS round trip before the GET, whenever Chrome's cached preflight for that file has lapsed. AWS S3 sends no `Access-Control-Max-Age`, so on source.coop a preflight is cached for 5 seconds. In the national PAD-US scan, dropping the header removed about 25 preflights from about 650 requests, which is within the noise of the timings.
- **If-Match.** DuckDB 2.0's httpfs sends `If-Match` with the file's ETag, and duckdb-wasm passes header values through `encodeURI()`. The ETag's quotes go out as `%22`, S3 answers 412 Precondition Failed, and every remote read fails with "ETag … changed after it was opened". DuckDB 1.5.4 never sent the header.

`scripts/duckdb-http-probe.mjs etag` with `HEADER_SHIM=none` shows the 412s on the DuckDB 2.0 build.

## DuckDB 2.0

The default build is DuckDB 1.5.4 (`@duckdb/duckdb-wasm` 1.33.1-dev57.0). An app can choose a build of DuckDB 2.0 with the engine's `duckdb` option (`1.33.1-dev114.0`, npm tag `next`, exported as `DUCKDB_WASM_2` from `src/defaults.js`). It loads httpfs, h3 and spatial as the 1.5.4 build does. It spills to buffers outside the WebAssembly heap when an aggregate or sort needs more than `memory_limit`: at a 256 MB limit, a GROUP BY with 20 million groups finished in 8 seconds, where 1.5.4 failed at once.

It is not the default, because a planner regression makes it fail a query that 1.5.4 runs ([duckdb/duckdb#28218](https://github.com/duckdb/duckdb/issues/28218)). DuckDB 1.5.4 computes a subquery that a query uses twice only once, as a common subplan, and reuses the result. DuckDB 2.0 does not extract that common subplan when the subquery reads parquet files, so it computes the subquery once per reference. The 30x30 Explorer's land panel (Alpine County, Managed by State, in the benchmarks) uses one such subquery twice, and each copy builds a hash table over 25.6 million ecoregion cells. DuckDB 2.0 holds both hash tables at once, and on one thread they exceed the 3.1 GiB `memory_limit`, so the query stops with "Out of Memory". Native DuckDB reproduces this: with `threads = 1` and `memory_limit = '3.1GiB'`, 2.0.0 fails and 1.5.4 finishes with a peak resident memory of 2.9 GB, and 2.0.0 also finishes with `threads = 4`. DuckDB-wasm runs on one thread and cannot raise the limit, so in the browser the 2.0 build always fails this query.

DuckDB 2.0's asynchronous parquet reads are off in the browser. duckdb-wasm sets `async_threads = 0`, because its threads come from a fixed pool that the blocked main thread cannot grow, so reads stay serial.

## Benchmarks

Each query runs on a fresh engine in a new headless Chrome profile, so nothing is cached from an earlier query, and reads the source.coop mirror as an app would. The same SQL then runs on geo-query, which reads the same files from its own mirror, and the two results are compared. "Peak memory" is the peak resident memory of the page's renderer process, which holds the page and DuckDB's workers, WebAssembly memory included (`VmHWM`, Linux only). About 0.5 GB of it is DuckDB-wasm and its extensions before any query runs. Chrome's `Runtime.getHeapUsage`, which earlier versions of this page used, leaves WebAssembly memory out and understated every query.

```
GEO_QUERY_TOKEN=… node scripts/benchmark.mjs 1.33.1-dev57.0 1.33.1-dev114.0
```

The script writes `bench/results.json` and rewrites the tables below; `--table` rewrites them from the saved results alone. The SQL names NRP's buckets, as geo-query's catalog does, and the browser reads the same paths on source.coop. The queries are:

- **Point lookup in PAD-US.** The PAD-US units in the res-8 cell over Yosemite Valley, filtered on `h0` and `h8`.
- **One PAD-US partition.** PAD-US cells by manager type in the `h0` partition that holds most of California.
- **National PAD-US scan.** PAD-US rows by GAP status, over all 49 million rows in 23 files.
- **Statewide 30x30 scan.** California's 2025 conserved-area cells by manager level, over 13 million rows.
- **County cells from national tracts.** Alpine County's res-10 cells, found by filtering the national census tract hex files (7 GB in 16 files) on `GEOID`.
- **30x30 land panel for Alpine County.** The Assessment Explorer's land panel (`overview/protection.sql`) for Alpine County with "Managed by: State", as boettiger-lab/ca-30x30 d11bb74 expands it.
- **Statewide hex join.** The GAP 1–2 weight of each ecoregion, joining 25 million ecoregion cells to 3 million weight cells on `h0` and `h10`.

Every query that finished returned the same result as geo-query. The browser took between 11 and 105 times as long. Its time follows the number of requests, at about 70 ms each, more closely than the bytes read: the national PAD-US scan read under 4 MB but sent 634 requests and took 38 seconds. The DuckDB 2.0 build was faster on the county cells (14 seconds and 131 requests, against 28 seconds and 404) and on the statewide join, and within a few seconds of 1.5.4 on the rest. It ran out of memory on the Alpine County panel, which DuckDB 1.5.4 finished in 104 seconds with a peak of 3.9 GB, close to the 4 GB WebAssembly cap. The Explorer's original failure (13,609 requests, then "Out of Memory" after 600 seconds) came from the whole page with DuckDB 1.5.4. This panel's query alone does not reproduce it, so another of the page's queries, or several together, may be the cause.

<!-- benchmark:start -->
### duckdb-wasm 1.33.1-dev57.0

These results are for DuckDB v1.5.4 in HeadlessChrome/156.0.8078.4 on 2026-11-09, against geo-query at https://duckdb-mcp.carlboettiger.info/mcp.

| Query | Browser | Requests | Read | Peak memory | geo-query | Same result |
|---|---|---|---|---|---|---|
| Point lookup in PAD-US | 8.9 s | 132 | 21.28 MB | 516 MB | 0.5 s | yes |
| One PAD-US partition | 8.5 s | 67 | 15.05 MB | 677 MB | 0.6 s | yes |
| National PAD-US scan | 38 s | 634 | 3.73 MB | 495 MB | 0.4 s | yes |
| Statewide 30x30 scan | 8.7 s | 145 | 2.6 MB | 493 MB | 0.2 s | yes |
| County cells from national tracts | 28 s | 404 | 15.06 MB | 540 MB | 0.5 s | yes |
| 30x30 land panel for Alpine County | 104.3 s | 1,165 | 303.72 MB | 3,900 MB | 2.1 s | yes |
| Statewide hex join | 57.8 s | 693 | 120.73 MB | 1,534 MB | 0.7 s | yes |

### duckdb-wasm 1.33.1-dev114.0

These results are for DuckDB v2.0.0 in HeadlessChrome/156.0.8078.4 on 2026-11-09, against geo-query at https://duckdb-mcp.carlboettiger.info/mcp.

| Query | Browser | Requests | Read | Peak memory | geo-query | Same result |
|---|---|---|---|---|---|---|
| Point lookup in PAD-US | 8.3 s | 134 | 19.5 MB | 552 MB | 0.5 s | yes |
| One PAD-US partition | 6.5 s | 68 | 15.68 MB | 658 MB | 0.6 s | yes |
| National PAD-US scan | 41.9 s | 626 | 9.42 MB | 559 MB | 0.4 s | yes |
| Statewide 30x30 scan | 8.9 s | 141 | 4.3 MB | 565 MB | 0.2 s | yes |
| County cells from national tracts | 14.1 s | 131 | 15.41 MB | 583 MB | 0.5 s | yes |
| 30x30 land panel for Alpine County | out of memory at 108.7 s | 1,109 | 537.08 MB | 5,607 MB | 2.1 s |  |
| Statewide hex join | 42.1 s | 476 | 113.76 MB | 1,474 MB | 0.7 s | yes |
<!-- benchmark:end -->
