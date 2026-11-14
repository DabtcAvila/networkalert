# Network Alert

[networkalert.dev](https://networkalert.dev): recurso público y gratuito que compila, cada 10 minutos, los riesgos de Internet que pueden afectar a quien mantiene sitios y apps. Vulnerabilidades explotadas, caídas de plataformas y cortes de Internet por país, cada uno con su fuente enlazada.

## In English

Network Alert is a free, public feed of the Internet risks that can take a website or app down: vulnerabilities exploited in the wild (CISA KEV), critical package advisories (GitHub Advisory Database), status of 25 platforms (hosting, payments, DNS, email) and Internet outages by country, with extra detail for Mexico (by ISP and by state). Everything is refreshed every 10 minutes and links to its primary source. The site is in Spanish.

- **API**: JSON, no key, open CORS. Start at [`/api/v1/status`](https://networkalert.dev/api/v1/status) and [`/api/v1/alerts`](https://networkalert.dev/api/v1/alerts). Spec: [OpenAPI 3.1](https://networkalert.dev/openapi.json). Docs: [networkalert.dev/api](https://networkalert.dev/api).
- **Feeds**: [RSS](https://networkalert.dev/feed.xml) and [JSON Feed](https://networkalert.dev/feed.json) with high and critical alerts.
- **Badge**: `![Network Alert](https://networkalert.dev/badge.svg)`
- **License**: code MIT; data compilation CC BY 4.0 (each alert keeps its source license).

## Cómo está hecho

| Pieza | Dónde | Qué hace |
|---|---|---|
| Recolector | `ingest/run.mjs`, `ingest/fuentes.mjs` | Lee las fuentes, normaliza y arma la instantánea. Sin dependencias. Corre en GitHub Actions. |
| Worker | `worker/index.ts` | API `/api/v1/*`, RSS, JSON Feed, insignia y recepción de la instantánea (KV). |
| México | `ingest/fuentes.mjs` (`iodaMexico`), `/mexico` | Señales de corte por proveedor de Internet y por estado (IODA), con las alertas que tocan al país. |
| Archivo | `worker/archivo.ts`, `worker/paginas.ts` | Guarda cada alerta en D1 la primera vez que se ve y sirve su página (`/alerta/<slug>`), el archivo por mes (`/archivo`) y el sitemap de alertas. La portada y `/alertas` salen con las alertas ya escritas en el HTML. |
| Sitio | `src/` (Astro estático) | Panel, guía, fuentes, metodología, API, apoyar. |
| Vigía privado | `ingest/vigia.mjs` | Revisa tus propios dominios (lista en `dominios.txt`, fuera del repo). |

Todo corre en planes gratuitos: Cloudflare Workers con assets estáticos, un espacio KV (una escritura cada 10 min), una base D1 (el archivo solo escribe lo que cambió en cada lectura) y GitHub Actions de repositorio público.

## Desarrollo

```sh
npm install
npm run ingest            # escribe .datos/snapshot.json
npm run preview           # astro build + wrangler dev en :8787
NA_ORIGEN=http://localhost:8787 NA_INGEST_KEY=<la de .dev.vars> npm run ingest:publicar
npm run vigia             # reporte privado en vigia/reporte.md
```

## Despliegue

- Preview: `npm run deploy:preview` → `networkalert-preview.<cuenta>.workers.dev`.
- Producción: `npm run deploy` (o a mano desde Actions → Deploy). Un push a `main` no despliega. Requiere el KV de producción en `wrangler.jsonc` y `wrangler secret put NA_INGEST_KEY`.

## Agregar una fuente

Una entrada en `FUENTES` de `ingest/fuentes.mjs` con `id`, `name`, `url`, `license` y una función `run` que devuelva alertas con `id`, `title`, `url` (https), `published`, `category` y `severity`. Sin fuente enlazada no se publica.

## Licencias

Código MIT. Compilación de datos CC BY 4.0; cada alerta conserva la licencia de su fuente (`/fuentes`).
