# Hex tiles

`register_hex_tiles` and `get_hex_tile_status` run in the worker with geo-query's arguments, statuses and responses. The worker keeps the H3 pyramid as a table in one DuckDB instance's memory, and encodes each tile as MVT with DuckDB's `ST_AsMVT` when the map asks for it (`src/hex.js`). Nothing is written to object storage.

## Tile URLs

`register_hex_tiles` returns a tile URL such as `geoquerywasm://tiles/hex/<hash>/{z}/{x}/{y}.pbf`. The paths are geo-query's, so a client that reads the hash or the `metadata.json` URL from a tile URL finds them. The worker serves each tile and each tileset's `metadata.json` as an MCP resource at its URL. `metadata.json` adds `cell_counts`, the number of cells at each level. A tile with no cells is empty, where geo-query answers 204.

## Drawing tiles with MapLibre

The page registers the scheme with MapLibre GL JS, version 4 or later, and can read the metadata with a `fetch` that knows the scheme:

```js
import { addHexTileProtocol, hexFetch } from 'https://cdn.jsdelivr.net/gh/SchmidtDSE/geo-query-wasm@v0.6.0/src/hex-protocol.js';

addHexTileProtocol(maplibregl, client);  // client: the MCP SDK's Client, or glen-harness's MCPClient
const meta = await (await hexFetch(client)(metadataUrl)).json();
```

glen's map client (`add_hex_tile_layer`) needs both. MapLibre fetches the tiles through the protocol, and the client fetches `metadata.json` with the page's `fetch`, which an app can replace with `hexFetch(client)`.

## Levels and zooms

Each tile is made on request, at about 0.25 ms per hex in DuckDB-wasm, and a DuckDB instance makes one tile at a time. Two rules keep tiles small, and both make tiles coarser than geo-query's at low and middle zooms.

- **Real cell counts.** The level for a zoom uses each level's real cell count. geo-query's estimate assumes seven cells roll up into one. For scattered data, such as a million points over the globe, that estimate gave a 33 MB tile at zoom 0 that took a minute to make; with the real counts it is 240 KB in half a second.
- **A minimum hex size.** A hex's edge is at least 3 pixels long at the latitude in the data's bounds nearest the equator (`minEdgePx` in `createHexTiles`). Finer levels draw specks rather than hexes.

On 5.75 million res-10 cells in five southern California counties, a 1280×800 view filled in 0.8, 1.0 and 1.0 s at zooms 7, 10 and 13, at res 6, 8 and 10. geo-query's rule served res 7, 9 and 10, with 17,500 and 32,600 hexes at zooms 7 and 10, and took 1.9 and 3.5 s.

## Memory

A tileset lasts as long as the worker and must fit in its memory. A page reload, or `maxTilesets` newer tilesets, removes it. WebAssembly memory is capped at 4 GB.

In headless Chrome, the five counties' 5.75 million cells took 12.5 s to register: 7 s to read the parquet and the rest to build the levels and each cell's centre. A pyramid from 3 million synthetic cells held about 1 GB. A build waits behind the queries before it on its DuckDB instance, and tile requests for that tileset go to the same instance, so with one instance they also wait behind queries.
