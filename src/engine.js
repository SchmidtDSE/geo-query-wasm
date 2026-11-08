/**
 * The DuckDB-wasm engine: start-up, extensions, S3 secrets, settings, access
 * limits, a pool of instances, and row conversion, in one place.
 *
 * The worker's MCP server runs on it (worker.js), and a page can import it
 * directly to run its own SQL without MCP framing, as glen-charts'
 * `"engine": "wasm"` does. It needs a browser (Worker, Blob, fetch) but no
 * particular page; each DuckDB instance runs in a worker of its own.
 *
 *   import { createEngine } from 'https://…/glen-wasm/src/engine.js';
 *   const engine = createEngine({ workers: 2 });
 *   const rows = await engine.json("SELECT … FROM read_parquet('s3://…')");
 *
 * Options (each optional; the defaults are geo-query's, in datasets.js):
 *   duckdb        @duckdb/duckdb-wasm version on jsDelivr
 *   workers       DuckDB instances; each runs one query at a time, and a query
 *                 goes to the least busy one
 *   secrets       [{ name?, scope?, endpoint?, region?, url_style?, use_ssl? }]
 *                 anonymous S3 secrets
 *   rewrite       [{ from, to }] text swapped in the SQL before it runs, e.g. an
 *                 NRP prefix for its source.coop mirror
 *   fetchWhole    URL prefixes whose .parquet files are fetched whole with
 *                 fetch(), in parallel, and read from memory. For hosts that
 *                 break range reads (GitHub Pages gzips responses and applies
 *                 ranges to the compressed stream) and for small files that
 *                 are faster in one request.
 *   settings      { name: value } DuckDB settings applied at start-up
 *   allowedDirectories  the only places SQL may read. null (or omitted with
 *                 lock: false) leaves reads unrestricted.
 *   lock          true (default): turn external access off, lock the
 *                 configuration, and run only SELECT statements. Use it
 *                 whenever someone other than the app writes the SQL.
 */

import { DEFAULTS } from './datasets.js';

const CDN = (v) => `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${v}`;
const DECIMAL = 7; // apache-arrow Type.Decimal
/** Where whole-fetched files are registered in DuckDB's file system. */
const WHOLE_DIR = '/glen-wasm-whole/';

/** An unscaled decimal string as a BigInt (scale 0, exact) or a Number. */
function decimal(digits, scale) {
    return scale === 0 ? BigInt(digits) : Number(digits) / 10 ** scale;
}

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** CREATE SECRET for an anonymous S3 secret. */
export function secretSql({ name, scope, endpoint, region, url_style = 'path', use_ssl = true }, i = 0) {
    const parts = ["TYPE S3", "KEY_ID ''", "SECRET ''", `URL_STYLE ${quote(url_style)}`, `USE_SSL ${use_ssl ? 'true' : 'false'}`];
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
 */
export function planSql(sql, { rewrite = [], fetchWhole = [] } = {}) {
    for (const { from, to } of rewrite) sql = sql.split(from).join(to);
    const files = [];
    if (fetchWhole.length) {
        sql = sql.replace(/'([^']+?\.parquet)'/g, (m, url) => {
            if (!fetchWhole.some(p => url.startsWith(p))) return m;
            // A name that is unique per URL and keeps the .parquet extension.
            const u = new URL(url);
            const name = `${WHOLE_DIR}${u.host}${u.pathname}`;
            if (!files.some(f => f.name === name)) files.push({ name, url });
            return quote(name);
        });
    }
    return { sql, files };
}

/** Wrap a query so DuckDB returns its rows as one JSON array, as text. */
export function jsonSql(sql) {
    return `SELECT CAST(to_json(list(__q)) AS VARCHAR) AS __json FROM (\n${sql.trim().replace(/;\s*$/, '')}\n) __q`;
}

/**
 * @param {Object} [options] - see the module comment
 * @returns {{
 *   ready: () => Promise<void>,
 *   query: (sql: string) => Promise<Object[]>,
 *   json: (sql: string) => Promise<Object[]>,
 *   jsonText: (sql: string) => Promise<string>,
 *   stats: { files: number, bytes: number },
 *   close: () => Promise<void>,
 * }}
 * `query` returns Arrow-typed rows (BigInt for 64-bit integers, binary columns
 * dropped); `json` returns rows typed as DuckDB's to_json writes them, which is
 * what geo-query and glen-charts' MCP client return.
 */
export function createEngine(options = {}) {
    const o = { ...DEFAULTS, ...options };
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
                ...Object.entries(o.settings ?? {}).map(([k, v]) => settingSql(k, v)),
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
    const run = async (sql, wrap = (s) => s) => {
        const plan = planSql(sql, o);
        await Promise.all([ready(), ...plan.files.map(f => fetchFile(f.url))]);
        const w = pool.reduce((a, b) => (b.busy < a.busy ? b : a));
        w.busy++;
        const result = w.queue.then(async () => {
            const final = wrap(plan.sql);
            // Check what will run, after rewriting and wrapping.
            if (w.check) {
                const parsed = JSON.parse((await w.check.query(final)).toArray()[0].j);
                if (parsed.error) {
                    throw new Error(parsed.error_type === 'not implemented'
                        ? 'only SELECT queries run here (also DESCRIBE, SUMMARIZE and FROM-first forms)'
                        : parsed.error_message);
                }
            }
            for (const { name, url } of plan.files) {
                if (w.registered.has(name)) continue;
                // Each instance gets its own copy: the buffer is transferred.
                await w.db.registerFileBuffer(name, (await fetchFile(url)).slice());
                w.registered.add(name);
            }
            return w.conn.query(final);
        });
        w.queue = result.catch(() => {}).finally(() => { w.busy--; });
        try {
            return await result;
        } catch (err) {
            throw new Error(String(err.message ?? err).replace(/^Error:\s*/, ''));
        }
    };

    const query = async (sql) => {
        const table = await run(sql);
        // Arrow hands DECIMAL (and HUGEINT, as DECIMAL(38,0)) back as unscaled
        // big integers; apply the scale. SUM over an integer column is HUGEINT.
        const decimals = table.schema.fields
            .filter(f => f.type.typeId === DECIMAL)
            .map(f => [f.name, f.type.scale]);
        return table.toArray().map((r) => {
            const row = r.toJSON();
            for (const [name, scale] of decimals) {
                if (row[name] != null) row[name] = decimal(String(row[name]), scale);
            }
            // Geometry arrives as WKB bytes, which mean nothing in a table;
            // geo-query drops geometry columns too.
            for (const k of Object.keys(row)) if (row[k] instanceof Uint8Array) delete row[k];
            return row;
        });
    };

    const jsonText = async (sql) => {
        const table = await run(sql, jsonSql);
        return table.getChildAt(0)?.get(0) ?? '[]';
    };

    return {
        ready,
        query,
        jsonText,
        json: async (sql) => JSON.parse(await jsonText(sql)),
        stats,
        async close() {
            if (!pool) return;
            for (const w of pool) { await w.db.terminate(); }
            pool = null;
            started = null;
        },
    };
}
