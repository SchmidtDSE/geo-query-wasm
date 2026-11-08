import { describe, it, expect } from 'vitest';
import { planSql, jsonSql, limitSql, secretSql, settingSql, clientSecretSql } from '../src/engine.js';
import { DEFAULTS } from '../src/defaults.js';

describe('engine SQL planning', () => {
    it('applies rewrites in order', () => {
        const { sql, files } = planSql("SELECT * FROM read_parquet('s3://public-ca-dac/x.parquet')", {
            rewrite: [{ from: 's3://public-', to: 's3://us-west-2.opendata.source.coop/cboettig/public-' }],
        });
        expect(sql).toBe("SELECT * FROM read_parquet('s3://us-west-2.opendata.source.coop/cboettig/public-ca-dac/x.parquet')");
        expect(files).toEqual([]);
    });

    it('points whole-fetch URLs at registered files, once each, and leaves others alone', () => {
        const site = 'https://schmidtdse.github.io/tpl/';
        const { sql, files } = planSql(
            `SELECT * FROM read_parquet('${site}a/cells.parquet') JOIN read_parquet('${site}a/cells.parquet') USING (h8)
             JOIN read_parquet('s3://public-x/y.parquet') USING (h8) WHERE n = 'q.parquet'`,
            { fetchWhole: [site] });
        expect(files).toEqual([{ name: '/geo-query-wasm-whole/schmidtdse.github.io/tpl/a/cells.parquet', url: `${site}a/cells.parquet` }]);
        expect(sql.match(/'\/geo-query-wasm-whole\/schmidtdse\.github\.io\/tpl\/a\/cells\.parquet'/g)).toHaveLength(2);
        expect(sql).toContain("'s3://public-x/y.parquet'");
        expect(sql).toContain("'q.parquet'");
    });

    it('wraps a query for JSON rows, dropping a trailing semicolon', () => {
        expect(jsonSql('SELECT 1 AS a;\n')).toBe('SELECT CAST(to_json(list(__q)) AS VARCHAR) AS __json FROM (\nSELECT 1 AS a\n) __q');
    });

    it('wraps a query in a row limit', () => {
        expect(limitSql('SELECT 1;', 51)).toBe('SELECT * FROM (\nSELECT 1\n) __q LIMIT 51');
    });

    it("makes a per-query secret for a caller's anonymous endpoint, as geo-query does", () => {
        expect(clientSecretSql({}, DEFAULTS)).toBeNull();
        expect(clientSecretSql({ endpoint: 'minio.carlboettiger.info' }, DEFAULTS))
            .toBe("CREATE OR REPLACE SECRET client_s3 (TYPE S3, KEY_ID '', SECRET '', URL_STYLE 'path', USE_SSL true, ENDPOINT 'minio.carlboettiger.info', SCOPE 's3://')");
        expect(clientSecretSql({ endpoint: 's3.eu-west-1.amazonaws.com', region: 'eu-west-1', url_style: 'vhost', scope: 's3://b' }, DEFAULTS))
            .toContain("URL_STYLE 'vhost', USE_SSL true, ENDPOINT 's3.eu-west-1.amazonaws.com', REGION 'eu-west-1', SCOPE 's3://b'");
        expect(() => clientSecretSql({ key: 'k' }, DEFAULTS)).toThrow(/s3_secret is required/);
        expect(() => clientSecretSql({ key: 'k', secret: 's' }, DEFAULTS)).toThrow(/not supported in the browser/);
        expect(() => clientSecretSql({ endpoint: 'evil.example.org' }, DEFAULTS)).toThrow(/not an S3 endpoint this server accepts/);
        expect(() => clientSecretSql({ endpoint: 's3.amazonaws.com.evil.org' }, DEFAULTS)).toThrow();
    });

    it('writes anonymous S3 secrets, quoting values', () => {
        expect(secretSql({ name: 'source-coop', endpoint: 's3.us-west-2.amazonaws.com', region: 'us-west-2', scope: "s3://b'" }))
            .toBe("CREATE OR REPLACE SECRET source_coop (TYPE S3, KEY_ID '', SECRET '', URL_STYLE 'path', USE_SSL true, ENDPOINT 's3.us-west-2.amazonaws.com', REGION 'us-west-2', SCOPE 's3://b''')");
        expect(secretSql({ scope: 's3://x' }, 3)).toMatch(/^CREATE OR REPLACE SECRET s3 /);
    });

    it('writes settings of each type and refuses odd names', () => {
        expect(settingSql('enable_geoparquet_conversion', false)).toBe('SET enable_geoparquet_conversion = false');
        expect(settingSql('threads', 2)).toBe('SET threads = 2');
        expect(settingSql('allowed_directories', ['s3://', "a'b"])).toBe("SET allowed_directories = ['s3://', 'a''b']");
        expect(() => settingSql('x; DROP', 1)).toThrow();
    });
});
