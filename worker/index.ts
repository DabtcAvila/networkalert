/**
 * Worker de networkalert.dev. Solo atiende lo dinámico (ver `run_worker_first` en wrangler.jsonc);
 * las páginas y assets los sirve Cloudflare directamente, sin gastar invocaciones.
 *
 *  GET  /health                     estado del servicio y antigüedad del dato
 *  GET  /api/v1/snapshot.json       instantánea completa
 *  GET  /api/v1/status              nivel global y conteos (ligero)
 *  GET  /api/v1/alerts              alertas con filtros
 *  GET  /api/v1/platforms           estado de plataformas
 *  GET  /api/v1/sources             catálogo de fuentes con su última lectura
 *  GET  /feed.xml · /feed.json      alertas altas y críticas (RSS 2.0 / JSON Feed 1.1)
 *  GET  /badge.svg                  insignia del nivel actual
 *  POST /api/ingest                 recibe la instantánea del recolector (Bearer NA_INGEST_KEY)
 *  GET  /api/v1/check?domain=   revisa un dominio desde fuera (certificado, vencimiento, correo, redirecciones)
 *  GET  /api/donar/estado           ¿están abiertas las donaciones?
 *  POST /api/donar                  crea el cobro en Mercado Pago y devuelve el enlace de pago
 *
 * Convenciones: respuestas planas con procedencia arriba,
 * errores {"detail": …}, CORS abierto para lectura, Cache-Control corto y explícito.
 */
import { normaliza, revisar } from './revisar';
import { aplica, completa, type IA, type Mapa } from './traducir';

interface Env {
  ASSETS: { fetch: typeof fetch };
  NA_KV: KVNamespace;
  LIMITE?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  // Límite propio, más estricto, para la revisión de dominios (cada una hace varias consultas hacia fuera).
  LIMITE_REVISAR?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  // Workers AI: traduce los títulos al español (cuota gratuita). Sin este enlace, los títulos quedan en su idioma original.
  AI?: IA;
  NA_INGEST_KEY?: string;
  // Reloj del recolector: permiso de GitHub limitado a «Actions» de este repositorio (`wrangler secret put GH_DISPATCH_TOKEN`).
  GH_DISPATCH_TOKEN?: string;
  // Donaciones: Access Token de la aplicación de Mercado Pago del titular (`wrangler secret put MP_ACCESS_TOKEN`).
  MP_ACCESS_TOKEN?: string;
  MP_API_BASE?: string;
}

const VERSION = '1.0.0';
const SITIO = 'https://networkalert.dev';
const CLAVE = 'snapshot:v1';
const CLAVE_TITULOS = 'titulos:es:v1';
const CUERPO_MAX = 2 * 1024 * 1024;
const ORDEN: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const NOTAS = [
  'Cada alerta enlaza a su fuente primaria en `url`; verifica ahí antes de actuar.',
  '`first_seen` es el momento en que Network Alert vio la alerta por primera vez, no cuando ocurrió.',
  'Una alerta con `stale: true` viene de una fuente que falló en la última lectura; se conserva el último dato conocido.',
];

type Alerta = { id: string; source: string; category: string; severity: string; title: string; title_es?: string; summary?: string; url: string; published: string; updated?: string; first_seen: string; status: string; countries: string[]; tags: string[]; stale?: boolean; extra?: Record<string, unknown> };
type Snapshot = { version: number; generated_at: string; status: { level: string; points: number; factors: Record<string, number> }; counts: Record<string, unknown>; context: Record<string, unknown>; platforms: unknown[]; countries: Record<string, unknown>; alerts: Alerta[]; sources: { id: string; name: string; url: string; license: string; ok: boolean | null }[]; about: Record<string, string> };

// Copia en memoria del aislado: evita una lectura a KV por petición.
let memo: { t: number; texto: string; datos: Snapshot } | null = null;
async function leer(env: Env): Promise<{ texto: string; datos: Snapshot } | null> {
  if (memo && Date.now() - memo.t < 30_000) return memo;
  const texto = await env.NA_KV.get(CLAVE, { cacheTtl: 60 });
  if (!texto) return null;
  memo = { t: Date.now(), texto, datos: JSON.parse(texto) as Snapshot };
  return memo;
}

