/**
 * The model-facing text of geo-query's tools, built from geo-query's own
 * guidance files at a pinned commit, so the two servers describe their tools
 * the same way and a guidance change in geo-query reaches this server by
 * moving the pin.
 *
 * geo-query (server.py) injects query-optimization.md and h3-guide.md into the
 * `query` tool's description, dropping `tier=extra` sections unless
 * EXTRA_INSTRUCTIONS is set, and serves assistant-role.md as the
 * `geospatial-analyst` prompt. This module does the same in the browser, and
 * adds a short section on what differs here.
 */

/** geo-query commit whose guidance files this server serves. */
export const GEO_QUERY_REF = '222cecfd964438c82547c15a8069a85f86b8fa4c';

export const guidanceUrl = (file, ref = GEO_QUERY_REF) =>
    `https://cdn.jsdelivr.net/gh/SchmidtDSE/geo-query@${ref}/${file}`;

// `<!-- prov: ... -->` lines record why a rule exists; geo-query strips them.
const PROV_RE = /^[ \t]*<!--[ \t]*prov:.*?-->[ \t]*\n/gm;
const HEADING_RE = /^(#{2,6})[ \t]+\S/;
const TIER_RE = /\btier=([A-Za-z0-9_-]+)/;

export const stripProv = (text) => text.replace(PROV_RE, '');

/** The tier named by the prov line under the heading at lines[i], or null. */
function sectionTier(lines, i) {
    for (const line of lines.slice(i + 1)) {
        if (!line.trim()) continue;
        if (!/^[ \t]*<!--[ \t]*prov:.*?-->[ \t]*$/.test(line)) return null;
        return line.match(TIER_RE)?.[1].toLowerCase() ?? null;
    }
    return null;
}

/** Drop `tier=extra` sections unless includeExtra; strip prov lines either way (geo-query's select_tiers). */
export function selectTiers(text, includeExtra = false) {
    if (includeExtra) return stripProv(text);
    const lines = text.split('\n');
    const keep = [];
    let i = 0;
    while (i < lines.length) {
        const m = lines[i].match(HEADING_RE);
        if (m && sectionTier(lines, i) === 'extra') {
            const level = m[1].length;
            let j = i + 1;
            while (j < lines.length) {
                const m2 = lines[j].match(HEADING_RE);
                if (m2 && m2[1].length <= level) break;
                j++;
            }
            i = j;
            continue;
        }
        keep.push(lines[i]);
        i++;
    }
    return stripProv(keep.join('\n'));
}

/** What differs in the browser, appended to geo-query's guidance. */
export const BROWSER_NOTES = `
### 🌐 THIS SERVER RUNS IN THE USER'S BROWSER (DuckDB-wasm)
- Never pass s3_key or s3_secret, and never ask the user for keys. Private buckets that the app has set up are read through ordinary s3:// paths with the app's credentials. s3_endpoint, s3_scope, s3_region and s3_url_style work for anonymous sources.
- Only SELECT queries run (also DESCRIBE, SUMMARIZE and FROM-first forms). The server sets up every connection; do not SET, LOAD, INSTALL or CREATE anything.
- Reads go over the network one or two requests at a time, not 100 threads next to the data, so latency sets the speed of a scan. Filter or join on \`h0\` so that only the needed partitions are opened, and select only the columns you need.
- A query stops after 600 seconds, and a scan over every \`h0\` partition of a global dataset can take that long.
- Memory is capped at 4 GB or less.
`;

/**
 * The `query` tool's description, as geo-query's server.py assembles it.
 * `optim` and `h3` are the tier-selected guidance texts ('' if unavailable).
 */
export function queryDescription({ discovery = true, optim = '', h3 = '' } = {}) {
    const discoverStep = discovery ? 'Call `browse_stac_catalog` then `get_stac_details`' : 'Call `get_stac_details`';
    const discoverSteps = discovery
        ? `1. Call \`browse_stac_catalog\` to see all available dataset IDs and titles.
2. Call \`get_stac_details\` with the relevant dataset ID to get exact S3 paths and column schemas.
3. Use ONLY paths returned by those tools — never guess or hardcode any S3 URLs.`
        : `1. Call \`get_stac_details\` with the relevant dataset ID to get exact S3 paths and column schemas.
2. Use ONLY paths returned by that tool — never guess or hardcode any S3 URLs.`;
    const injected = `
---
### ⚠️ CRITICAL SQL RULES (MUST FOLLOW)
1. **NO TABLES EXIST:** The database is empty. You CANNOT write \`FROM table_name\`.
2. **USE PARQUET PATHS:** You MUST use \`FROM read_parquet('s3://...')\` for ALL queries.
3. **DISCOVER PATHS — TRUST STAC PATHS EXACTLY:** ${discoverStep} to get exact S3 paths — then use them **verbatim**. NEVER guess, modify, or "fix" a path. Both path depth and glob pattern vary across datasets — there is no single convention. Examples:
   - \`read_parquet('s3://public-wdpa/wdpa-december-2025/hex/h0=*/data_0.parquet')\` — versioned collection, partition glob
   - \`read_parquet('s3://public-padus/padus-4-1/fee/hex/h0=*/data_0.parquet')\` — nested path, partition glob

   Both are correct. Copy-paste the path from get_stac_details. In SQL examples below, \`<STAC_HEX_PATH>\` means "insert the exact path from get_stac_details here."
4. **MASK BEFORE AGGREGATE (DPP rule).** When joining a small hex mask
   (e.g. state, district, county, protected-areas hexes) against a globally
   \`h0\`-partitioned hex dataset (land cover, climate, biomass — anything
   under \`hex/h0=*/\`), the \`SEMI JOIN\` against the mask MUST appear directly
   on the raw \`read_parquet(...)\` BEFORE \`GROUP BY\`. Aggregating the global
   side first scans every \`h0\` partition and will hit the 300-second MCP
   timeout. DuckDB dynamic partition pruning cannot push filters through
   \`HASH_GROUP_BY\`.
   \`\`\`sql
   SELECT a.h8, MODE(a.lc_class) AS dominant
   FROM read_parquet('<global_hex>', hive_partitioning = true) a
   SEMI JOIN <mask> m USING (h8, h0)
   WHERE a.lc_class IS NOT NULL
   GROUP BY a.h8;
   \`\`\`

### ⚡ OPTIMIZATION RULES
${optim}

### 📐 H3 SPATIAL MATH
${h3}
${BROWSER_NOTES}
---
`;
    return `
Executes optimized DuckDB SQL against S3 parquet files.

BEFORE writing any SQL:
${discoverSteps}

Private buckets that the app has set up are read through ordinary s3:// paths; never pass s3_key or s3_secret.
For an anonymous public source (e.g. a read-only mirror), pass s3_endpoint alone (no key/secret) with s3_scope — useful to read a mirror like s3://public-* from a backup endpoint when the primary is unavailable.
Use s3_scope (e.g. 's3://private-wyoming' or 's3://public-') so DuckDB routes those paths to your endpoint rather than the server default; supply it whenever a query mixes sources.
For an anonymous AWS-hosted bucket, also pass s3_region (e.g. 'us-west-2') and, if the bucket needs it, s3_url_style ('path' by default, or 'vhost'); the defaults suit Ceph/MinIO.
WITHOUT s3_scope, your endpoint applies to EVERY s3:// path in the query and the server-default endpoint is disabled for this request — fine for a query touching only your bucket, wrong for a query mixing your bucket with catalog data. When mixing, always pass s3_scope.

${injected}
`;
}

/**
 * Fetch geo-query's guidance files. Resolves to { optim, h3, role, error };
 * a file that cannot be fetched is '' and named in `error`, so the server
 * still starts.
 */
export async function loadGuidance({ ref = GEO_QUERY_REF, extra = false, fetchText } = {}) {
    fetchText ??= async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return res.text();
    };
    const files = ['query-optimization.md', 'h3-guide.md', 'assistant-role.md'];
    const results = await Promise.allSettled(files.map(f => fetchText(guidanceUrl(f, ref))));
    const text = results.map(r => (r.status === 'fulfilled' ? r.value : ''));
    const failed = files.filter((_, i) => results[i].status === 'rejected');
    return {
        optim: selectTiers(text[0], extra),
        h3: selectTiers(text[1], extra),
        role: text[2],
        error: failed.length ? `could not fetch geo-query guidance: ${failed.join(', ')}` : null,
    };
}
