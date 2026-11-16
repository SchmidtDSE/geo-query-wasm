# Zonal statistics

Zonal questions normally go through a raster's H3 hex copy, with the zones' cells joined to the hex parquet in SQL. A raster with no hex copy can be summarized with `zonal_stats` once an app turns it on with `zonalStats: true` in the worker's configuration. geo-query has no such tool.

## Arguments

| Argument | Default | Use |
|---|---|---|
| `cog_url` | required | The COG's path from `get_stac_details` or `get_collection`, as `s3://` or `https://`. It must be in `allowedDirectories`. |
| `zones_sql` | required | A SELECT that returns one row per zone with columns `id` and `geometry`, such as `SELECT name AS id, geometry FROM read_parquet('s3://…/wards.parquet')`. It runs on the locked engine, like `query`. |
| `stats` | `sum`, `mean`, `count` | Any of `sum`, `mean`, `min`, `max` and `count`; `classes` alone, the pixel count of each value; or `histogram` with `breaks` (below). |
| `breaks` | none | For `histogram`: increasing cut points. n breaks make n + 1 bins: below the first, `[b[k-1], b[k])` between, and at or above the last. |
| `band` | 1 | The band to read. |
| `pixel_rule` | `centre` | `centre` counts a pixel when its centre is inside the zone, as rasterio does by default. `area` weights each pixel by the share of it inside the zone, estimated from an 8 × 8 grid of points. `exact` weights it by the exact area of the pixel's square inside the zone, as exactextract computes it; it is also the fastest of the weighted rules. |
| `zones_crs` | `EPSG:4326` | The zones' coordinate system. DuckDB reprojects them to the raster's. |
| `raster_crs` | read from the file | Needed only when the COG's own coordinate system is not an EPSG code. |
| `format` | `markdown` | `json` returns the rows for app code. |

## Histogram

`histogram` returns one row per zone and bin, with `lower`, `upper` (null for an open end), `count`, and the `sum` and `mean` of the values in the bin. Under `pixel_rule: "area"` or `"exact"` these are weighted by coverage. For "pixels with value ≥ 0.5, and their mean", pass `breaks: [0.5]` and read the last bin.

## Area

When the raster's CRS is in true ground metres (UTM zones and common equal-area systems, not Web Mercator), every row with a count also has `hectares`, the count times the pixel area, so a client never converts counts itself. The result states the pixel area.

## Reading the raster

[geotiff.js](https://github.com/geotiffjs/geotiff.js) 3.0.5, loaded from jsDelivr on the first call, reads the windows the zones cover by range request and decodes them, ZSTD included. Pixels holding the nodata value, or NaN, are skipped. DuckDB's `raster` extension cannot do this in the browser: it has no wasm build, and its GDAL has no ZSTD codec.

## Limits

- A call reads at most `zonalMaxPixels` pixels, 25 million by default, summed over the zones' windows. When full resolution needs more, it reads the finest overview that fits, scales sums and counts to full-resolution pixels, and says the result is approximate. It fails with a clear message when even the coarsest overview is too big.
- A call summarizes at most 10,000 zones.
- Rotated rasters are not handled.

## Hex copies

The tool's description tells the model to use the hex copy when there is one. The tool declines a COG whose collection in the catalog lists an H3 hex asset, and names that asset, so the model joins the zones to the hex in SQL instead.

## Accuracy

For GHS-POP 2020, a ZSTD COG, the 14 St. Louis wards sum to 320,133 people in 4.6 s in headless Chrome, the same as rasterio's pixel-centre mask. The hex join gives 320,367 in 1.9 s.
