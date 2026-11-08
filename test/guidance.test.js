import { describe, it, expect } from 'vitest';
import { selectTiers, loadGuidance, guidanceUrl, GEO_QUERY_REF } from '../src/guidance.js';

const DOC = `# Guide

## Core rule
<!-- prov: #1, tier=core -->
Keep me.

## Weak-model rule
<!-- prov: #2, tier=extra -->
Drop me.

### Its child
Drop me too.

## Untiered rule
Keep me as well; tier=extra in prose does not count.
`;

describe("geo-query's guidance", () => {
    it('drops tier=extra sections with their children, and prov lines always', () => {
        const core = selectTiers(DOC);
        expect(core).toContain('Keep me.');
        expect(core).toContain('Keep me as well');
        expect(core).not.toContain('Drop me');
        expect(core).not.toContain('prov:');
        const all = selectTiers(DOC, true);
        expect(all).toContain('Drop me too.');
        expect(all).not.toContain('prov:');
    });

    it('fetches the files at the pinned commit, and still starts without them', async () => {
        const seen = [];
        const g = await loadGuidance({ fetchText: async (url) => {
            seen.push(url);
            if (url.endsWith('h3-guide.md')) throw new Error('HTTP 503');
            return DOC;
        } });
        expect(seen[0]).toBe(guidanceUrl('query-optimization.md'));
        expect(seen[0]).toContain(`geo-query@${GEO_QUERY_REF}/`);
        expect(g.optim).not.toContain('Drop me');
        expect(g.h3).toBe('');
        expect(g.error).toBe('could not fetch geo-query guidance: h3-guide.md');
    });
});
