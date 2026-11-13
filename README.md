# Network Alert

[networkalert.dev](https://networkalert.dev): recurso público y gratuito que compila, cada 10 minutos, los riesgos de Internet que pueden afectar a quien mantiene sitios y apps. Vulnerabilidades explotadas, caídas de plataformas y cortes de Internet por país, cada uno con su fuente enlazada.

## Cómo está hecho

| Pieza | Dónde | Qué hace |
|---|---|---|
| Recolector | `ingest/run.mjs`, `ingest/fuentes.mjs` | Lee las fuentes, normaliza y arma la instantánea. Sin dependencias. Corre en GitHub Actions. |
| Worker | `worker/index.ts` | API `/api/v1/*`, RSS, JSON Feed, insignia y recepción de la instantánea (KV). |
| Sitio | `src/` (Astro estático) | Panel, guía, fuentes, metodología, API, apoyar. |
| Vigía privado | `ingest/vigia.mjs` | Revisa tus propios dominios (lista en `dominios.txt`, fuera del repo). |

Todo corre en planes gratuitos: Cloudflare Workers con assets estáticos, un espacio KV (una escritura cada 10 min) y GitHub Actions de repositorio público.

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
