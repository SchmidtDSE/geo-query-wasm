import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createCatalog, hrefToS3, routeHint, resolveHrefs } from '../src/stac.js';

// A two-level catalog shaped like GLEN's: a parent collection whose sub-
// collections hold the parquet assets, as public-wdpa does.

const NRP = 'https://s3-west.nrp-nautilus.io';
const DOCS = {
    [`${NRP}/public-data/stac/catalog.json`]: {
        type: 'Catalog', id: 'catalog',
        links: [
            { rel: 'self', href: `${NRP}/public-data/stac/catalog.json` },
            { rel: 'child', id: 'protected-planet', title: 'Protected Planet', href: `${NRP}/public-wdpa/stac-collection.json` },
            { rel: 'child', id: 'cpad-2025b', title: 'CPAD 2025b', href: `${NRP}/public-cpad/stac-collection.json` },
        ],
    },
    [`${NRP}/public-wdpa/stac-collection.json`]: {
        type: 'Collection', id: 'protected-planet', title: 'Protected Planet', description: 'WDPA and WD-OECM.',
        links: [{ rel: 'child', id: 'wdpa', title: 'WDPA', href: `${NRP}/public-wdpa/wdpa/stac-collection.json` }],
    },
    [`${NRP}/public-wdpa/wdpa/stac-collection.json`]: {
        type: 'Collection', id: 'wdpa', title: 'WDPA', description: 'Protected areas.',
        links: [{ rel: 'self', href: `${NRP}/public-wdpa/wdpa/stac-collection.json` }],
        assets: {
            hex: {
                href: `${NRP}/public-wdpa/wdpa/hex/h0=*/data_0.parquet`, type: 'application/x-parquet',
                title: 'WDPA hex', description: 'One row per parcel and cell.', 'h3:native_resolution': 9,
                'table:columns': [{ name: 'SITE_ID', type: 'int64', description: 'Protected area' }, { name: 'h8', type: 'uint64' }],
            },
            flat: {
                href: `${NRP}/public-wdpa/wdpa.parquet`, type: 'application/x-parquet', title: 'WDPA flat',
                'table:columns': [{ name: 'SITE_ID', type: 'int64' }, { name: 'geometry', type: 'binary' }],
            },
            tiles: { href: `${NRP}/public-wdpa/wdpa.pmtiles`, type: 'application/vnd.pmtiles' },
        },
    },
    [`${NRP}/public-cpad/stac-collection.json`]: { type: 'Collection', id: 'cpad-2025b', title: 'CPAD 2025b', links: [] },
};

function fixture() {
    const fetched = [];
    const fetchJson = async (url) => {
        fetched.push(url);
        if (!DOCS[url]) throw new Error(`HTTP 404 for ${url}`);
        return structuredClone(DOCS[url]);
    };
    return { catalog: createCatalog(fetchJson, `${NRP}/public-data/stac/catalog.json`), fetched };
}