const BASE = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': '*', Vary: 'Origin' };
const responde = (cuerpo: string, tipo: string, cache = 'public, max-age=60', status = 200, extra: Record<string, string> = {}) =>
  new Response(cuerpo, { status, headers: { 'Content-Type': tipo, 'Cache-Control': cache, ...BASE, ...extra } });
const json = (o: unknown, cache?: string, status = 200, extra: Record<string, string> = {}) => responde(JSON.stringify(o), 'application/json; charset=utf-8', cache, status, extra);
const fallo = (status: number, detail: unknown, extra: Record<string, string> = {}) => json({ detail }, 'no-store', status, extra);
const xml = (s: unknown) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

function procedencia(s: Snapshot) {
  return { source: 'Network Alert (compilación de fuentes públicas)', source_url: `${SITIO}/fuentes`, license: s.about.license, generated_at: s.generated_at, age_s: Math.max(0, Math.round((Date.now() - Date.parse(s.generated_at)) / 1000)), notes: NOTAS };
}

function alertas(s: Snapshot, q: URLSearchParams): Response {
  const lista = (k: string) => q.get(k)?.toLowerCase().split(',').map((x) => x.trim()).filter(Boolean) ?? null;
  const cat = lista('category'), sev = lista('severity'), fuente = lista('source'), pais = lista('country'), eti = lista('tag');
  const minSev = q.get('min_severity');
  if (minSev && !(minSev in ORDEN)) return fallo(422, [{ type: 'enum', loc: ['query', 'min_severity'], msg: `Valores: ${Object.keys(ORDEN).join(', ')}`, input: minSev }]);
  const desde = q.get('since') ? Date.parse(q.get('since')!) : null;
  if (desde !== null && Number.isNaN(desde)) return fallo(422, [{ type: 'datetime', loc: ['query', 'since'], msg: 'Fecha ISO 8601 inválida', input: q.get('since') }]);
  const limite = Math.min(500, Math.max(1, Number(q.get('limit') ?? 100) || 100));
  const texto = q.get('q')?.toLowerCase();
  const todas = s.alerts.filter((a) =>
    (!cat || cat.includes(a.category)) && (!sev || sev.includes(a.severity)) && (!fuente || fuente.includes(a.source)) &&
    (!pais || a.countries.some((c) => pais.includes(c.toLowerCase()))) && (!eti || a.tags.some((t) => eti.includes(t.toLowerCase()))) &&
    (!minSev || ORDEN[a.severity] <= ORDEN[minSev]) && (desde === null || Date.parse(a.first_seen) >= desde) &&
    (!texto || `${a.title} ${a.title_es ?? ''} ${a.summary ?? ''} ${a.tags.join(' ')} ${JSON.stringify(a.extra ?? {})}`.toLowerCase().includes(texto)));
  return json({ ...procedencia(s), total: todas.length, returned: Math.min(todas.length, limite), alerts: todas.slice(0, limite) });
}

function feedRss(s: Snapshot): Response {
  const items = s.alerts.filter((a) => ORDEN[a.severity] <= 1 && !a.stale).sort((a, b) => Date.parse(b.first_seen) - Date.parse(a.first_seen)).slice(0, 60);
  const cuerpo = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<title>Network Alert · alertas altas y críticas</title><link>${SITIO}</link><atom:link href="${SITIO}/feed.xml" rel="self" type="application/rss+xml"/>
<description>Vulnerabilidades explotadas, caídas de plataformas y cortes de Internet que pueden afectar tus sitios.</description><language>es-MX</language><lastBuildDate>${new Date(s.generated_at).toUTCString()}</lastBuildDate><ttl>10</ttl>
${items.map((a) => `<item><title>${xml(`[${a.severity === 'critical' ? 'CRÍTICA' : 'ALTA'}] ${a.title_es ?? a.title}`)}</title><link>${xml(a.url)}</link><guid isPermaLink="false">${xml(a.id)}</guid><pubDate>${new Date(a.first_seen).toUTCString()}</pubDate><category>${xml(a.category)}</category><source url="${xml(s.sources.find((f) => f.id === a.source)?.url ?? SITIO)}">${xml(s.sources.find((f) => f.id === a.source)?.name ?? a.source)}</source><description>${xml(a.summary ?? '')}</description></item>`).join('\n')}
</channel></rss>`;
  return responde(cuerpo, 'application/rss+xml; charset=utf-8', 'public, max-age=300');
}

function feedJson(s: Snapshot): Response {
  const items = s.alerts.filter((a) => ORDEN[a.severity] <= 1 && !a.stale).sort((a, b) => Date.parse(b.first_seen) - Date.parse(a.first_seen)).slice(0, 60);
  return responde(JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'Network Alert · alertas altas y críticas', home_page_url: SITIO, feed_url: `${SITIO}/feed.json`, language: 'es-MX',
    items: items.map((a) => ({ id: a.id, url: a.url, title: a.title_es ?? a.title, content_text: a.summary ?? '', date_published: a.first_seen, tags: [a.category, a.severity, ...a.tags] })) }), 'application/feed+json; charset=utf-8', 'public, max-age=300');
}

function insignia(s: Snapshot | null): Response {
  const n = s?.status.level ?? 'unknown';
  const [txt, color] = ({ normal: ['normal', '#2f8f6b'], elevated: ['elevado', '#c98a12'], high: ['alto', '#c8372d'], unknown: ['sin dato', '#6b7480'] } as Record<string, [string, string]>)[n];
  const w = 96 + txt.length * 7;
  return responde(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="Network Alert: ${txt}"><rect width="96" height="20" fill="#14132b"/><rect x="96" width="${w - 96}" height="20" fill="${color}"/><g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="8" y="14">network alert</text><text x="103" y="14">${txt}</text></g></svg>`, 'image/svg+xml; charset=utf-8', 'public, max-age=300');
}

