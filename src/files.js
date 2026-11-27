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
 */

export const FILES_MESSAGE = 'geo-query-wasm/files';

let next = 0;

function send(worker, message, transfer = []) {
    const id = ++next;
    return new Promise((resolve, reject) => {
        const onMessage = (event) => {
            const d = event.data;
            if (d?.type !== FILES_MESSAGE || d.id !== id) return;
            worker.removeEventListener('message', onMessage);
            if (d.ok) resolve(d.result);
            else reject(new Error(d.error));
        };
        worker.addEventListener('message', onMessage);
        worker.postMessage({ type: FILES_MESSAGE, id, ...message }, transfer);
    });
}

/**
 * Register a file with a geo-query-wasm worker. `file` is a File or Blob (its
 * own name is used unless `name` is given), an ArrayBuffer or a Uint8Array.
 * Resolves to { name, path, bytes, read }, where `read` is the SQL call that
 * reads it, once every DuckDB instance has it.
 */
export async function addFile(worker, file, name = file?.name) {
    const bytes = typeof Blob !== 'undefined' && file instanceof Blob
        ? await file.arrayBuffer()
        : file instanceof Uint8Array ? file.slice().buffer : file;
    if (!(bytes instanceof ArrayBuffer)) throw new Error('addFile takes a File, Blob, ArrayBuffer or Uint8Array');
    return send(worker, { op: 'add', name, bytes }, [bytes]);
}

/** Remove a file from the worker, freeing its memory. Resolves to whether it was there. */
export const removeFile = (worker, name) => send(worker, { op: 'remove', name });

/** The files the worker holds: [{ name, path, bytes, read }]. */
export const listFiles = (worker) => send(worker, { op: 'list' });
