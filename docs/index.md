---
layout: home

hero:
  name: geo-query-wasm
  text: geo-query in the browser
  tagline: geo-query's MCP server runs in a Web Worker with DuckDB-wasm. A client that works with geo-query works with it unchanged, and no server is involved.
  actions:
    - theme: brand
      text: Quick start
      link: /guide/quickstart
    - theme: alt
      text: Try the demo
      link: https://schmidtdse.github.io/geo-query-wasm/
    - theme: alt
      text: Parity with geo-query
      link: /guide/parity

features:
  - title: The same tools as geo-query
    details: The tool names, arguments, descriptions and output follow geo-query's, and the model-facing guidance is geo-query's own, fetched at a pinned commit. Catalog listings and details match geo-query's output on the catalogs we check.
  - title: No server
    details: The worker is a set of static files that any page can load. The data are public files on source.coop and NRP, read with byte-range requests, and the user's questions go only to the language model endpoint the page uses.
  - title: Locked SQL
    details: The SQL can read only the allowed data hosts and runs only SELECT statements. External access and extension loading are off, and the configuration is locked before the model writes any query.
  - title: STAC and Portolan catalogs
    details: The worker walks a STAC catalog to any depth, including Portolan catalogs with relative links, and lists datasets under their groups.
  - title: Hex tiles and zonal statistics
    details: H3 hex tilesets are built and encoded as vector tiles in the worker. An optional tool sums a Cloud-Optimized GeoTIFF over polygon zones when the raster has no hex copy.
  - title: Private buckets
    details: A page can read a private S3 bucket with keys the user enters. The keys go to the worker, never to the model.
---
