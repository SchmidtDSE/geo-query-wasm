/**
 * STAC discovery for the in-browser server: geo-query's browse_stac_catalog,
 * get_stac_details and get_collection (SchmidtDSE/geo-query, stac.py), ported
 * to run in the worker. Output follows geo-query's markdown and JSON so models
 * and apps read both servers' answers the same way.
 *
 * The catalog and its collections are JSON on source.coop (or NRP's public
 * S3), which allow cross-origin reads, so the worker fetches them directly.
 */

/**
 * The default catalog is the source.coop mirror of GLEN's catalog, which a
 * browser reads much faster than NRP. It lists the license-clear collections
 * (about 30); NRP's canonical catalog lists about 80.
 */
export const CATALOG_URL = 'https://data.source.coop/cboettig/glen/catalog.json';
export const NRP_CATALOG_URL = 'https://s3-west.nrp-nautilus.io/public-data/stac/catalog.json';

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

/**
 * A value as Python prints it (repr), since geo-query writes extension
 * fields and categorical values with Python's str(): [9, 8, 0], {'a': 'b'}.
 */
export function pyRepr(v) {
    if (v === null || v === undefined) return 'None';
    if (v === true) return 'True';
    if (v === false) return 'False';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : pyFloat(v);
    if (typeof v === 'string') return v.includes("'") && !v.includes('"') ? `"${v}"` : `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
    return `{${Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(', ')}}`;
}

function pyFloat(v) {
    if (!Number.isFinite(v)) return Number.isNaN(v) ? 'nan' : (v > 0 ? 'inf' : '-inf');
    const s = String(v);
    if (/e/.test(s)) {
        const [m, e] = s.split('e');
        const exp = Number(e);
        return `${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
    }
    return s.includes('.') ? s : `${s}.0`;
}

function formatColumns(cols) {
    const lines = [];
    for (const c of cols) {
        if (HIDDEN_COLUMNS.has((c.name ?? '').toLowerCase())) continue;
        lines.push(`    - \`${c.name}\` (${c.type ?? '?'})${c.description ? ` — ${c.description}` : ''}`);
        if (c.values?.length) lines.push(`      values: ${pyRepr([...c.values])}`);
    }
    return lines;
}

function isQueryable(href, type = '') {
    if (type.includes('pmtiles') || href.endsWith('.pmtiles')) return false;
    if (type.includes('tif') || /\.tiff?$/.test(href)) return false;
    return type.includes('parquet') || href.endsWith('.parquet') || href.endsWith('/') || href.includes('/hex/');
}

const columnSummary = (cols) => cols.filter(c => c.name).map(c => (c.type ? `\`${c.name}\` (${c.type})` : `\`${c.name}\``)).join(', ');

/**
 * Lines for a collection's parquet assets, as geo-query's
 * _extract_parquet_assets writes them; `compact` leaves out columns. An
 * asset without its own column list takes the collection's (Portolan keeps
 * one dictionary on the collection), and each column is described once.
 */
function parquetAssets(col, compact = false) {
    const lines = [];
    const shared = new Map();
    for (const [id, a] of Object.entries(col.assets ?? {})) {
        if (!a?.href || !isQueryable(a.href, a.type ?? '')) continue;
        let path = hrefToS3(a.href);
        // An unknown host: the s3:// form, with the endpoint to pass to query.
        const hint = path.startsWith('http') ? routeHint(path) : null;
        if (hint) path = hint.path;
        if (path.endsWith('/')) path = `${path.replace(/\/+$/, '')}/**`;
        const size = a['file:size'];
        const sizeNote = size > 1024 ** 2 ? ` (${(size / 1024 ** 3).toFixed(2)} GiB)` : '';
        lines.push(`  - ${a.title ?? id}${sizeNote}: \`read_parquet('${path}')\``);
        if (hint) {
            lines.push(`    - ⚠️ non-default endpoint (derived from \`${a.href}\` assuming path-style S3): call \`query\` with `
                + `s3_endpoint='${hint.endpoint}', s3_scope='${hint.scope}' (anonymous; a private bucket's credentials come from the deployment)`);
        }
        if (a.description) lines.push(`    - ${a.description}`);
        for (const k of ['h3:native_resolution', 'h3:parent_resolutions', 'raster:bands', 'vector:layers']) {
            if (a[k] != null) lines.push(`    - ${k}: ${pyRepr(a[k])}`);
        }
        if (compact) continue;
        const cols = a['table:columns']?.length ? a['table:columns'] : (col['table:columns'] ?? []);
        const summary = columnSummary(cols);
        if (summary) lines.push(`    - columns: ${summary}`);
        for (const c of cols) {
            if (!c.name) continue;
            const seen = shared.get(c.name);
            if (!seen) shared.set(c.name, { ...c });
            else for (const k of ['description', 'values', 'type']) if (!seen[k] && c[k]) seen[k] = c[k];
        }
    }
    if (!compact) {
        for (const c of col['table:columns'] ?? []) {
            const seen = shared.get(c.name);
            if (seen) for (const k of ['description', 'values', 'type']) if (!seen[k] && c[k]) seen[k] = c[k];
        }
        const block = formatColumns([...shared.values()]);
        if (block.length) lines.push('', 'Column descriptions (shared across the assets above):', ...block);
    }
    return lines;
}

