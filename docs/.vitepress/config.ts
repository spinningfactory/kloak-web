import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Kloak',
  description: 'Kubernetes eBPF Secret Interceptor — Documentation',
  base: '/docs/',
  appearance: 'dark',

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/transparent-logo.svg' }],
  ],

  themeConfig: {
    logo: '/transparent-logo.svg',
    siteTitle: 'LOAK Docs',

    nav: [
      { text: 'Getting Started', link: '/getting-started/installation' },
      { text: 'Guides', link: '/guides/protecting-secrets' },
      { text: 'Tutorials', link: '/tutorials/openclaw-with-kloak' },
      { text: 'Architecture', link: '/architecture/overview' },
      { text: 'Reference', link: '/reference/labels-annotations' },
    ],

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Installation', link: '/getting-started/installation' },
          { text: 'Configuration', link: '/getting-started/configuration' },
          { text: 'Quick Start', link: '/getting-started/quick-start' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Protecting Secrets', link: '/guides/protecting-secrets' },
          { text: 'Host Filtering', link: '/guides/host-filtering' },
          { text: 'Supported Runtimes', link: '/guides/supported-runtimes' },
        ],
      },
      {
        text: 'Tutorials',
        items: [
          { text: 'OpenClaw with Kloak', link: '/tutorials/openclaw-with-kloak' },
        ],
      },
      {
        text: 'Architecture',
        items: [
          { text: 'Overview', link: '/architecture/overview' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Labels & Annotations', link: '/reference/labels-annotations' },
          { text: 'Requirements', link: '/reference/requirements' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/spinningfactory/kloak' },
    ],

footer: {
      message: 'Released under the Apache 2.0 License.',
      copyright: 'Copyright 2025-present Kloak Contributors',
    },

    search: {
      provider: 'local',
    },
  },
})