// Comparación en tiempo constante para la llave del recolector.
async function llaveValida(dada: string, real: string): Promise<boolean> {
  const h = async (t: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)));
  const [a, b] = await Promise.all([h(dada), h(real)]);
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

async function ingest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.NA_INGEST_KEY) return fallo(503, 'Ingestión no configurada.');
  const dada = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!dada || !(await llaveValida(dada, env.NA_INGEST_KEY))) return fallo(401, 'No autorizado.');
  const texto = await request.text();
  if (texto.length > CUERPO_MAX) return fallo(413, 'Instantánea demasiado grande.');
  let s: Snapshot;
  try { s = JSON.parse(texto) as Snapshot; } catch { return fallo(400, 'JSON inválido.'); }
  if (s?.version !== 1 || !Array.isArray(s.alerts) || !Array.isArray(s.sources) || !s.status?.level || Number.isNaN(Date.parse(s.generated_at))) return fallo(422, 'La instantánea no cumple el esquema v1.');
  if (s.alerts.some((a) => !a.id || !a.title || !/^https:\/\//.test(a.url))) return fallo(422, 'Hay alertas sin fuente enlazada.');
  // Títulos en español: se aplican los ya traducidos y, tras responder, se traducen los nuevos.
  const mapa = ((await env.NA_KV.get(CLAVE_TITULOS, 'json').catch(() => null)) as Mapa | null) ?? {};
  aplica(s.alerts, mapa);
  const guarda = async () => { const t = JSON.stringify(s); await env.NA_KV.put(CLAVE, t); memo = { t: Date.now(), texto: t, datos: s }; };
  await guarda();
  if (env.AI) ctx.waitUntil((async () => {
    if (!(await completa(env.AI!, s.alerts, mapa))) return;
    await env.NA_KV.put(CLAVE_TITULOS, JSON.stringify(mapa));
    aplica(s.alerts, mapa);
    await guarda();
  })().catch((e) => console.error('traducir', String(e))));
  return json({ ok: true, alerts: s.alerts.length, generated_at: s.generated_at }, 'no-store');
}

// ---------------------------------------------------------------------------
// Donaciones con Mercado Pago: sin SDK, la persona paga en la página
// de Mercado Pago, aquí nunca pasa ni se guarda un dato de tarjeta. No hay nada que registrar: sin base ni webhook.
//   única   → Checkout Pro (POST /checkout/preferences)
//   mensual → suscripción sin plan (POST /preapproval), cancelable desde la cuenta de Mercado Pago de quien dona
// ---------------------------------------------------------------------------
const DON_MIN = 20, DON_MAX = 20_000;
const mpListo = (env: Env) => typeof env.MP_ACCESS_TOKEN === 'string' && env.MP_ACCESS_TOKEN.length > 20;

async function mp(env: Env, ruta: string, cuerpo: unknown): Promise<{ status: number; cuerpo: any }> {
  try {
    const r = await fetch((env.MP_API_BASE ?? 'https://api.mercadopago.com').replace(/\/$/, '') + ruta, {
      method: 'POST', signal: AbortSignal.timeout(15_000), body: JSON.stringify(cuerpo),
      headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`, Accept: 'application/json', 'Content-Type': 'application/json', 'X-Idempotency-Key': crypto.randomUUID() },
    });
    return { status: r.status, cuerpo: await r.json().catch(() => null) };
  } catch { return { status: 0, cuerpo: null }; }
}

async function donar(request: Request, env: Env, origen: string): Promise<Response> {
  if (!mpListo(env)) return fallo(503, 'Las donaciones todavía no están abiertas.');
  // Solo el propio sitio puede pedir un enlace de pago.
  if (request.headers.get('origin') !== origen) return fallo(403, 'Origen no permitido.');
  let b: { monto?: unknown; frecuencia?: unknown; correo?: unknown };
  try { b = JSON.parse((await request.text()).slice(0, 2000)); } catch { return fallo(400, 'JSON inválido.'); }
  const monto = Number(b?.monto);
  if (!Number.isInteger(monto) || monto < DON_MIN || monto > DON_MAX) return fallo(422, [{ type: 'range', loc: ['body', 'monto'], msg: `Monto entero en pesos, entre ${DON_MIN} y ${DON_MAX}.`, input: b?.monto ?? null }]);
  const mensual = b?.frecuencia === 'mensual';
  if (!mensual && b?.frecuencia !== 'unica') return fallo(422, [{ type: 'enum', loc: ['body', 'frecuencia'], msg: 'Valores: unica, mensual', input: b?.frecuencia ?? null }]);
  const correo = typeof b?.correo === 'string' ? b.correo.trim().toLowerCase() : '';
  if (mensual && !/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/.test(correo)) return fallo(422, [{ type: 'email', loc: ['body', 'correo'], msg: 'Para el apoyo mensual Mercado Pago necesita el correo de tu cuenta.', input: null }]);

  const ref = `NA-DON-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const gracias = `${origen}/apoyar/gracias`;
  const r = mensual
    ? await mp(env, '/preapproval', { reason: 'Apoyo mensual a Network Alert', external_reference: ref, payer_email: correo, auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: monto, currency_id: 'MXN' }, back_url: gracias, status: 'pending' })
    : await mp(env, '/checkout/preferences', {
        items: [{ id: 'donacion', title: 'Donación a Network Alert', description: 'Donación voluntaria para sostener networkalert.dev', category_id: 'donations', quantity: 1, currency_id: 'MXN', unit_price: monto }],
        back_urls: { success: gracias, pending: `${gracias}?estado=pendiente`, failure: `${origen}/apoyar?estado=error` }, auto_return: 'approved',
        external_reference: ref, statement_descriptor: 'NETWORKALERT', payment_methods: { installments: 1, default_installments: 1 },
      });
  const enlace = r.cuerpo?.init_point;
  if (r.status < 200 || r.status >= 300 || typeof enlace !== 'string' || !/^https:\/\//.test(enlace)) {
    console.error('mp', r.status, JSON.stringify(r.cuerpo)?.slice(0, 300));
    return fallo(502, 'Mercado Pago no respondió. Intenta de nuevo en un momento.');
  }
  return json({ url: enlace, referencia: ref }, 'no-store');
}

// Revisión de un dominio. Se cachea 10 minutos por dominio para no repetir consultas hacia fuera.
async function revisa(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const dado = url.searchParams.get('domain') ?? '';
  const dominio = normaliza(dado);
  if (!dominio) return fallo(422, [{ type: 'domain', loc: ['query', 'domain'], msg: 'Escribe un dominio público, por ejemplo: ejemplo.com', input: dado.slice(0, 80) }]);
  const llave = new Request(`${SITIO}/__revisar/v2/${dominio}`);
  const cache = (caches as unknown as { default: Cache }).default;
  const previa = await cache.match(llave).catch(() => undefined);
  if (previa) return previa;
  if (env.LIMITE_REVISAR) {
    const { success } = await env.LIMITE_REVISAR.limit({ key: request.headers.get('cf-connecting-ip') ?? 'anon' });
    if (!success) return fallo(429, 'Demasiadas revisiones seguidas. Espera un minuto.', { 'Retry-After': '60' });
  }
  // El propio sitio se lee de sus archivos: un Worker no puede pedirse a sí mismo por la red.
  const r = await revisar(dominio, dominio === url.hostname ? (u) => env.ASSETS.fetch(new Request(u)) : undefined);
  if (!r) return fallo(404, `El dominio ${dominio} no existe o no tiene DNS.`);
  const res = json(r, 'public, max-age=600');
  ctx.waitUntil(cache.put(llave, res.clone()).catch(() => {}));
  return res;
}

// Reloj del recolector. El cron de GitHub Actions puede atrasarse horas o no arrancar; este reloj de Cloudflare
// corre cada 5 minutos y, si el dato tiene 9 minutos o más, pide a GitHub que ejecute el recolector.
const REPO = 'DabtcAvila/networkalert';
async function reloj(env: Env): Promise<void> {
  if (!env.GH_DISPATCH_TOKEN) return;
  const texto = await env.NA_KV.get(CLAVE);
  const edad = texto ? Date.now() - Date.parse((JSON.parse(texto) as Snapshot).generated_at) : Infinity;
  if (edad < 9 * 60_000) return;
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/recolector.yml/dispatches`, {
    method: 'POST', signal: AbortSignal.timeout(15_000), body: JSON.stringify({ ref: 'main' }),
    headers: { Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'networkalert-reloj', 'Content-Type': 'application/json' },
  });
  if (!r.ok) console.error('reloj', r.status, (await r.text()).slice(0, 200));
}

export default {
  async scheduled(_evento: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(reloj(env).catch((e) => console.error('reloj', String(e))));
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const ruta = url.pathname.replace(/\/$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...BASE, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' } });
    if (ruta === '/api/ingest') return request.method === 'POST' ? ingest(request, env, ctx) : fallo(405, 'Método no permitido.', { Allow: 'POST' });
    const esDonar = ruta === '/api/donar' && request.method === 'POST';
    if (!esDonar && request.method !== 'GET' && request.method !== 'HEAD') return fallo(405, 'Método no permitido.', { Allow: ruta === '/api/donar' ? 'POST' : 'GET, HEAD, OPTIONS' });

    if (env.LIMITE) {
      const { success } = await env.LIMITE.limit({ key: request.headers.get('cf-connecting-ip') ?? 'anon' });
      if (!success) return fallo(429, 'Rate limit exceeded. Try again later.', { 'Retry-After': '60' });
    }
    if (esDonar) return donar(request, env, url.origin);
    if (ruta === '/api/donar') return fallo(405, 'Método no permitido.', { Allow: 'POST' });
    if (ruta === '/api/donar/estado') return json({ abierto: mpListo(env), minimo_mxn: DON_MIN, maximo_mxn: DON_MAX }, 'no-store');

    if (ruta === '/api/v1/check') return revisa(request, env, ctx, url);

    const snap = await leer(env);
    if (ruta === '/health') {
      const edad = snap ? Math.round((Date.now() - Date.parse(snap.datos.generated_at)) / 1000) : null;
      return json({ status: !snap ? 'sin_datos' : edad! > 3600 ? 'atrasado' : 'ok', version: VERSION, hora_utc: new Date().toISOString(), generated_at: snap?.datos.generated_at ?? null, age_s: edad }, 'no-store', snap ? 200 : 503);
    }
    if (ruta === '/badge.svg') return insignia(snap?.datos ?? null);
    if (!snap) return fallo(503, 'Todavía no hay una instantánea publicada.', { 'Retry-After': '120' });
    const s = snap.datos;

    switch (ruta) {
      case '/api/v1/snapshot.json': return responde(snap.texto, 'application/json; charset=utf-8');
      case '/api/v1/status': return json({ ...procedencia(s), status: s.status, counts: s.counts, context: s.context });
      case '/api/v1/alerts': return alertas(s, url.searchParams);
      case '/api/v1/platforms': return json({ ...procedencia(s), platforms: s.platforms });
      case '/api/v1/sources': return json({ ...procedencia(s), sources: s.sources });
      case '/feed.xml': return feedRss(s);
      case '/feed.json': return feedJson(s);
    }
    if (ruta.startsWith('/api/')) return fallo(404, 'Ruta no encontrada. Documentación: https://networkalert.dev/api');
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