/**
 * Markdown summary of one collection. `subs` are the datasets beneath it,
 * however deep, listed as a chooser without their columns.
 */
export function formatCollection(col, subs = []) {
    const lines = [`**${col.title ?? col.id}**`, `Collection ID: \`${col.id}\``];
    const self = col.links?.find(l => l.rel === 'self')?.href;
    if (self) lines.push(`collection_url: \`${self}\``);
    if (col.description) lines.push(col.description);
    if (subs.length) {
        lines.push(`\n**Sub-datasets (${subs.length}):**\n`);
        for (const sc of subs) {
            const assets = parquetAssets(sc, true);
            if (assets.length) lines.push(`*${sc.title ?? sc.id}* (\`${sc.id}\`):`, ...assets, `  - columns: call get_stac_details('${sc.id}')`);
            else lines.push(`*${sc.title ?? sc.id}* (\`${sc.id}\`): call get_stac_details('${sc.id}')`);
        }
        lines.push(`\nCall get_stac_details with a sub-dataset ID (e.g. \`${subs[0].id}\`) for column schemas and details.`);
        return lines.join('\n');
    }
    const assets = parquetAssets(col);
    if (assets.length) lines.push('\nSQL data (use with `query` tool):', ...assets);
    return lines.join('\n');
}

const NAV_RELS = new Set(['root', 'parent', 'self', 'child', 'item']);
const ASSET_FIELDS = new Set(['href', 'type', 'title', 'description', 'roles']);
const dropNulls = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

// As pystac writes them, so get_collection matches geo-query: a timestamp
// in Python's isoformat (+00:00 for Z, microseconds when there is a
// fraction), and STAC 1.0's deprecated licenses migrated to "other".
const isoformat = (t) => {
    if (typeof t !== 'string') return t;
    const m = t.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/i);
    if (!m) return t;
    const frac = m[2] && Number(m[2]) ? `.${m[2].padEnd(6, '0').slice(0, 6)}` : '';
    return `${m[1]}${frac}${m[3].toUpperCase() === 'Z' ? '+00:00' : m[3]}`;
};
const LICENSES = { various: 'other', proprietary: 'other' };

/**
 * Structured collection metadata for apps, as geo-query's get_collection
 * returns it: every asset with hrefs as s3:// paths, the STAC extension
 * fields, and nested children when given. A Catalog has `type: "Catalog"`.
 * The output round-trips into the inline `collection` argument.
 */
