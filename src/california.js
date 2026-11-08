/**
 * Server instructions for the demo page: California-only copies of eight GLEN
 * hex datasets, one small parquet file per county, from the tpl-cities browser
 * tile set (tpl-cities/notes/in-browser.md). A county's file holds the
 * county's cells plus some just over its border. These are much faster to read
 * from a browser than the national files, whose scans take many serial
 * requests.
 *
 * This is app configuration, not part of the server: the page passes it to the
 * worker as `instructions`.
 */

export const TILES_S3 = 's3://us-west-2.opendata.source.coop/cboettig/tpl-cities/browser-tiles';

export const DATASETS = [
    {
        table: 'acs_blockgroups',
        path: 'public-census/acs-2020-2024/blockgroup/hex',
        description: 'American Community Survey 2020-2024 5-year estimates by census block group. TotPop = total population, MHHI = median household income (USD). GEOID identifies the block group.',
    },
    {
        table: 'census_tracts',
        path: 'public-census/census-2024/tract/hex',
        description: 'Census 2024 tract boundaries. GEOID identifies the tract; ALAND and AWATER are land and water area in square metres.',
    },
    {
        table: 'places',
        path: 'public-census/census-2024/place/hex',
        description: 'Census 2024 places (cities and census-designated places). NAME is the place name, GEOID its identifier.',
    },
    {
        table: 'calenviroscreen',
        path: 'public-calenviroscreen/calenviroscreen-5-0/ces5/hex',
        description: 'CalEnviroScreen 5.0 by census tract. CIscore_Pctl = cumulative pollution-burden and vulnerability score as a statewide percentile (higher is more burdened); Population = tract population; tract = tract number.',
    },
    {
        table: 'disadvantaged_communities',
        path: 'public-ca-dac/dac-2023/tract/hex',
        description: 'California disadvantaged communities (DWR, 2023) by census tract. DAC23 is Y/N; Pop23 = tract population.',
    },
    {
        table: 'fire_perimeters',
        path: 'public-fire/calfire-2025/firep/hex',
        description: 'CAL FIRE historical fire perimeters (2025 release). YEAR_ = fire year; _cng_fid identifies the fire perimeter.',
    },
    {
        table: 'wildfire_hazard',
        path: 'public-fire/whp-2023-classified-conus/hex',
        description: 'USDA Forest Service Wildfire Hazard Potential 2023, classified. whp_class: 1 very low, 2 low, 3 moderate, 4 high, 5 very high, 6 non-burnable, 7 water. Indexed at H3 resolution 9 only (h9, no h10).',
    },
    {
        table: 'flood_hazard',
        path: 'public-hazard/flood-hazard/hex',
        description: 'FEMA flood hazard zones. FLD_ZONE = zone code (A, AE, VE, X, ...); SFHA_TF = T where the cell is in a Special Flood Hazard Area (the 1% annual-chance floodplain).',
    },
];

/** Instructions naming the county files, for the worker's `instructions` option. */
export function instructions() {
    return [
        'Reads from this browser are slow over the national hex files, so prefer the California county files below when a question is about California.',
        '',
        `California county files: ${TILES_S3}/<path>/<county>.parquet, where <county> is the state+county FIPS code, e.g. 06001 for Alameda. These small files answer California county questions fastest.`,
        ...DATASETS.map(d => `- ${d.path}: ${d.description}`),
        'In these files each row is one H3 cell of one feature: h10 (resolution 10, ~0.015 km² per cell), with h9, h8 and h0 parents. The wildfire hazard files have h9, h8 and h0 only.',
        'A feature\'s attributes repeat on every one of its cells, so do not SUM a feature attribute over rows. Count each feature once, e.g. SELECT SUM(TotPop) FROM (SELECT DISTINCT GEOID, TotPop FROM read_parquet(\'.../06001.parquet\')).',
        'Area: COUNT(DISTINCT h10) * 0.015 km². A county file includes some cells just over the county border; filter on a GEOID or county column when the boundary matters.',
        '',
        'For anything else, call browse_stac_catalog for dataset IDs, then get_stac_details for paths and columns.',
    ].join('\n');
}