describe('STAC discovery', () => {
    it('reads the source.coop mirror by default', () => {
        expect(createCatalog(async () => ({})).url).toBe('https://data.source.coop/cboettig/glen/catalog.json');
    });

    it('rewrites NRP and source.coop hrefs to s3:// paths', () => {
        expect(hrefToS3(`${NRP}/public-wdpa/wdpa.parquet`)).toBe('s3://public-wdpa/wdpa.parquet');
        expect(hrefToS3('https://data.source.coop/cboettig/x/y.parquet')).toBe('s3://us-west-2.opendata.source.coop/cboettig/x/y.parquet');
        expect(hrefToS3('https://example.org/a.parquet')).toBe('https://example.org/a.parquet');
    });

    it('reads every node once and lists datasets under their groups', async () => {
        const { catalog, fetched } = fixture();
        expect(await catalog.browse()).toBe([
            '# Available Datasets (2 datasets in 1 group)\n',
            `STAC catalog: \`${NRP}/public-data/stac/catalog.json\`\n`,
            '- **Protected Planet** (group `protected-planet`):',
            '  - **wdpa**: **WDPA**',
            '- **cpad-2025b**: **CPAD 2025b**',
        ].join('\n'));
        expect(fetched).toHaveLength(4);
        await catalog.details('wdpa');
        expect(fetched).toHaveLength(4);
    });

    it('describes a parent with its sub-datasets, without their columns', async () => {
        const out = await fixture().catalog.details('protected-planet');
        expect(out).toContain('**Sub-datasets (1):**');
        expect(out).toContain("WDPA hex: `read_parquet('s3://public-wdpa/wdpa/hex/h0=*/data_0.parquet')`");
        expect(out).toContain("call get_stac_details('wdpa')");
        expect(out).not.toContain('Column descriptions');
    });

    it('finds a sub-dataset by id and gives its paths and columns once', async () => {
        const out = await fixture().catalog.details('wdpa');
        expect(out).toContain('SQL data (use with `query` tool):');
        expect(out).toContain('    - h3:native_resolution: 9');
        expect(out).toContain('    - columns: `SITE_ID` (int64), `h8` (uint64)');
        expect(out).toContain('    - `SITE_ID` (int64) — Protected area');
        expect(out).not.toContain('pmtiles');
        expect(out).not.toContain('`geometry` (binary) —');
        expect(out.match(/`SITE_ID` \(int64\) —/g)).toHaveLength(1);
    });

    it('matches an id by prefix, and says when nothing matches', async () => {
        const { catalog } = fixture();
        expect(await catalog.details('cpad')).toContain('Collection ID: `cpad-2025b`');
        expect(await catalog.details('nothing-like-it')).toContain("Dataset 'nothing-like-it' not found");
    });

    it("says which catalog it searched, and drops the browse hint without discovery", async () => {
        expect(await fixture().catalog.details('nothing-like-it')).toBe(
            `Dataset 'nothing-like-it' not found in this server's catalog (${NRP}/public-data/stac/catalog.json). Use browse_stac_catalog to list available datasets.`);
        const quiet = createCatalog(async url => structuredClone(DOCS[url]), { url: `${NRP}/public-data/stac/catalog.json`, discovery: false });
        expect(await quiet.details('nothing-like-it')).not.toContain('browse_stac_catalog');
        expect((await quiet.collection('nothing-like-it')).error).toMatch(/^Collection 'nothing-like-it' not found/);
    });

    it('returns structured metadata with s3:// hrefs and nested children', async () => {
        const parent = await fixture().catalog.collection('protected-planet');
        expect(parent.children.map(c => c.id)).toEqual(['wdpa']);
        const wdpa = parent.children[0];
        expect(wdpa.assets.hex.href).toBe('s3://public-wdpa/wdpa/hex/h0=*/data_0.parquet');
        expect(wdpa.assets.hex['table:columns'][0].name).toBe('SITE_ID');
        expect(wdpa.assets.tiles.href).toBe('s3://public-wdpa/wdpa.pmtiles');
        expect(wdpa.links).toEqual([]);
        const leaf = await fixture().catalog.collection('wdpa');
        expect(leaf.children).toBeUndefined();
    });

    it('round-trips get_collection output through the inline collection argument', async () => {
        const { catalog } = fixture();
        const dict = await catalog.collection('protected-planet');
        expect(await catalog.collection('ignored', dict)).toEqual(dict);
        expect(await catalog.details('ignored', dict)).toContain('**Sub-datasets (1):**');
        expect(await catalog.browse({ id: 'mine', children: [dict] })).toContain('- **wdpa**: **WDPA**');
    });

    it('gives routing hints for hrefs on other S3 hosts', async () => {
        expect(routeHint('https://minio.example.org/private-x/a/b.parquet'))
            .toEqual({ path: 's3://private-x/a/b.parquet', endpoint: 'minio.example.org', scope: 's3://private-x' });
        expect(routeHint('https://bucket.s3.us-west-2.amazonaws.com/k.parquet'))
            .toEqual({ path: 's3://bucket/k.parquet', endpoint: 's3.us-west-2.amazonaws.com', scope: 's3://bucket' });
        const out = await createCatalog(async () => ({}), {}).collection('x', {
            id: 'x', assets: { d: { href: 'https://minio.example.org/b/k.parquet', type: 'application/x-parquet' } } });
        expect(out.assets.d).toMatchObject({ href: 'https://minio.example.org/b/k.parquet', s3_href: 's3://b/k.parquet', s3_endpoint: 'minio.example.org' });
    });

    it('retries the catalog after a failed fetch', async () => {
        let fail = true;
        const catalog = createCatalog(async (url) => {
            if (fail) { fail = false; throw new Error('HTTP 503'); }
            return structuredClone(DOCS[url]);
        }, `${NRP}/public-data/stac/catalog.json`);
        await expect(catalog.browse()).rejects.toThrow('HTTP 503');
        expect(await catalog.browse()).toContain('protected-planet');
    });
});

// A Portolan catalog, committed in test/fixtures/portolan and served here as
// if from source.coop: relative hrefs, no self link on the root, a theme
// catalog between the root and its collections, and child links with no ids.

const PORTOLAN = 'https://data.source.coop/example/portolan/';
const FIXTURES = new URL('./fixtures/portolan/', import.meta.url);

