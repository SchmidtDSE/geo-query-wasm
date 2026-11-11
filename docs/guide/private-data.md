# Private data

With httpfs loaded, DuckDB-wasm signs S3 requests and reads private objects with byte ranges, as native DuckDB does. An S3 secret with a key and secret signs each request with AWS Signature Version 4.

We measured this on 2026-11-09 against a private bucket on the lab MinIO, with both the DuckDB 1.5.4 and 2.0 builds. Every request carried an `AWS4-HMAC-SHA256` signature, `count(*)` over a 144 MB parquet file read 0.26 MB, and a glob listed the bucket. Without keys the same file returned 403. The older finding that DuckDB-wasm sends no signature describes its built-in HTTP reader, which the engine never uses because it loads httpfs.

## Keys from the page

A user enters their own keys to their own bucket in the page, as they enter their own language model key, and the page sends them to the worker:

```js
import { sendSecrets } from 'https://cdn.jsdelivr.net/gh/SchmidtDSE/geo-query-wasm@v0.6.0/src/secrets.js';

await sendSecrets(worker, [{ scope: 's3://my-bucket', endpoint: 'minio.example.org', key, secret }]);
```

The worker makes each one a DuckDB S3 secret on every instance, and the SQL then reads the bucket through ordinary `s3://` paths. A secret with the name of an earlier one replaces it. A page that imports the engine itself passes `secrets` with keys to `createEngine()`, or calls `engine.setSecrets()`.

## Keeping keys from the model

The worker keeps the keys out of everything that reaches the language model.

- The `query` tool has no `s3_key` or `s3_secret` argument, and a call that passes them is refused. Keys in a tool call would have passed through the model and would stay in the conversation it is sent.
- Keys are not accepted in the worker's URL configuration, because that URL is sent to the server that serves `worker.js`.
- The SQL cannot read `duckdb_secrets()` or `which_secret()`.
- Error text has each key and secret replaced by `[REDACTED]`, because an S3 error can repeat the request's key ID.

`scripts/private-check.mjs` checks each of these in headless Chrome against a private bucket named in its environment.

## CORS rules on the bucket

The bucket must allow the page's origin for `GET` and `HEAD`, allow the request headers `Authorization`, `x-amz-content-sha256` and `x-amz-date`, and expose `ETag`, `Content-Length`, `Content-Range` and `Accept-Ranges`. The lab MinIO already does. An AWS bucket has no CORS rules until its owner adds them.

## Conditions

- We have read a private bucket on MinIO. AWS S3 checks the same signature, and a read on AWS with made-up keys was signed and refused with 403, but we have not yet read a private AWS bucket.
- Signed reads cost a little more than public ones. `Authorization` is not a header a browser sends without asking, so each range read needs a CORS preflight whenever the browser's cached answer for that file has lapsed. A bucket that sends a long `Access-Control-Max-Age` avoids most of them.
- The keys live in the page's memory, like the language model key, so any script the page loads could read them. Users should give read-only keys limited to the bucket in question.
- An app's own keys do not belong in the page. Every user would receive them, and revoking them would cut off every user at once. Data that the app operator holds should stay behind a server: geo-query with credentials of its own, or a proxy on the app's origin behind its sign-in.
