/**
 * STAC discovery for the in-browser server: geo-query's browse_stac_catalog,
 * get_stac_details and get_collection (SchmidtDSE/geo-query, stac.py), ported
 * to run in the worker. Output follows geo-query's markdown and JSON so models
 * and apps read both servers' answers the same way.
 *
 * The catalog and its collections are JSON on NRP's public S3, which allows
 * cross-origin reads, so the worker fetches them directly.
 */

export const CATALOG_URL = 'https://s3-west.nrp-nautilus.io/public-data/stac/catalog.json';

// HTTPS hrefs rewritten to the s3:// form DuckDB can glob, as geo-query's
// s3config registry does. The source.coop gateway cannot list a directory;
// its bucket on AWS can.
const S3_REWRITES = [
    ['https://s3-west.nrp-nautilus.io/', 's3://'],
    ['https://data.source.coop/', 's3://us-west-2.opendata.source.coop/'],
    ['https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/', 's3://us-west-2.opendata.source.coop/'],
];

export function hrefToS3(href) {
    for (const [from, to] of S3_REWRITES) {
        if (href.startsWith(from)) return to + href.slice(from.length);
    }
    return href;
}

const VHOST_S3 = /^(?<bucket>[^/]+?)\.(?<endpoint>s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com)$/;

/**
 * For an https href on a host outside the rewrites: the s3:// path and the
 * s3_endpoint and s3_scope to pass to `query` (geo-query's route_hint).
 */
export function routeHint(href) {
    const m = href.match(/^https:\/\/([^/]+)\/(.+)$/);
    if (!m) return null;
    const [, host, rest] = m;
    const vhost = host.match(VHOST_S3);
    let bucket, key, endpoint;
    if (vhost) {
        ({ bucket, endpoint } = vhost.groups);
        key = rest;
    } else {
        const i = rest.indexOf('/');
        bucket = i < 0 ? rest : rest.slice(0, i);
        key = i < 0 ? '' : rest.slice(i + 1);
        endpoint = host;
    }
    if (!bucket || !key) return null;
    return { path: `s3://${bucket}/${key}`, endpoint, scope: `s3://${bucket}` };
}

const HIDDEN_COLUMNS = new Set(['geometry', 'geom', 'bbox']);

function formatColumns(cols) {
    const lines = [];
    for (const c of cols) {
        if (HIDDEN_COLUMNS.has((c.name ?? '').toLowerCase())) continue;
        lines.push(`    - \`${c.name}\` (${c.type ?? '?'})${c.description ? ` — ${c.description}` : ''}`);
        if (c.values) lines.push(`      values: ${JSON.stringify(c.values)}`);
    }
    return lines;
}

function isQueryable(href, type = '') {
    if (type.includes('pmtiles') || href.endsWith('.pmtiles')) return false;
    if (type.includes('tif') || /\.tiff?$/.test(href)) return false;
    return type.includes('parquet') || href.endsWith('.parquet') || href.endsWith('/') || href.includes('/hex/');
}

