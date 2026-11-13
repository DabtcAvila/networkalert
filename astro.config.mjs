// @ts-check
import { defineConfig, fontProviders } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Estático, estilos inline, fuentes autoalojadas (Inter para todo, IBM Plex Mono para código y datos).
export default defineConfig({
  site: 'https://networkalert.dev',
  output: 'static',
  trailingSlash: 'never',
  build: { format: 'directory', inlineStylesheets: 'always' },
  compressHTML: true,
  prefetch: { prefetchAll: true, defaultStrategy: 'hover' },
  // Fuentes autoalojadas en build (se copian a /_astro/fonts): sin peticiones a Google en producción.
  fonts: [
    { provider: fontProviders.google(), name: 'Inter', cssVariable: '--font-text', weights: [400, 500, 600, 700, 800], styles: ['normal'], subsets: ['latin'], fallbacks: ['Helvetica Neue', 'Arial', 'sans-serif'], display: 'swap', optimizedFallbacks: true },
    { provider: fontProviders.google(), name: 'IBM Plex Mono', cssVariable: '--font-ui', weights: [400, 600], styles: ['normal'], subsets: ['latin'], fallbacks: ['ui-monospace', 'Menlo', 'monospace'], display: 'swap', optimizedFallbacks: true },
  ],
  // Los <script> de componentes salen como archivo externo (la CSP no permite scripts inline).
  vite: { build: { assetsInlineLimit: 0 } },
  integrations: [sitemap({ filter: (page) => !page.includes('/apoyar/gracias') })],
});
