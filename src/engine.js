/**
 * The DuckDB-wasm engine: start-up, extensions, S3 secrets, settings, access
 * limits, a pool of instances, and row conversion, in one place.
 *
 * The worker's MCP server runs on it (worker.js), and a page can import it
 * directly to run its own SQL without MCP framing, as glen-charts'
 * `"engine": "wasm"` does. It needs a browser (Worker, Blob, fetch) but no
 * particular page; each DuckDB instance runs in a worker of its own.
 *
 *   import { createEngine } from 'https://cdn.jsdelivr.net/gh/SchmidtDSE/geo-query-wasm@<commit>/src/engine.js';
 *   const engine = createEngine({ workers: 2 });
 *   const rows = await engine.json("SELECT … FROM read_parquet('s3://…')");
 *
 * Each query may name its own anonymous S3 endpoint, as geo-query's `query`
 * tool does: { s3: { endpoint, scope, region, url_style } }. It becomes a
 * secret that lasts for that query only. Keys (s3.key, s3.secret) are refused,
 * because DuckDB-wasm does not sign S3 requests.
 *
 * Options (each optional; the defaults are geo-query's, in defaults.js):
 *   duckdb        @duckdb/duckdb-wasm version on jsDelivr
 *   workers       DuckDB instances; each runs one query at a time, and a query
 *                 goes to the least busy one
 *   secrets       [{ name?, scope?, endpoint?, region?, url_style?, use_ssl? }]
 *                 anonymous S3 secrets
 *   rewrite       [{ from, to }] text swapped in the SQL before it runs, e.g. an
 *                 NRP prefix for its source.coop mirror. Rewrites do not
 *                 change files fetched whole (see planSql).
 *   fetchWhole    URL prefixes whose .parquet files are fetched whole with
 *                 fetch(), in parallel, and read from memory. For hosts that
 *                 break range reads (GitHub Pages gzips responses and applies
 *                 ranges to the compressed stream) and for small files that
 *                 are faster in one request.
 *   settings      { name: value } DuckDB settings applied at start-up, merged
 *                 over the defaults; a value of null leaves a default unset
 *   allowedDirectories  the only places SQL may read. null (or omitted with
 *                 lock: false) leaves reads unrestricted.
 *   allowedEndpoints  S3 hosts a query's own credentials may name, beyond the
 *                 secrets' endpoints and AWS S3 hosts
 *   lock          true (default): turn external access off, lock the
 *                 configuration, and run only SELECT statements. Use it
 *                 whenever someone other than the app writes the SQL.
 */

import { DEFAULTS } from './defaults.js';

const CDN = (v) => `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${v}`;
const DECIMAL = 7; // apache-arrow Type.Decimal
/** Where whole-fetched files are registered in DuckDB's file system. */
const WHOLE_DIR = '/geo-query-wasm-whole/';

/** An unscaled decimal string as a BigInt (scale 0, exact) or a Number. */
function decimal(digits, scale) {
    return scale === 0 ? BigInt(digits) : Number(digits) / 10 ** scale;
}

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const AWS_S3_HOST = /^s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/;
const DATE = 8, TIMESTAMP = 10; // apache-arrow Type.Date, Type.Timestamp

/** Shown with an error when SQL tries to change the setup (geo-query's LOCKED_HINT). */
export const LOCKED_HINT = 'This server configures every connection itself (settings, extensions, S3 '
    + 'secrets). Remove SET, RESET, PRAGMA and INSTALL statements and run the query again.';

/**
 * The per-query secret for a caller's own endpoint, as geo-query's
 * get_isolated_db makes it for an anonymous source, or null when there is
 * none. Without a scope it covers every s3:// path ('s3://' outranks the
 * unscoped default), so the default endpoint is not used for that query.
 * Credentials are refused: DuckDB-wasm cannot sign requests.
 */
