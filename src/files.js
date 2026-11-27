/**
 * Files from the page to the worker, outside MCP.
 *
 * A page that lets a visitor add a file of their own, such as a GeoJSON
 * dropped on the map, sends its bytes to the worker with addFile(). The
 * worker registers them with every DuckDB instance, and the SQL reads them
 * under /upload/. The file never leaves the browser. This is not an MCP tool,
 * because the model never holds the bytes; the page tells the model the path.
 *
 *   import { addFile, removeFile, listFiles } from '…/src/files.js';
 *   const { path, read } = await addFile(worker, file);   // a File from <input> or a drop
 *   // read is "ST_Read('/upload/site.geojson')"
 *   await removeFile(worker, 'site.geojson');
 *
 * Names use letters, digits, '.', '_' and '-'. Accepted types are .geojson,
 * .json, .gpkg, .fgb and .kml (read with ST_Read), .parquet (read_parquet)
 * and .csv (read_csv). A file over the worker's maxUploadBytes (50 MB by
 * default) is refused. A file with the name of an earlier one replaces it.
 *
 * A file may be sent as soon as the Worker exists: the worker holds it until
 * DuckDB has started. Files live only as long as that Worker, so a page that
 * replaces the worker adds them again. Every call rejects if the worker
 * reports an error or does not answer within `timeout` milliseconds.
 */

export const FILES_MESSAGE = 'geo-query-wasm/files';

/**
 * How long a call waits for the worker, in milliseconds. It covers DuckDB's
 * start-up (about 4 s, longer on a slow connection) and registering a 50 MB
 * file on each instance.
 */
export const TIMEOUT = 120_000;

let next = 0;

/**
 * Send one message and wait for its answer. Rejects on the worker's `error`
 * event (it crashed or failed to load), or after `timeout` ms, which is also
 * how a worker too old to know these messages shows up.
 */
export function send(worker, message, { transfer = [], timeout = TIMEOUT } = {}) {
    const id = ++next;
    return new Promise((resolve, reject) => {
        let timer = null;
        const done = () => {
            clearTimeout(timer);
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
        };
        const onMessage = (event) => {
            const d = event.data;
            if (d?.type !== FILES_MESSAGE || d.id !== id) return;
            done();
            if (d.ok) resolve(d.result);
            else reject(new Error(d.error));
        };
        const onError = (event) => {
            done();
            reject(new Error(`the worker failed: ${event?.message || 'error event'}`));
        };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        if (timeout) {
            timer = setTimeout(() => {
                done();
                reject(new Error(`the worker did not answer in ${Math.round(timeout / 1000)} s; it may have stopped, `
                    + 'or be a geo-query-wasm older than v0.8.0, which cannot take files'));
            }, timeout);
        }
        try {
            worker.postMessage({ type: FILES_MESSAGE, id, ...message }, transfer);
        } catch (err) {
            done();
            reject(err);
        }
    });
}

/**
 * Register a file with a geo-query-wasm worker. `file` is a File or Blob (its
 * own name is used unless `name` is given), an ArrayBuffer or a Uint8Array.
 * An ArrayBuffer is transferred to the worker, so the caller's copy is left
 * empty; a File, Blob or Uint8Array is copied. Resolves, once every DuckDB
 * instance has the file and has read its columns, to
 *   { name, path, bytes, read, columns: [{ name, type }], geometry }
 * where `read` is the SQL call that reads it and `geometry` the first
 * GEOMETRY column's name, or null. A file DuckDB cannot read is refused.
 * `options.timeout` is in milliseconds (TIMEOUT by default).
 */
export async function addFile(worker, file, name = file?.name, { timeout } = {}) {
    const bytes = typeof Blob !== 'undefined' && file instanceof Blob
        ? await file.arrayBuffer()
        : file instanceof Uint8Array ? file.slice().buffer : file;
    if (!(bytes instanceof ArrayBuffer)) throw new Error('addFile takes a File, Blob, ArrayBuffer or Uint8Array');
    return send(worker, { op: 'add', name, bytes }, { transfer: [bytes], timeout });
}

/** Remove a file from the worker, freeing its memory. Resolves to whether it was there. */
export const removeFile = (worker, name, { timeout } = {}) => send(worker, { op: 'remove', name }, { timeout });

/** The files the worker holds: [{ name, path, bytes, read, columns, geometry }]. */
export const listFiles = (worker, { timeout } = {}) => send(worker, { op: 'list' }, { timeout });