/** Lines for a collection's parquet assets; `compact` leaves out columns. */
function parquetAssets(col, compact = false) {
    const lines = [];
    const shared = new Map();
    for (const [id, a] of Object.entries(col.assets ?? {})) {
        if (!isQueryable(a.href, a.type)) continue;
        let path = hrefToS3(a.href);
        if (path.endsWith('/')) path = `${path.replace(/\/$/, '')}/**`;
        const size = a['file:size'];
        const sizeNote = size > 1024 ** 2 ? ` (${(size / 1024 ** 3).toFixed(2)} GiB)` : '';
        lines.push(`  - ${a.title ?? id}${sizeNote}: \`read_parquet('${path}')\``);
        if (a.description) lines.push(`    - ${a.description}`);
        for (const k of ['h3:native_resolution', 'h3:parent_resolutions']) {
            if (a[k] != null) lines.push(`    - ${k}: ${JSON.stringify(a[k])}`);
        }
        if (compact) continue;
        const cols = a['table:columns'] ?? [];
        if (cols.length) lines.push(`    - columns: ${cols.map(c => c.type ? `\`${c.name}\` (${c.type})` : `\`${c.name}\``).join(', ')}`);
        for (const c of cols) {
            if (!c.name) continue;
            const seen = shared.get(c.name);
            if (!seen) shared.set(c.name, { ...c });
            else for (const k of ['description', 'values', 'type']) if (!seen[k] && c[k]) seen[k] = c[k];
        }
    }
    if (!compact && shared.size) {
        lines.push('', 'Column descriptions (shared across the assets above):', ...formatColumns([...shared.values()]));
    }
    return lines;
}

function hasAssetColumns(col) {
    return Object.values(col.assets ?? {}).some(a => isQueryable(a.href, a.type) && a['table:columns']?.length);
}

/** Markdown summary of one collection, with one level of sub-collections. */
export function formatCollection(col, subs = []) {
    const lines = [`**${col.title ?? col.id}**`, `Collection ID: \`${col.id}\``];
    const self = col.links?.find(l => l.rel === 'self')?.href;
    if (self) lines.push(`collection_url: \`${self}\``);
    if (col.description) lines.push(col.description);
    if (subs.length) {
        lines.push(`\n**Sub-datasets (${subs.length}):**\n`);
        for (const sc of subs) {
            const assets = parquetAssets(sc, true);
            if (!assets.length) continue;
            lines.push(`*${sc.title ?? sc.id}* (\`${sc.id}\`):`, ...assets, `  - columns: call get_stac_details('${sc.id}')`);
        }
        lines.push(`\nCall get_stac_details with a sub-dataset ID (e.g. \`${subs[0].id}\`) for column schemas and details.`);
        return lines.join('\n');
    }
    const assets = parquetAssets(col);
    if (assets.length) {
        lines.push('\nSQL data (use with `query` tool):', ...assets);
        const cols = col['table:columns'] ?? [];
        if (cols.length && !hasAssetColumns(col)) lines.push('\nKey columns:', ...formatColumns(cols));
    }
    return lines.join('\n');
}

const NAV_RELS = new Set(['root', 'parent', 'self', 'child', 'item']);
const ASSET_FIELDS = new Set(['href', 'type', 'title', 'description', 'roles']);
const dropNulls = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

/**
 * Structured collection metadata for apps, as geo-query's get_collection
 * returns it: every asset with hrefs as s3:// paths, the STAC extension
 * fields, and nested children when given. The output round-trips into the
 * inline `collection` argument.
 */
export function collectionToDict(col, subs = null) {
    const ext = col.extent ?? {};
    const assets = {};
    for (const [id, asset] of Object.entries(col.assets ?? {})) {
        const a = { href: hrefToS3(asset.href), type: asset.type, title: asset.title, description: asset.description };
        if (a.href.startsWith('http') && isQueryable(asset.href, asset.type ?? '')) {
            const hint = routeHint(a.href);
            if (hint) Object.assign(a, { s3_href: hint.path, s3_endpoint: hint.endpoint, s3_scope: hint.scope });
        }
        for (const [k, v] of Object.entries(asset)) if (!ASSET_FIELDS.has(k)) a[k] = v;
        assets[id] = dropNulls(a);
    }
    const out = {
        id: col.id,
        title: col.title,
        description: col.description,
        license: col.license,
        keywords: col.keywords ?? [],
        providers: (col.providers ?? []).map(p => dropNulls({ name: p.name, description: p.description, roles: p.roles, url: p.url })),
        extent: {
            spatial: { bbox: ext.spatial?.bbox ?? [] },
            temporal: { interval: ext.temporal?.interval ?? [] },
        },
        links: (col.links ?? []).filter(l => !NAV_RELS.has(l.rel)).map(l => dropNulls({ rel: l.rel, href: l.href, title: l.title })),
        summaries: col.summaries ?? {},
        assets,
    };
    for (const k of ['table:columns', 'vector:layers', 'raster:bands']) if (col[k] != null) out[k] = col[k];
    if (subs) out.children = subs.map(sc => collectionToDict(sc));
    return dropNulls(out);
}

/** An inline collection dict, checked; its `children` are returned apart. */
function inlineCollection(d) {
    if (!d || typeof d !== 'object' || typeof d.id !== 'string') {
        throw new Error('Invalid inline collection: it needs an `id`');
    }
    const { children = [], ...col } = d;
    return { col, children: Array.isArray(children) ? children : [] };
}

/** Look a key up exactly, then by prefix, then by substring, ignoring case. */
function fuzzy(map, key) {
    if (map.has(key)) return map.get(key);
    const low = key.toLowerCase();
    for (const [k, v] of map) if (k.toLowerCase().startsWith(low)) return v;
    for (const [k, v] of map) if (k.toLowerCase().includes(low)) return v;
    return undefined;
}