function portolan() {
    const fetched = [];
    const fetchJson = async (url) => {
        fetched.push(url);
        if (!url.startsWith(PORTOLAN)) throw new Error(`HTTP 404 for ${url}`);
        try {
            return JSON.parse(await readFile(new URL(url.slice(PORTOLAN.length), FIXTURES), 'utf8'));
        } catch {
            throw new Error(`HTTP 404 for ${url}`);
        }
    };
    return { catalog: createCatalog(fetchJson, `${PORTOLAN}catalog.json`), fetched };
}

describe('Portolan catalogs', () => {
    it('resolves relative hrefs against the document URL and adds a self link', () => {
        const doc = resolveHrefs({
            links: [{ rel: 'child', href: './a/catalog.json' }, { rel: 'root', href: '../catalog.json' }],
            assets: { d: { href: './d.parquet' }, g: { href: 'https://x.org/hex/h0=*/data_0.parquet' }, s: { href: 's3://b/k.parquet' } },
        }, 'https://x.org/c/sub/catalog.json');
        expect(doc.links.map(l => l.href)).toEqual([
            'https://x.org/c/sub/a/catalog.json', 'https://x.org/c/catalog.json', 'https://x.org/c/sub/catalog.json']);
        expect(doc.links.at(-1).rel).toBe('self');
        expect(doc.assets.d.href).toBe('https://x.org/c/sub/d.parquet');
        expect(doc.assets.g.href).toBe('https://x.org/hex/h0=*/data_0.parquet');
        expect(doc.assets.s.href).toBe('s3://b/k.parquet');
    });

    it('lists datasets under their theme catalogs, each once, as geo-query does, and names a missing child', async () => {
        expect(await portolan().catalog.browse()).toBe([
            '# Available Datasets (3 datasets in 2 groups)\n',
            `STAC catalog: \`${PORTOLAN}catalog.json\`\n`,
            '- **government** (group `government`):',
            '  - **government/wards**: **Ward Boundaries (2020)**',
            '  - **government/wards-2010**: **Ward Boundaries (2010)**',
            '- **elections** (group `elections`):',
            '  - **elections/wards**: **Election Wards**',
            '',
            '⚠️ 1 collection could not be loaded: missing (A child that is not there) (HTTPError)',
        ].join('\n'));
    });

    it('gives a collection by its full id with a source.coop s3:// path', async () => {
        const out = await portolan().catalog.details('government/wards');
        expect(out).toContain('Collection ID: `government/wards`');
        expect(out).toContain(`collection_url: \`${PORTOLAN}government/wards/collection.json\``);
        expect(out).toContain("`read_parquet('s3://us-west-2.opendata.source.coop/example/portolan/government/wards/wards.parquet')`");
        expect(out).toContain('    - `population` (int32)');
        expect(out).not.toContain('pmtiles');
    });

    it('finds a collection by its last path segment only when one id ends that way', async () => {
        const { catalog } = portolan();
        expect(await catalog.details('wards-2010')).toContain('Collection ID: `government/wards-2010`');
        expect(await catalog.details('wards')).toBe(
            `Dataset 'wards' not found in this server's catalog (${PORTOLAN}catalog.json): it matches more than one. Use one of the full ids: \`government/wards\`, \`elections/wards\`.`);
        expect((await catalog.collection('wards')).error).toMatch(/^Collection 'wards' not found .* matches more than one/);
    });

    it('lists the datasets of a theme catalog asked for by id', async () => {
        const { catalog } = portolan();
        const out = await catalog.details('government');
        expect(out).toContain('**Sub-datasets (2):**');
        expect(out).toContain('*Ward Boundaries (2020)* (`government/wards`)');
        expect(out).toContain('(`government/wards-2010`)');
        const group = await catalog.collection('government');
        expect(group.type).toBe('Catalog');
        expect(group.extent).toBeUndefined();
        expect(group.children.map(c => c.id)).toEqual(['government/wards', 'government/wards-2010']);
    });

    it('keeps an absolute glob href as written', async () => {
        const out = await portolan().catalog.details('wards-2010');
        expect(out).toContain("`read_parquet('s3://us-west-2.opendata.source.coop/example/portolan/government/wards-2010/hex/h0=*/data_0.parquet')`");
    });

    it('returns structured metadata with resolved hrefs', async () => {
        const col = await portolan().catalog.collection('government/wards');
        expect(col.assets['wards-tiles'].href).toBe('s3://us-west-2.opendata.source.coop/example/portolan/government/wards/wards.pmtiles');
        expect(col.links).toEqual([{ rel: 'describedby', href: `${PORTOLAN}government/wards/README.md` }]);
    });

});
