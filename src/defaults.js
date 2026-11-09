/**
 * The engine's defaults (engine.js): geo-query's S3 sources, settings and
 * access limits. An app's configuration overrides any of them.
 */

/**
 * The only places the SQL may read (DuckDB `allowed_directories`). An s3://
 * path goes to NRP Ceph or, for the source.coop bucket, to AWS, through the
 * secrets the engine creates; queries cannot create others.
 */
export const ALLOWED_DIRECTORIES = [
    's3://',
    'https://s3-west.nrp-nautilus.io/',
    'https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/',
    'https://data.source.coop/',
];

/** Anonymous S3 secrets, as geo-query creates them. */
export const S3_SECRETS = [
    { name: 'nrp', endpoint: 's3-west.nrp-nautilus.io' },
    { name: 'source_coop', endpoint: 's3.us-west-2.amazonaws.com', region: 'us-west-2', scope: 's3://us-west-2.opendata.source.coop' },
];

/**
 * DuckDB settings applied at start-up. Parsing some GeoParquet metadata fails
 * in the wasm build with "stoi: no conversion" (boettiger-lab/datasets#106),
 * so geometry columns are read as plain WKB blobs, which are dropped from
 * results anyway.
 */
export const SETTINGS = {
    enable_geoparquet_conversion: false,
    // As geo-query sets them (query-setup.md, server.py). The optimizer is off
    // because of a DuckDB 1.5.x bug that fails some joins on sorted UINT64
    // keys read from S3 with "SetMin or SetMax ... does not match statistics"
    // (geo-query#378).
    preserve_insertion_order: false,
    disabled_optimizers: 'statistics_propagation',
};

/**
 * S3 endpoints a caller may name in query's s3_endpoint, beyond the secrets'
 * own endpoints and AWS S3 hosts (geo-query's allowed client endpoints).
 */
export const CLIENT_ENDPOINTS = [
    's3-west.nrp-nautilus.io',
    'minio.carlboettiger.info',
];

/**
 * @duckdb/duckdb-wasm on jsDelivr: DuckDB 1.5.4.
 */
export const DUCKDB_WASM = '1.33.1-dev57.0';

/**
 * A build of DuckDB 2.0 (npm tag `next`), which an app can choose with the
 * `duckdb` option. It spills to memory outside the 4 GB WebAssembly heap when
 * an aggregate or sort needs more than memory_limit, where 1.5.4 fails with
 * "Out of Memory". It is not the default, because its planner fails other
 * queries that 1.5.4 runs: on the 30x30 Explorer's land panel it computes a
 * repeated subquery twice and builds its joins on the large tables, and runs
 * out of memory (docs/capabilities.md).
 */
export const DUCKDB_WASM_2 = '1.33.1-dev114.0';

/**
 * Seconds a query may run before it is cancelled. Twice geo-query's 300-second
 * MCP timeout, since reads in the browser are serial. null or 0 means no limit.
 */
export const QUERY_TIMEOUT = 600;

/** The engine's defaults (engine.js), which an app's configuration overrides. */
export const DEFAULTS = {
    duckdb: DUCKDB_WASM,
    workers: 1,
    timeout: QUERY_TIMEOUT,
    secrets: S3_SECRETS,
    rewrite: [],
    fetchWhole: [],
    settings: SETTINGS,
    allowedDirectories: ALLOWED_DIRECTORIES,
    allowedEndpoints: CLIENT_ENDPOINTS,
    lock: true,
};
