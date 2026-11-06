import { describe, it, expect } from 'vitest';
import { createCatalog, hrefToS3 } from '../src/stac.js';

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
