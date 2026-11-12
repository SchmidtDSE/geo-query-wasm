// The docs are served under the demo on GitHub Pages: the demo is at
// /geo-query-wasm/ and these pages at /geo-query-wasm/docs/.
export default {
  title: 'geo-query-wasm',
  description: "geo-query's MCP server running in the browser, with DuckDB-wasm in a Web Worker.",
  base: '/geo-query-wasm/docs/',
  cleanUrls: false,

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/quickstart' },
      { text: 'Demo', link: 'https://schmidtdse.github.io/geo-query-wasm/', target: '_blank' },
      { text: 'Releases', link: 'https://github.com/SchmidtDSE/geo-query-wasm/releases', target: '_blank' },
      { text: 'geo-query', link: 'https://schmidtdse.github.io/geo-query/', target: '_blank' },
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Quick start', link: '/guide/quickstart' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Parity with geo-query', link: '/guide/parity' },
        ],
      },
      {
        text: 'Features',
        items: [
          { text: 'Hex tiles', link: '/guide/hex-tiles' },
          { text: 'Zonal statistics', link: '/guide/zonal-statistics' },
          { text: 'Private data', link: '/guide/private-data' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Capabilities and limitations', link: '/capabilities' },
          { text: 'Architecture', link: '/guide/architecture' },
          { text: 'Development', link: '/guide/development' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/SchmidtDSE/geo-query-wasm' },
    ],

    footer: {
      message: 'Released under the Apache-2.0 License.',
    },

    search: {
      provider: 'local',
    },
  },
};