const childLinks = (doc) => (doc.links ?? []).filter(l => l.rel === 'child');

/**
 * @param {(url: string) => Promise<Object>} fetchJson
 * @param {Object|string} [options] - { url, discovery }, or the catalog URL
 *   url: the catalog.json to serve
 *   discovery: whether browse_stac_catalog is offered, which changes the
 *     not-found hints (geo-query's STAC_DISCOVERY)
 */
export function createCatalog(fetchJson, options = {}) {
    const { url = CATALOG_URL, discovery = true } = typeof options === 'string' ? { url: options } : options;
    let catalog = null;          // Promise of the catalog's child links
    let indexed = null;          // Promise that resolves once every sub-collection id is known
    const links = new Map();     // id → href, for collections and sub-collections
    const docs = new Map();      // href → Promise of the collection JSON

    const load = (href) => {
        if (!docs.has(href)) docs.set(href, fetchJson(href).catch((e) => { docs.delete(href); throw e; }));
        return docs.get(href);
    };
    const children = () => {
        catalog ??= fetchJson(url).then((c) => {
            const kids = childLinks(c);
            for (const l of kids) links.set(l.id ?? l.href, l.href);
            return kids;
        }).catch((e) => { catalog = null; throw e; });
        return catalog;
    };
    // Sub-collection ids are only in their parents' links, so a lookup that
    // misses reads every parent once, in parallel.
    const indexAll = () => {
        indexed ??= children().then(kids => Promise.all(kids.map(l => load(l.href).then((col) => {
            for (const s of childLinks(col)) links.set(s.id ?? s.href, s.href);
        }, () => {}))));
        return indexed;
    };
    /** The collection and its sub-collections for an id, or null. */
    const find = async (id) => {
        await children();
        let href = fuzzy(links, id);
        if (!href) { await indexAll(); href = fuzzy(links, id); }
        if (!href) return null;
        const col = await load(href);
        const subs = await Promise.all(childLinks(col).map(s => load(s.href)));
        for (const s of childLinks(col)) links.set(s.id ?? s.href, s.href);
        return { col, subs };
    };
    const searched = `this server's catalog (${url})`;
    const hint = (noun) => (discovery ? ` Use browse_stac_catalog to list available ${noun}.` : '');

    return {
        url,
        discovery,
        /** Markdown list of the catalog's collections; `inline` is a Catalog dict with nested children. */
        async browse(inline = null) {
            if (inline) {
                const entries = [];
                for (const child of inline.children ?? []) {
                    const { col, children: subs } = inlineCollection(child);
                    entries.push(col);
                    for (const sc of subs) entries.push(inlineCollection(sc).col);
                }
                return [
                    `# Available Datasets (${entries.length} collections)\n`,
                    `STAC catalog: \`${inline.id ?? '<inline>'}\` (provided inline)\n`,
                    ...entries.map(c => `- **${c.id}**: **${c.title ?? c.id}**`),
                ].join('\n');
            }
            const kids = await children();
            return [
                `# Available Datasets (${kids.length} collections)\n`,
                `STAC catalog: \`${url}\`\n`,
                ...kids.map(l => `- **${l.id}**: **${l.title ?? l.id}**`),
            ].join('\n');
        },
        /** Markdown for a collection; `inline` is a Collection dict, optionally with children. */
        async details(id, inline = null) {
            if (inline) {
                const { col, children: subs } = inlineCollection(inline);
                return formatCollection(col, subs.map(sc => inlineCollection(sc).col));
            }
            const found = await find(id);
            if (!found) return `Dataset '${id}' not found in ${searched}.${hint('datasets')}`;
            return formatCollection(found.col, found.subs);
        },
        /** Structured metadata for a collection (geo-query's get_collection). */
        async collection(id, inline = null) {
            if (inline) {
                const { col, children: subs } = inlineCollection(inline);
                return collectionToDict(col, subs.length ? subs.map(sc => inlineCollection(sc).col) : null);
            }
            let found;
            try {
                found = await find(id);
            } catch (err) {
                return { error: `Failed to fetch catalog: ${err.message}` };
            }
            if (!found) return { error: `Collection '${id}' not found in ${searched}.${hint('collections')}` };
            return collectionToDict(found.col, found.subs.length ? found.subs : null);
        },
    };
}
