/**
 * S3 credentials from the page to the worker, outside MCP.
 *
 * A page that holds keys, such as a user's own keys to their own bucket
 * entered in the page as they enter their own language model key, sends them
 * to the worker with sendSecrets(). The worker makes them DuckDB S3 secrets on
 * every instance. They never pass through MCP, so the model never sees them,
 * and they are not put in the worker's URL, which is sent to the server that
 * serves worker.js.
 *
 *   import { sendSecrets } from '…/src/secrets.js';
 *   await sendSecrets(worker, [{ scope: 's3://my-bucket', endpoint: 'minio.example.org', key, secret }]);
 *
 * Each secret is { name?, scope, endpoint?, region?, url_style?, use_ssl?, key?, secret? };
 * one with the name of an earlier one replaces it. The SQL then reads the
 * bucket through ordinary s3:// paths.
 */

export const SECRETS_MESSAGE = 'geo-query-wasm/secrets';

/** True if a config's secrets carry a key or secret, which belong in sendSecrets(). */
export function hasKeys(secrets = []) {
    return secrets.some(s => s && (s.key || s.secret));
}

let next = 0;

/**
 * Send S3 secrets to a geo-query-wasm worker. Resolves once every DuckDB
 * instance has them, and rejects with the worker's error otherwise.
 */
export function sendSecrets(worker, secrets) {
    const id = ++next;
    return new Promise((resolve, reject) => {
        const onMessage = (event) => {
            const d = event.data;
            if (d?.type !== SECRETS_MESSAGE || d.id !== id) return;
            worker.removeEventListener('message', onMessage);
            if (d.ok) resolve();
            else reject(new Error(d.error));
        };
        worker.addEventListener('message', onMessage);
        worker.postMessage({ type: SECRETS_MESSAGE, id, secrets });
    });
}