export function clientSecretSql(s3 = {}, { allowedEndpoints = [], secrets = [] } = {}) {
    const { key, secret, endpoint, scope, region, url_style } = s3;
    if (Boolean(key) !== Boolean(secret)) {
        const missing = key ? 's3_secret' : 's3_key';
        throw new Error(`${missing} is required: pass both s3_key and s3_secret together for a private bucket, `
            + 'or neither (optionally with s3_endpoint) for an anonymous source.');
    }
    // Measured in Chrome: a read with made-up keys succeeds on a public AWS
    // bucket, which rejects any bad signature, so DuckDB-wasm sends none
    // (duckdb-wasm#1967). Keys would be ignored, so refuse them.
    if (key) {
        throw new Error('s3_key and s3_secret are not supported in the browser: DuckDB-wasm does not sign S3 requests '
            + '(duckdb-wasm#1967), so a private bucket cannot be read here. Use geo-query for private data.');
    }
    if (!endpoint) return null;
    const host = String(endpoint).trim().toLowerCase();
    const hosts = new Set([...allowedEndpoints, ...secrets.map(s => s.endpoint).filter(Boolean)].map(h => h.toLowerCase()));
    if (!hosts.has(host) && !AWS_S3_HOST.test(host)) {
        throw new Error(`s3_endpoint '${endpoint}' is not an S3 endpoint this server accepts. Use a bare host name `
            + 'such as s3-west.nrp-nautilus.io; ask the app to add another (allowedEndpoints).');
    }
    return secretSql({ name: 'client_s3', endpoint: host, scope: scope || 's3://', region, url_style: url_style || 'path' });
}

/** CREATE SECRET for an S3 secret, anonymous unless key and secret are given. */
export function secretSql({ name, key = '', secret = '', scope, endpoint, region, url_style = 'path', use_ssl = true }, i = 0) {
    const parts = ['TYPE S3', `KEY_ID ${quote(key)}`, `SECRET ${quote(secret)}`, `URL_STYLE ${quote(url_style)}`, `USE_SSL ${use_ssl ? 'true' : 'false'}`];
    if (endpoint) parts.push(`ENDPOINT ${quote(endpoint)}`);
    if (region) parts.push(`REGION ${quote(region)}`);
    if (scope) parts.push(`SCOPE ${quote(scope)}`);
    const id = String(name ?? `s${i}`).replace(/\W/g, '_');
    return `CREATE OR REPLACE SECRET ${id} (${parts.join(', ')})`;
}

/** SET statement for one setting. */
export function settingSql(name, value) {
    if (!/^\w+$/.test(name)) throw new Error(`bad setting name ${name}`);
    const v = typeof value === 'string' ? quote(value)
        : Array.isArray(value) ? `[${value.map(quote).join(', ')}]`
        : String(value);
    return `SET ${name} = ${v}`;
}

/**
 * Apply rewrites and find whole-fetch URLs. Pure, so it is tested without
 * DuckDB. Returns the SQL to run and the files to register: [{ name, url }].
 *
 * A URL is fetched whole if it starts with a fetchWhole prefix either as the
 * app wrote it or after the rewrites, so a rewrite never turns a whole-file
 * fetch into range reads, and a rewrite can still point a path at a
 * whole-fetch host.
 */
export function planSql(sql, { rewrite = [], fetchWhole = [] } = {}) {
    const files = [];
    const whole = (text) => (!fetchWhole.length ? text : text.replace(/'([^']+?\.parquet)'/g, (m, url) => {
        if (!fetchWhole.some(p => url.startsWith(p))) return m;
        // A name that is unique per URL and keeps the .parquet extension.
        const u = new URL(url);
        const name = `${WHOLE_DIR}${u.host}${u.pathname}`;
        if (!files.some(f => f.name === name)) files.push({ name, url });
        return quote(name);
    }));
    sql = whole(sql);
    for (const { from, to } of rewrite) sql = sql.split(from).join(to);
    return { sql: whole(sql), files };
}

const bare = (sql) => sql.trim().replace(/;\s*$/, '');

/** Wrap a query so DuckDB returns its rows as one JSON array, as text. */
export function jsonSql(sql) {
    return `SELECT CAST(to_json(list(__q)) AS VARCHAR) AS __json FROM (\n${bare(sql)}\n) __q`;
}

/** Wrap a query so DuckDB stops after n rows. */
export function limitSql(sql, n) {
    return `SELECT * FROM (\n${bare(sql)}\n) __q LIMIT ${Math.floor(n)}`;
}

