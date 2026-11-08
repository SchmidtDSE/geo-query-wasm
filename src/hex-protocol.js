/**
 * Hex tiles from the worker, in the page.
 *
 * register_hex_tiles returns a tile URL such as
 * geoquerywasm://tiles/hex/<hash>/{z}/{x}/{y}.pbf, and the worker serves each
 * tile, and the tileset's metadata.json, as an MCP resource at that URL. This
 * module hands those resources to MapLibre and to fetch():
 *
 *   import { addHexTileProtocol, hexFetch } from '…/src/hex-protocol.js';
 *   addHexTileProtocol(maplibregl, client);   // MapLibre GL JS 4 or later
 *   const meta = await (await hexFetch(client)(metadataUrl)).json();
 *
 * `client` is the MCP SDK's Client connected to the worker, or an object
 * whose `client` property is one (glen-harness's MCPClient).
 */

import { SCHEME } from './hex.js';

export { SCHEME };

// glen-harness's MCPClient holds the SDK's Client as `client`.
const sdk = (client) => (typeof client?.client?.readResource === 'function' ? client.client : client);

function decode(b64) {
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
}

/** Read one geoquerywasm: URL from the worker: { bytes, mimeType }. */
export async function readHexResource(client, url) {
    const { contents: [item] = [] } = await sdk(client).readResource({ uri: url });
    if (!item) throw new Error(`no content for ${url}`);
    return {
        bytes: item.blob != null ? decode(item.blob) : new TextEncoder().encode(item.text ?? ''),
        mimeType: item.mimeType,
    };
}

/** A MapLibre addProtocol loader for geoquerywasm: URLs. */
export function hexTileLoader(client) {
    return async ({ url }) => {
        const { bytes } = await readHexResource(client, url);
        return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    };
}

/** Register the geoquerywasm: protocol with MapLibre GL JS (version 4 or later). */
export function addHexTileProtocol(maplibregl, client) {
    maplibregl.addProtocol(SCHEME, hexTileLoader(client));
}

/**
 * fetch() that answers geoquerywasm: URLs from the worker and passes every
 * other request to `base`. An unknown tileset is a 404, as on geo-query.
 */
export function hexFetch(client, base = globalThis.fetch) {
    return async (input, init) => {
        const url = typeof input === 'string' ? input : input?.url ?? String(input);
        if (!url.startsWith(`${SCHEME}://`)) return base(input, init);
        try {
            const { bytes, mimeType } = await readHexResource(client, url);
            return new Response(bytes, { status: 200, headers: { 'Content-Type': mimeType ?? 'application/octet-stream' } });
        } catch (err) {
            return new Response(String(err?.message ?? err), { status: 404 });
        }
    };
}
