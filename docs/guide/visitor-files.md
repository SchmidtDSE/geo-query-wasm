# Visitor files

A page can give the worker a file of the visitor's own, such as a GeoJSON dropped on the map, and the SQL can then read it and join it to the catalog's data. The file stays in the browser. On geo-query the same upload goes to a bucket and the server reads it by URL; here nothing goes over the network.

## Adding a file

The page sends the file's bytes to the worker with `addFile()`. This is not an MCP tool, because the model never holds the bytes.

```js
import { addFile, removeFile, listFiles } from 'https://cdn.jsdelivr.net/gh/SchmidtDSE/geo-query-wasm@v0.8.0/src/files.js';

const file = await addFile(worker, dropped);   // a File from an <input> or a drop
// file.path      '/upload/site.geojson'
// file.read      "ST_Read('/upload/site.geojson')"
// file.columns   [{ name: 'OGC_FID', type: 'BIGINT' }, { name: 'name', type: 'VARCHAR' }, { name: 'geom', type: "GEOMETRY('EPSG:4326')" }]
// file.geometry  'geom'
await removeFile(worker, 'site.geojson');
await listFiles(worker);                       // [{ name, path, bytes, read, columns, geometry }]
```

`addFile` takes a File or Blob, whose own name is used unless a name is given, or an ArrayBuffer or Uint8Array with a name. An ArrayBuffer is transferred to the worker, so the caller's copy is left empty; a File, Blob or Uint8Array is copied. The worker registers the bytes with every DuckDB instance and reads the file's columns. The promise resolves once that is done. It gives the columns as DuckDB describes them, and `geometry`, the first GEOMETRY column's name or null. A file DuckDB cannot read is refused with its error and not kept. A file with the name of an earlier one replaces it, and `removeFile` frees its memory.

The page then tells the model the file's `read` call and its columns, for example in the next user message or in the app's own tool result. The demo page does the first: each file it adds puts a note with the `read` call and columns before the visitor's next question (`src/app.js`). The `query` description already says that visitor files are under `/upload/` and how to read each type.

## The worker's lifetime

- **A file may be sent as soon as the Worker exists.** The worker holds the message until DuckDB has started, about 4 seconds on the first load, and then registers the file, so a page need not wait for MCP to connect.
- **Files live only as long as that Worker.** A page that terminates the worker and starts a new one, as glen does when a connection stops answering, has to add its files again. Keeping the File objects in the page makes that easy.
- **Every call can fail.** `addFile`, `removeFile` and `listFiles` reject when the worker reports an error, fires an `error` event, or does not answer within the timeout: 120 seconds by default, or `{ timeout }` in milliseconds as the last argument. A worker from a geo-query-wasm release that predates these messages never answers, so it shows up as a timeout. Listeners are removed in every case.

## Types and limits

| Extension | Read with |
|---|---|
| `.geojson`, `.json`, `.gpkg`, `.fgb`, `.kml` | `ST_Read('/upload/<name>')`, with the geometry in a `geom` column |
| `.parquet` | `read_parquet('/upload/<name>')` |
| `.csv` | `read_csv('/upload/<name>')` |

- **Names** use letters, digits, `.`, `_` and `-`, up to 100 characters, and start with a letter or digit.
- **Size.** A file over `maxUploadBytes` (50 MB by default) is refused. Each DuckDB instance holds its own copy, so a worker with `workers: 2` holds two.
- **The lock stays on.** `/upload/` is in `allowed_directories` from start-up, because the configuration is locked before any file arrives. The SQL still runs only SELECT statements and reads only the allowed hosts. `ST_Read` cannot reach other hosts through GDAL: `/vsicurl/` and other GDAL prefixes are refused.

We checked this on 2026-11-27 in headless Chrome with DuckDB 1.5.4 and 2.0. A GeoJSON box over St. Louis read with `ST_Read` joined to the St. Louis wards, added as a parquet file, and gave 14 wards. `scripts/e2e.mjs` repeats the check.

## Using the engine directly

A page that imports the engine calls the same functions on it: `engine.registerFile(name, bytes)`, `engine.removeFile(name)` and `engine.listFiles()`.