/**
 * The engine's options over its defaults. Settings merge with the default
 * settings, so an app that adds one keeps the rest; every other option
 * replaces its default.
 */
export function resolveOptions(options = {}) {
    return { ...DEFAULTS, ...options, settings: { ...DEFAULTS.settings, ...(options.settings ?? {}) } };
}

/**
 * @param {Object} [options] - see the module comment
 * @returns {{
 *   ready: () => Promise<void>,
 *   query: (sql: string, opts?: { s3?: Object, limit?: number }) => Promise<Object[]>,
 *   json: (sql: string, opts?: { s3?: Object }) => Promise<Object[]>,
 *   jsonText: (sql: string, opts?: { s3?: Object }) => Promise<string>,
 *   stats: { files: number, bytes: number },
 *   close: () => Promise<void>,
 * }}
 * `query` returns Arrow-typed rows (BigInt for 64-bit integers, dates and
 * timestamps as 'YYYY-MM-DD' and 'YYYY-MM-DD HH:MM:SS' strings, binary columns
 * dropped); `json` returns rows typed as DuckDB's to_json writes them, which is
 * what geo-query and glen-charts' MCP client return.
 */
export function createEngine(options = {}) {
    const o = resolveOptions(options);
    const lock = o.lock !== false;
    const allowed = o.allowedDirectories === undefined ? (lock ? DEFAULTS.allowedDirectories : null) : o.allowedDirectories;
    const files = new Map(); // URL → Promise<Uint8Array>
    const stats = { files: 0, bytes: 0 };
    let pool = null;
    let started = null;

    const fetchFile = (url) => {
        if (!files.has(url)) {
            files.set(url, fetch(url).then(async (r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
                const buf = new Uint8Array(await r.arrayBuffer());
                stats.files++;
                stats.bytes += buf.byteLength;
                return buf;
            }).catch((err) => { files.delete(url); throw err; }));
        }
        return files.get(url);
    };

    const ready = () => started ??= (async () => {
        const duckdb = await import(`${CDN(o.duckdb)}/+esm`);
        const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
        const workerUrl = URL.createObjectURL(
            new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }));

        const start = async () => {
            const worker = new Worker(workerUrl);
            const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
            await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
            const conn = await db.connect();
            // LOAD httpfs explicitly: without it DuckDB-wasm's built-in HTTP
            // reader downloads whole files instead of byte ranges
            // (duckdb-wasm#2153). Every extension is loaded now, because none
            // can be autoloaded once external access is off.
            for (const sql of [
                'LOAD httpfs', 'LOAD parquet', 'LOAD json',
                'INSTALL h3 FROM community', 'LOAD h3',
                'INSTALL spatial', 'LOAD spatial',
                ...Object.entries(o.settings).filter(([, v]) => v != null).map(([k, v]) => settingSql(k, v)),
                ...(o.secrets ?? []).map(secretSql),
            ]) await conn.query(sql);

            if (allowed) {
                const dirs = o.fetchWhole?.length ? [...allowed, WHOLE_DIR] : allowed;
                await conn.query(settingSql('allowed_directories', dirs));
            }
            let check = null;
            if (lock) {
                // allowed_directories applies once external access is off, and
                // the lock stops a query from changing either.
                await conn.query('SET autoinstall_known_extensions = false');
                await conn.query('SET autoload_known_extensions = false');
                await conn.query('SET allow_community_extensions = false');
                await conn.query('SET enable_external_access = false');
                await conn.query('SET lock_configuration = true');
                // The lock does not cover secrets, and a new secret could send
                // an allowed s3:// path to another endpoint. DuckDB serializes
                // only SELECT statements to JSON, so it checks that each query
                // is read-only.
                check = await conn.prepare('SELECT json_serialize_sql($1::VARCHAR) AS j');
            }
            return { worker, db, conn, check, busy: 0, queue: Promise.resolve(), registered: new Set() };
        };
        // The first instance fetches the wasm and extensions; the rest start
        // from the browser's cache.
        const first = await start();
        pool = [first, ...await Promise.all(Array.from({ length: Math.max(0, (o.workers ?? 1) - 1) }, start))];
    })();

    /** Run SQL on the least busy instance, after its earlier queries. */
    const run = async (sql, { s3 } = {}, wrap = (s) => s) => {
        const plan = planSql(sql, o);
        const client = s3 ? clientSecretSql(s3, o) : null;
        await Promise.all([ready(), ...plan.files.map(f => fetchFile(f.url))]);
        const w = pool.reduce((a, b) => (b.busy < a.busy ? b : a));
        w.busy++;
        const result = w.queue.then(async () => {
            const final = wrap(plan.sql);
            // Check the caller's SQL, for a clear message, and then what will
            // run, after rewriting and wrapping.
            if (w.check) {
                for (const sql of final === plan.sql ? [final] : [plan.sql, final]) {
                    const parsed = JSON.parse((await w.check.query(sql)).toArray()[0].j);
                    if (!parsed.error) continue;
                    throw new Error(parsed.error_type === 'not implemented'
                        ? `only SELECT queries run here (also DESCRIBE, SUMMARIZE and FROM-first forms).\n\n${LOCKED_HINT}`
                        : parsed.error_message);
                }
            }
            for (const { name, url } of plan.files) {
                if (w.registered.has(name)) continue;
                // Each instance gets its own copy: the buffer is transferred.
                await w.db.registerFileBuffer(name, (await fetchFile(url)).slice());
                w.registered.add(name);
            }
            if (!client) return w.conn.query(final);
            // The caller's secret lasts for this query only; queries on an
            // instance run one at a time, so no other query sees it.
            await w.conn.query(client);
            try {
                return await w.conn.query(final);
            } finally {
                await w.conn.query('DROP SECRET IF EXISTS client_s3');
            }
        });
        w.queue = result.catch(() => {}).finally(() => { w.busy--; });
        try {
            return await result;
        } catch (err) {
            const msg = String(err.message ?? err).replace(/^Error:\s*/, '');
            const locked = !msg.includes(LOCKED_HINT) && (msg.includes('configuration has been locked')
                || (msg.includes('extensions') && msg.includes('Permission Error')));
            throw new Error(locked ? `${msg}\n\n${LOCKED_HINT}` : msg);
        }
    };

    const query = async (sql, opts = {}) => {
        const table = await run(sql, opts, opts.limit ? (s) => limitSql(s, opts.limit) : undefined);
        // Arrow hands DECIMAL (and HUGEINT, as DECIMAL(38,0)) back as unscaled
        // big integers; apply the scale. SUM over an integer column is HUGEINT.
        const decimals = table.schema.fields
            .filter(f => f.type.typeId === DECIMAL)
            .map(f => [f.name, f.type.scale]);
        // Dates and timestamps arrive as epoch milliseconds; print them as
        // geo-query does.
        const temporal = table.schema.fields
            .filter(f => f.type.typeId === DATE || f.type.typeId === TIMESTAMP)
            .map(f => [f.name, f.type.typeId === DATE ? 10 : 19]);
        return table.toArray().map((r) => {
            const row = r.toJSON();
            for (const [name, scale] of decimals) {
                if (row[name] != null) row[name] = decimal(String(row[name]), scale);
            }
            for (const [name, len] of temporal) {
                if (row[name] != null) row[name] = new Date(Number(row[name])).toISOString().slice(0, len).replace('T', ' ');
            }
            // Geometry arrives as WKB bytes, which mean nothing in a table;
            // geo-query drops geometry columns too.
            for (const k of Object.keys(row)) if (row[k] instanceof Uint8Array) delete row[k];
            return row;
        });
    };

    const jsonText = async (sql, opts) => {
        const table = await run(sql, opts, jsonSql);
        return table.getChildAt(0)?.get(0) ?? '[]';
    };

    return {
        ready,
        query,
        jsonText,
        json: async (sql, opts) => JSON.parse(await jsonText(sql, opts)),
        stats,
        async close() {
            if (!pool) return;
            for (const w of pool) { await w.db.terminate(); }
            pool = null;
            started = null;
        },
    };
}