export function collectionToDict(col, subs = null) {
    const catalog = col.type === 'Catalog';
    const ext = col.extent;
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
        type: catalog ? 'Catalog' : null,
        license: LICENSES[col.license] ?? col.license,
        keywords: col.keywords ?? [],
        providers: (col.providers ?? []).map(p => dropNulls({ name: p.name, description: p.description, roles: p.roles, url: p.url })),
        extent: catalog && !ext ? null : {
            spatial: { bbox: ext?.spatial?.bbox ?? [] },
            temporal: { interval: (ext?.temporal?.interval ?? []).map(i => (Array.isArray(i) ? i.map(isoformat) : i)) },
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

/**
 * Look a key up as geo-query's _lookup does: exactly; then, for a key with
 * no `/`, by the last segment of the ids that have one, when exactly one id
 * ends that way (Portolan ids such as `government/wards` answer to `wards`);
 * then by prefix and substring. Gives `{ value }`, `{ candidates }` when more
 * than one id ends with the key, or null.
 */
export function lookup(map, key) {
    if (map.has(key)) return { value: map.get(key) };
    if (!key.includes('/')) {
        const low = key.toLowerCase();
        const tails = [...map.keys()].filter(k => k.includes('/') && k.slice(k.lastIndexOf('/') + 1).toLowerCase() === low);
        if (tails.length === 1) return { value: map.get(tails[0]) };
        if (tails.length > 1) return { candidates: tails };
    }
    const value = fuzzy(map, key);
    return value === undefined ? null : { value };
}

const childLinks = (doc) => (doc.links ?? []).filter(l => l.rel === 'child');

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A STAC document with its relative link and asset hrefs resolved against the
 * URL it was fetched from, and a self link added when it has none. Portolan
 * catalogs use relative hrefs throughout and give the root no self link.
 * Absolute hrefs are kept as written, so globs such as `h0=*` are untouched.
 */
export function resolveHrefs(doc, base) {
    const abs = (h) => (typeof h !== 'string' || ABSOLUTE.test(h) ? h : new URL(h, base).href);
    const links = (doc.links ?? []).map(l => ({ ...l, href: abs(l.href) }));
    if (!links.some(l => l.rel === 'self')) links.push({ rel: 'self', href: base });
    const out = { ...doc, links };
    if (doc.assets) {
        out.assets = Object.fromEntries(Object.entries(doc.assets).map(([k, a]) => [k, a && { ...a, href: abs(a.href) }]));
    }
    return out;
}

// How deep child links are followed below the root, as a guard against
// runaway catalogs; the visited set already stops cycles (geo-query#433).
const MAX_CATALOG_DEPTH = 6;

/**
 * A group node holds no data: a Catalog, or a Collection with children and
 * no queryable asset. Groups are headings in the listing, never datasets.
 */
const isGroup = (doc, childCount) => {
    if (doc.type === 'Catalog') return true;
    if (!childCount) return false;
    return !Object.values(doc.assets ?? {}).some(a => isQueryable(a?.href ?? '', a?.type ?? ''));
};

/** A name for a child that could not be read, from its href and title (geo-query's _child_identifier). */
function childIdentifier(href, title) {
    const segments = href.replace(/\/+$/, '').split('/').filter(Boolean);
    if (!segments.length) return title || href;
    let tail = segments.at(-1);
    if (tail === 'stac-collection.json' || tail === 'catalog.json') tail = segments.length >= 2 ? segments.at(-2) : tail;
    else if (tail.endsWith('.json')) tail = tail.slice(0, -5);
    return title && !tail.toLowerCase().includes(title.toLowerCase()) ? `${tail} (${title})` : tail;
}

/**
 * A fetched tree, rendered as geo-query's _assemble renders it. `nodes` maps
 * a node's key to its document and `kidsOf` a key to its children's keys, in
 * link order. Each node is placed once, under the first parent that reaches
 * it depth-first. Returns `byId` (id → { doc, md, dict }) and `index`
 * ([depth, id, isGroup] in depth-first order).
 */
function assemble(rootKey, nodes, kidsOf) {
    const kids = (key) => (kidsOf.get(key) ?? []).filter(k => nodes.has(k));
    const leavesUnder = (key, out, seen) => {
        for (const k of kids(key)) {
            if (seen.has(k)) continue;
            seen.add(k);
            if (!isGroup(nodes.get(k), kids(k).length)) out.push(nodes.get(k));
            leavesUnder(k, out, seen);
        }
        return out;
    };
    const treeDict = (key, stack) => {
        const d = collectionToDict(nodes.get(key));
        const sub = kids(key).filter(k => !stack.has(k));
        if (sub.length) d.children = sub.map(k => treeDict(k, new Set([...stack, k])));
        return d;
    };
    const byId = new Map();
    const index = [];
    const placed = new Set([rootKey]);
    const visit = (key, depth) => {
        for (const k of kids(key)) {
            if (placed.has(k)) continue;
            placed.add(k);
            const doc = nodes.get(k);
            if (byId.has(doc.id)) {
                console.warn(`[geo-query-wasm] Duplicate STAC id ${doc.id} at ${k}; keeping the first`);
                continue;
            }
            const sub = kids(k);
            byId.set(doc.id, sub.length
                ? { doc, md: formatCollection(doc, leavesUnder(k, [], new Set([k]))), dict: treeDict(k, new Set([k])) }
                : { doc, md: formatCollection(doc, []), dict: collectionToDict(doc) });
            index.push([depth, doc.id, isGroup(doc, sub.length)]);
            visit(k, depth + 1);
        }
    };
    visit(rootKey, 0);
    return { byId, index };
}

/** browse_stac_catalog's markdown lines, and the dataset and group counts (geo-query's _render_listing). */
function renderListing(byId, index) {
    const lines = [];
    const listed = new Set();
    let groups = 0;
    for (const [depth, id, group] of index) {
        if (!byId.has(id) || listed.has(id)) continue;
        listed.add(id);
        const pad = '  '.repeat(depth);
        const first = byId.get(id).md.split('\n')[0];
        if (group) {
            groups += 1;
            lines.push(`${pad}- ${first} (group \`${id}\`):`);
        } else {
            lines.push(`${pad}- **${id}**: ${first}`);
        }
    }
    for (const [id, { md }] of byId) if (!listed.has(id)) lines.push(`- **${id}**: ${md.split('\n')[0]}`);
    return { lines, datasets: byId.size - groups, groups };
}

const listingHeader = (n, groups) => `# Available Datasets (${n} dataset${n !== 1 ? 's' : ''}`
    + `${groups ? ` in ${groups} group${groups !== 1 ? 's' : ''}` : ''})\n`;

/**
 * @param {(url: string) => Promise<Object>} fetchJson
 * @param {Object|string} [options] - { url, discovery }, or the catalog URL
 *   url: the catalog.json to serve
 *   discovery: whether browse_stac_catalog is offered, which changes the
 *     not-found hints (geo-query's STAC_DISCOVERY)
 */
export function createCatalog(fetchJson, options = {}) {
    const { url = CATALOG_URL, discovery = true } = typeof options === 'string' ? { url: options } : options;
    let tree = null;             // Promise of { byId, index, errors }

    // Every node is fetched once, in parallel, to any depth up to
    // MAX_CATALOG_DEPTH, as geo-query#433 walks it, so a group is never taken
    // for a dataset. A node that cannot be read is reported, not fatal.
    const read = async (href) => {
        const d = await fetchJson(href);
        if (d?.type !== 'Catalog' && d?.type !== 'Collection') {
            throw new Error(`STACTypeError: ${href} is a ${d?.type === undefined ? 'None' : `'${d.type}'`}, not a Catalog or Collection`);
        }
        return resolveHrefs(d, href);
    };
    const walk = async () => {
        const root = await read(url);
        const nodes = new Map();
        const kidsOf = new Map([[url, childLinks(root).map(l => l.href)]]);
        const visited = new Set([url, ...kidsOf.get(url)]);
        const errors = new Map();
        const fetchNode = async (href, title, depth) => {
            let doc;
            try {
                doc = await read(href);
            } catch (err) {
                const msg = String(err.message ?? err);
                const kind = /^HTTP \d/.test(msg) ? 'HTTPError' : (err.name ?? 'Error');
                errors.set(childIdentifier(href, title), /^\w+Error: /.test(msg) ? msg : `${kind}: ${msg}`);
                return;
            }
            nodes.set(href, doc);
            const links = childLinks(doc);
            kidsOf.set(href, links.map(l => l.href));
            await Promise.all(links.map((l) => {
                if (visited.has(l.href)) return null;
                visited.add(l.href);
                if (depth + 1 > MAX_CATALOG_DEPTH) {
                    errors.set(childIdentifier(l.href, l.title), `DepthLimit: more than ${MAX_CATALOG_DEPTH} levels below the root`);
                    return null;
                }
                return fetchNode(l.href, l.title, depth + 1);
            }));
        };
        await Promise.all(childLinks(root).map(l => fetchNode(l.href, l.title, 1)));
        return { ...assemble(url, nodes, kidsOf), errors };
    };
    const load = () => {
        tree ??= walk().catch((e) => { tree = null; throw e; });
        return tree;
    };
    /** { value: { doc, md, dict } }, { candidates }, or null. */
    const find = async (id) => lookup((await load()).byId, id);
    const searched = `this server's catalog (${url})`;
    const hint = (noun) => (discovery ? ` Use browse_stac_catalog to list available ${noun}.` : '');
    const ambiguous = (noun, id, ids) =>
        `${noun} '${id}' not found in ${searched}: it matches more than one. Use one of the full ids: ${ids.map(i => `\`${i}\``).join(', ')}.`;

    return {
        url,
        discovery,
        /** Markdown list of the catalog's datasets under their groups; `inline` is a Catalog dict with nested children. */
        async browse(inline = null) {
            if (inline) {
                const nodes = new Map();
                const kidsOf = new Map([['', []]]);
                const add = (d, parent) => {
                    const { col, children } = inlineCollection(d);
                    const key = `${parent}/${col.id}`;
                    kidsOf.get(parent).push(key);
                    nodes.set(key, { type: 'Collection', ...col });
                    kidsOf.set(key, []);
                    for (const c of children) add(c, key);
                };
                for (const c of inline.children ?? []) add(c, '');
                const { lines, datasets, groups } = renderListing(...Object.values(assemble('', nodes, kidsOf)));
                return [listingHeader(datasets, groups), `STAC catalog: \`${inline.id ?? '<inline>'}\` (provided inline)\n`, ...lines].join('\n');
            }
            const { byId, index, errors } = await load();
            if (!byId.size && !errors.size) return `No datasets loaded. STAC catalog: ${url}`;
            const { lines, datasets, groups } = renderListing(byId, index);
            const out = [listingHeader(datasets, groups), `STAC catalog: \`${url}\`\n`, ...lines];
            if (errors.size) {
                const pairs = [...errors].map(([k, v]) => `${k} (${v.split(':')[0]})`).join(', ');
                out.push('', `⚠️ ${errors.size} collection${errors.size !== 1 ? 's' : ''} could not be loaded: ${pairs}`);
            }
            return out.join('\n');
        },
        /** Markdown for a dataset or group; `inline` is a Collection dict, optionally with children. */
        async details(id, inline = null) {
            if (inline) {
                const { col, children: subs } = inlineCollection(inline);
                return formatCollection(col, subs.map(sc => inlineCollection(sc).col));
            }
            const found = await find(id);
            if (found?.candidates) return ambiguous('Dataset', id, found.candidates);
            if (!found) return `Dataset '${id}' not found in ${searched}.${hint('datasets')}`;
            return found.value.md;
        },
        /**
         * The dataset that lists an asset at this href, with its H3 hex
         * parquet assets and the asset's CRS; or null, also when the catalog
         * cannot be read. zonal_stats uses it to send the model to a hex copy.
         * The whole catalog is walked, so this does not depend on what the
         * model has looked up.
         */
        async assetFor(href) {
            let byId;
            try {
                ({ byId } = await load());
            } catch {
                return null;
            }
            const want = hrefToS3(href);
            for (const { doc } of byId.values()) {
                const assets = Object.entries(doc.assets ?? {});
                const hit = assets.find(([, a]) => a?.href && hrefToS3(a.href) === want);
                if (!hit) continue;
                const hex = assets
                    .filter(([, a]) => a?.href && isQueryable(a.href, a.type ?? '')
                        && (a['h3:native_resolution'] != null || a.href.includes('/hex/')))
                    .map(([key, a]) => ({ key, path: hrefToS3(a.href) }));
                const a = hit[1];
                const crs = a['proj:code'] ?? (a['proj:epsg'] ? `EPSG:${a['proj:epsg']}` : null)
                    ?? doc.summaries?.['proj:code']?.[0] ?? null;
                return { collection: doc.id, asset: hit[0], hex, crs };
            }
            return null;
        },
        /** Structured metadata for a dataset or group (geo-query's get_collection). */
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
            if (found?.candidates) return { error: ambiguous('Collection', id, found.candidates) };
            if (!found) return { error: `Collection '${id}' not found in ${searched}.${hint('collections')}` };
            return found.value.dict;
        },
    };
}
