import { describe, it, expect } from 'vitest';
import { createCatalog, hrefToS3, routeHint } from '../src/stac.js';

// A two-level catalog shaped like GLEN's: a parent collection whose sub-
// collections hold the parquet assets, as public-wdpa does.

const NRP = 'https://s3-west.nrp-nautilus.io';
const DOCS = {
    [`${NRP}/public-data/stac/catalog.json`]: {
        id: 'catalog',
        links: [
            { rel: 'self', href: `${NRP}/public-data/stac/catalog.json` },
            { rel: 'child', id: 'protected-planet', title: 'Protected Planet', href: `${NRP}/public-wdpa/stac-collection.json` },
            { rel: 'child', id: 'cpad-2025b', title: 'CPAD 2025b', href: `${NRP}/public-cpad/stac-collection.json` },
        ],
    },
    [`${NRP}/public-wdpa/stac-collection.json`]: {
        id: 'protected-planet', title: 'Protected Planet', description: 'WDPA and WD-OECM.',
        links: [{ rel: 'child', id: 'wdpa', title: 'WDPA', href: `${NRP}/public-wdpa/wdpa/stac-collection.json` }],
    },
    [`${NRP}/public-wdpa/wdpa/stac-collection.json`]: {
        id: 'wdpa', title: 'WDPA', description: 'Protected areas.',
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
    [`${NRP}/public-cpad/stac-collection.json`]: { id: 'cpad-2025b', title: 'CPAD 2025b', links: [] },
};

function fixture() {
    const fetched = [];
    const fetchJson = async (url) => {
        fetched.push(url);
        if (!DOCS[url]) throw new Error(`HTTP 404 for ${url}`);
        return structuredClone(DOCS[url]);
    };
    return { catalog: createCatalog(fetchJson), fetched };
}

describe('STAC discovery', () => {
    it('rewrites NRP and source.coop hrefs to s3:// paths', () => {
        expect(hrefToS3(`${NRP}/public-wdpa/wdpa.parquet`)).toBe('s3://public-wdpa/wdpa.parquet');
        expect(hrefToS3('https://data.source.coop/cboettig/x/y.parquet')).toBe('s3://us-west-2.opendata.source.coop/cboettig/x/y.parquet');
        expect(hrefToS3('https://example.org/a.parquet')).toBe('https://example.org/a.parquet');
    });

    it('lists the catalog from its child links alone', async () => {
        const { catalog, fetched } = fixture();
        const out = await catalog.browse();
        expect(out).toContain('# Available Datasets (2 collections)');
        expect(out).toContain('- **protected-planet**: **Protected Planet**');
        expect(fetched).toHaveLength(1);
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
        const quiet = createCatalog(async url => structuredClone(DOCS[url]), { discovery: false });
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
        });
        await expect(catalog.browse()).rejects.toThrow('HTTP 503');
        expect(await catalog.browse()).toContain('protected-planet');
    });
});
