# Visitor files

A page can give the worker a file of the visitor's own, such as a GeoJSON dropped on the map, and the SQL can then read it and join it to the catalog's data. The file stays in the browser. On geo-query the same upload goes to a bucket and the server reads it by URL; here nothing goes over the network.

## Adding a file

The page sends the file's bytes to the worker with `addFile()`. This is not an MCP tool, because the model never holds the bytes.

```js
import { addFile, removeFile, listFiles } from 'https://cdn.jsdelivr.net/gh/SchmidtDSE/geo-query-wasm@v0.7.0/src/files.js';

const { path, read } = await addFile(worker, file);   // a File from an <input> or a drop
// path: '/upload/site.geojson'   read: "ST_Read('/upload/site.geojson')"
await removeFile(worker, 'site.geojson');
await listFiles(worker);                               // [{ name, path, bytes, read }]
```

`addFile` takes a File or Blob, whose own name is used unless a name is given, or an ArrayBuffer or Uint8Array with a name. The worker registers the bytes with every DuckDB instance, and the promise resolves once all of them have it. A file with the name of an earlier one replaces it, and `removeFile` frees its memory.

The page then tells the model the file's path or its `read` call, for example in the next user message or in the app's own tool result. The `query` description already says that visitor files are under `/upload/` and how to read each type.

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
