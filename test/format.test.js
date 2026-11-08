import { describe, it, expect } from 'vitest';
import { markdownTable } from '../src/format.js';

describe('markdownTable', () => {
    it("says so as geo-query does when there are no rows", () => {
        expect(markdownTable([])).toBe('No results found.');
    });

    it('prints BigInt H3 ids in full, floats to 10 figures, NaN as nan, NULL blank, and escapes pipes', () => {
        const out = markdownTable([{ h: 622203768917753855n, x: 1 / 3, big: 26471500.5, nan: NaN, s: 'a|b', z: null, d: '2024-01-02' }]);
        expect(out.split('\n')[2]).toBe('| 622203768917753855 | 0.3333333333 | 26471500.5 | nan | a\\|b |  | 2024-01-02 |');
    });
});
