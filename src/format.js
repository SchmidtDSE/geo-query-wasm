/**
 * Render query rows as a markdown table for the model, as geo-query's `query`
 * tool does (server.py):
 *
 * - at most 50 rows, with geo-query's note when there are more;
 * - "No results found." for no rows;
 * - 64-bit integers in full (an H3 cell id in exponent form names another
 *   cell), floats to 10 significant figures, NULL as an empty cell;
 * - dates and timestamps as the engine renders them (YYYY-MM-DD and
 *   YYYY-MM-DD HH:MM:SS).
 */

export const MAX_ROWS = 50;

export const TRUNCATED_NOTE = '⚠️ Showing the first 50 rows only — this is a preview, not the'
    + ' full result and NOT a count. The true number of matching rows is'
    + ' larger; use COUNT(...) / COUNT(DISTINCT ...) / SUM(...) for totals.';

const cell = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'number') {
        if (Number.isNaN(v)) return 'nan';
        return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(10)));
    }
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object') return JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
    return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
};

export function markdownTable(rows, maxRows = MAX_ROWS) {
    if (!rows.length) return 'No results found.';
    const cols = Object.keys(rows[0]);
    const shown = rows.slice(0, maxRows);
    const lines = [
        `| ${cols.join(' | ')} |`,
        `| ${cols.map(() => '---').join(' | ')} |`,
        ...shown.map(r => `| ${cols.map(c => cell(r[c])).join(' | ')} |`),
    ];
    let md = lines.join('\n');
    if (rows.length > maxRows) md += `\n\n${TRUNCATED_NOTE}`;
    return md;
}
