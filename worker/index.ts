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
 *  GET  /api/v1/history             historial de funcionamiento por día (lecturas publicadas y atrasos)
 *  GET  /api/v1/mexico              México por estado y por proveedor, con las alertas que lo tocan
 *  GET  /feed.xml · /feed.json      alertas altas y críticas (RSS 2.0 / JSON Feed 1.1)
 *  GET  /badge.svg                  insignia del nivel actual
 *  POST /api/ingest                 recibe la instantánea del recolector (Bearer NA_INGEST_KEY)
 *  GET  /api/v1/check?domain=   revisa un dominio desde fuera (certificado, vencimiento, correo, redirecciones)
 *  GET  /api/donar/estado           ¿están abiertas las donaciones?
 *  POST /api/donar                  cobra la donación con el token de la tarjeta (formulario propio en /apoyar)
 *  POST /api/lista                  pide avisos por correo (o guarda un cambio si trae la llave)
 *  POST /api/lista/confirmar · /ver · /baja   confirmar, leer y borrar una lista con la llave del correo
 *  POST /api/lista/vuelta           corre a mano una vuelta de avisos (Bearer NA_INGEST_KEY)
 *  GET  /alerta/<slug>              página propia de una alerta, activa o archivada (worker/paginas.ts)
 *  GET  /archivo · /archivo/AAAA-MM archivo de alertas por mes
 *  GET  /sitemap-alertas.xml        sitemap de las páginas de alertas
 *  GET  / · /alertas                la página estática con las alertas del momento ya escritas en el HTML
 *  GET  /mexico                     Internet en México: proveedores, estados, alertas y últimos 30 días
 *
 * Convenciones: respuestas planas con procedencia arriba,
 * errores {"detail": …}, CORS abierto para lectura, Cache-Control corto y explícito.
 */
import { baja, confirma, solicita, ver, vuelta, type Correo, type Salida } from './avisos';
import { normaliza, revisar } from './revisar';
import { aplica, aplicaResumenes, completa, completaResumenes, type IA, type Mapa } from './traducir';
import { archiva, delMes, delPais, paraSitemap, porSlug, slugDe, SLUG_VALIDO, type Guardada } from './archivo';
import { descripcionDe, ficha, horaMx, indexable, ldAlerta, listaArchivo, listaHistorial, meses, navMeses, nombreMes, reescribe, renglonHoy, resumenMexico, sitemap, tablero, tarjeta, type Estado, type Mexico } from './paginas';

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
  // Public Key de la misma aplicación: va al navegador para cifrar la tarjeta. Es pública (variable en wrangler.jsonc).
  MP_PUBLIC_KEY?: string;
  MP_API_BASE?: string;
  // Límite propio del cobro: pocos intentos por minuto y conexión.
  LIMITE_DONAR?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  // Avisos por correo de «Mi lista»: base D1, envío de correo y dirección pública del sitio para los enlaces.
  DB?: D1Database;
  EMAIL?: Correo;
  ORIGEN?: string;
}

const VERSION = '1.0.0';
const SITIO = 'https://networkalert.dev';
const CLAVE = 'snapshot:v1';
// v2: glosario corregido («denegación de servicio», «evasión»); al cambiar la clave se vuelve a traducir todo.
// v3: tipos de falla en palabras llanas y comprobación menos estricta del nombre del producto.
const CLAVE_TITULOS = 'titulos:es:v3';
const CLAVE_RESUMENES = 'resumenes:es:v1';
const CUERPO_MAX = 2 * 1024 * 1024;
const ORDEN: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const NOTAS = [
  'Cada alerta enlaza a su fuente primaria en `url`; verifica ahí antes de actuar.',
  '`first_seen` es el momento en que Network Alert vio la alerta por primera vez, no cuando ocurrió.',
  '`page` es la página permanente de la alerta en Network Alert; sigue abierta cuando la alerta deja de estar activa.',
  'Una alerta con `stale: true` viene de una fuente que falló en la última lectura; se conserva el último dato conocido.',
];

type Alerta = { id: string; source: string; category: string; severity: string; title: string; title_es?: string; summary?: string; summary_es?: string; action?: string; escalated_at?: string; url: string; page?: string; published: string; updated?: string; first_seen: string; status: string; countries: string[]; tags: string[]; stale?: boolean; extra?: Record<string, unknown> };
type Snapshot = { version: number; generated_at: string; status: { level: string; points: number; summary?: string; reasons?: string[]; factors: Record<string, number> }; counts: Record<string, unknown>; context: Record<string, unknown>; platforms: unknown[]; countries: Record<string, { alerts: number; severity: string }>; mexico?: Mexico | null; alerts: Alerta[]; sources: { id: string; name: string; url: string; license: string; ok: boolean | null }[]; about: Record<string, string> };

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
    (!texto || `${a.title} ${a.title_es ?? ''} ${a.summary ?? ''} ${a.summary_es ?? ''} ${a.tags.join(' ')} ${JSON.stringify(a.extra ?? {})}`.toLowerCase().includes(texto)));
  return json({ ...procedencia(s), total: todas.length, returned: Math.min(todas.length, limite), alerts: todas.slice(0, limite) });
}

// Para los feeds: una alerta que subió a alta o crítica entra con la fecha en que subió.
const visto = (a: Alerta) => a.escalated_at ?? a.first_seen;

function feedRss(s: Snapshot): Response {
  const items = s.alerts.filter((a) => ORDEN[a.severity] <= 1 && !a.stale).sort((a, b) => Date.parse(visto(b)) - Date.parse(visto(a))).slice(0, 60);
  const cuerpo = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<title>Network Alert · alertas altas y críticas</title><link>${SITIO}</link><atom:link href="${SITIO}/feed.xml" rel="self" type="application/rss+xml"/>
<description>Vulnerabilidades explotadas, caídas de plataformas y cortes de Internet que pueden afectar tus sitios.</description><language>es-MX</language><lastBuildDate>${new Date(s.generated_at).toUTCString()}</lastBuildDate><ttl>10</ttl>
${items.map((a) => `<item><title>${xml(`[${a.severity === 'critical' ? 'CRÍTICA' : 'ALTA'}] ${a.title_es ?? a.title}`)}</title><link>${xml(a.page ?? a.url)}</link><guid isPermaLink="false">${xml(a.id)}</guid><pubDate>${new Date(visto(a)).toUTCString()}</pubDate><category>${xml(a.category)}</category><source url="${xml(s.sources.find((f) => f.id === a.source)?.url ?? SITIO)}">${xml(s.sources.find((f) => f.id === a.source)?.name ?? a.source)}</source><description>${xml([a.summary_es ?? a.summary, a.action && `Qué hacer: ${a.action}`, `Fuente: ${a.url}`].filter(Boolean).join(' '))}</description></item>`).join('\n')}
</channel></rss>`;
  return responde(cuerpo, 'application/rss+xml; charset=utf-8', 'public, max-age=300');
}

function feedJson(s: Snapshot): Response {
  const items = s.alerts.filter((a) => ORDEN[a.severity] <= 1 && !a.stale).sort((a, b) => Date.parse(visto(b)) - Date.parse(visto(a))).slice(0, 60);
  return responde(JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'Network Alert · alertas altas y críticas', home_page_url: SITIO, feed_url: `${SITIO}/feed.json`, language: 'es-MX',
    items: items.map((a) => ({ id: a.id, url: a.page ?? a.url, external_url: a.url, title: a.title_es ?? a.title, content_text: [a.summary_es ?? a.summary, a.action && `Qué hacer: ${a.action}`].filter(Boolean).join(' '), date_published: visto(a), tags: [a.category, a.severity, ...a.tags] })) }), 'application/feed+json; charset=utf-8', 'public, max-age=300');
}

function insignia(s: Snapshot | null): Response {
  const n = s?.status.level ?? 'unknown';
  const [txt, color] = ({ normal: ['normal', '#2f8f6b'], elevated: ['elevado', '#c98a12'], high: ['alto', '#c8372d'], unknown: ['sin dato', '#6b7480'] } as Record<string, [string, string]>)[n];
  const w = 96 + txt.length * 7;
  return responde(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="Network Alert: ${txt}"><rect width="96" height="20" fill="#14132b"/><rect x="96" width="${w - 96}" height="20" fill="${color}"/><g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="8" y="14">network alert</text><text x="103" y="14">${txt}</text></g></svg>`, 'image/svg+xml; charset=utf-8', 'public, max-age=300');
}

// Historial público: una fila por día en D1. Nunca rompe lo que lo llama.
async function anota(env: Env, campos: { lecturas?: number; con_fallas?: number; revisiones?: number; atrasadas?: number }): Promise<void> {
  if (!env.DB) return;
  const v = [campos.lecturas ?? 0, campos.con_fallas ?? 0, campos.revisiones ?? 0, campos.atrasadas ?? 0];
  try {
    await env.DB.prepare('INSERT INTO historial (dia, lecturas, con_fallas, revisiones, atrasadas) VALUES (?, ?, ?, ?, ?) ON CONFLICT (dia) DO UPDATE SET lecturas = lecturas + excluded.lecturas, con_fallas = con_fallas + excluded.con_fallas, revisiones = revisiones + excluded.revisiones, atrasadas = atrasadas + excluded.atrasadas')
      .bind(new Date().toISOString().slice(0, 10), ...v).run();
  } catch (e) { console.error('historial', String(e)); }
}
async function historial(env: Env): Promise<Response> {
  if (!env.DB) return fallo(503, 'Historial no disponible.');
  type Fila = { dia: string; lecturas: number; con_fallas: number; revisiones: number; atrasadas: number };
  let filas: Fila[];
  try { filas = (await env.DB.prepare('SELECT dia, lecturas, con_fallas, revisiones, atrasadas FROM historial ORDER BY dia DESC LIMIT 90').all<Fila>()).results ?? []; }
  catch { return fallo(503, 'Historial no disponible.'); }
  const pct = (bien: number, total: number) => (total ? Math.round((bien / total) * 1000) / 10 : null);
  const dias = filas.map((f) => ({ date: f.dia, readings: f.lecturas, readings_with_source_failures: f.con_fallas, checks: f.revisiones, checks_late: f.atrasadas, on_time_pct: pct(f.revisiones - f.atrasadas, f.revisiones) }));
  const t = filas.reduce((a, f) => ({ r: a.r + f.revisiones, l: a.l + f.atrasadas, n: a.n + f.lecturas }), { r: 0, l: 0, n: 0 });
  return json({
    source: 'Network Alert (registro propio)', source_url: `${SITIO}/quien`, since: filas.at(-1)?.dia ?? null, days_recorded: filas.length,
    totals: { readings: t.n, checks: t.r, checks_late: t.l, on_time_pct: pct(t.r - t.l, t.r) },
    notes: ['Cada 5 minutos se revisa la edad del dato publicado. «Atrasado» es un dato de más de 30 minutos.', 'Se muestran hasta 90 días. Los días van en UTC.'],
    days: dias,
  }, 'public, max-age=300');
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
  // Títulos y resúmenes en español: se aplican los ya traducidos y, tras responder, se traducen los nuevos.
  const [mapa, resumenes] = (await Promise.all([CLAVE_TITULOS, CLAVE_RESUMENES].map((k) => env.NA_KV.get(k, 'json').catch(() => null)))).map((m) => (m as Mapa | null) ?? {});
  aplica(s.alerts, mapa); aplicaResumenes(s.alerts, resumenes);
  // Página permanente de cada alerta.
  const origen = (env.ORIGEN ?? SITIO).replace(/\/$/, '');
  for (const a of s.alerts) a.page = `${origen}/alerta/${slugDe(a)}`;
  const guarda = async () => { const t = JSON.stringify(s); await env.NA_KV.put(CLAVE, t); memo = { t: Date.now(), texto: t, datos: s }; };
  await guarda();
  ctx.waitUntil(anota(env, { lecturas: 1, con_fallas: s.sources.some((f) => f.ok === false) ? 1 : 0 }));
  const traduce = async () => {
    if (!env.AI) return;
    const [t, r] = await Promise.all([completa(env.AI, s.alerts, mapa), completaResumenes(env.AI, s.alerts, resumenes)]);
    if (!t && !r) return;
    if (t) await env.NA_KV.put(CLAVE_TITULOS, JSON.stringify(mapa));
    if (r) await env.NA_KV.put(CLAVE_RESUMENES, JSON.stringify(resumenes));
    aplica(s.alerts, mapa); aplicaResumenes(s.alerts, resumenes);
    await guarda();
  };
  // El archivo se escribe al final, ya con las traducciones, y solo con lo que cambió.
  ctx.waitUntil(traduce().catch((e) => console.error('traducir', String(e)))
    .then(() => (env.DB ? archiva(env.DB, s) : null))
    .then((r) => { if (r && r.guardadas + r.cerradas) console.log('archivo', JSON.stringify(r)); }, (e) => console.error('archivo', String(e))));
  return json({ ok: true, alerts: s.alerts.length, generated_at: s.generated_at }, 'no-store');
}

// ---------------------------------------------------------------------------
// Donaciones: el formulario es nuestro y el cobro lo procesa Mercado Pago por detrás.
// La tarjeta se cifra en el navegador (Secure Fields) y aquí solo llega un token de un uso; nunca se guarda.
//   única   → cobro al momento (POST /v1/payments), aprobado o rechazado, sin estados intermedios
//   mensual → suscripción sin plan con la tarjeta ya autorizada (POST /preapproval)
// ---------------------------------------------------------------------------
const DON_MIN = 20, DON_MAX = 20_000;
const DON_INTENTOS_DIA = 6;      // intentos de cobro por conexión y día
const DON_RECHAZOS_HORA = 15;    // rechazos de todo el sitio en una hora antes de pausar (freno contra prueba de tarjetas robadas)
const mpListo = (env: Env) => typeof env.MP_ACCESS_TOKEN === 'string' && env.MP_ACCESS_TOKEN.length > 20 && typeof env.MP_PUBLIC_KEY === 'string' && /^(APP_USR|TEST)-[A-Za-z0-9-]{20,}$/.test(env.MP_PUBLIC_KEY);

async function mp(env: Env, ruta: string, cuerpo: unknown, extra: Record<string, string> = {}): Promise<{ status: number; cuerpo: any }> {
  try {
    const r = await fetch((env.MP_API_BASE ?? 'https://api.mercadopago.com').replace(/\/$/, '') + ruta, {
      method: 'POST', signal: AbortSignal.timeout(20_000), body: JSON.stringify(cuerpo),
      headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`, Accept: 'application/json', 'Content-Type': 'application/json', ...extra },
    });
    return { status: r.status, cuerpo: await r.json().catch(() => null) };
  } catch { return { status: 0, cuerpo: null }; }
}

// Qué decirle a la persona cuando el banco no aprueba.
function rechazo(detalle: string): string {
  const m: Record<string, string> = {
    cc_rejected_insufficient_amount: 'Tu tarjeta no tiene fondos suficientes.',
    cc_rejected_bad_filled_security_code: 'El código de seguridad (CVV) no coincide.',
    cc_rejected_bad_filled_date: 'La fecha de vencimiento no coincide.',
    cc_rejected_bad_filled_card_number: 'Revisa el número de tarjeta.',
    cc_rejected_bad_filled_other: 'Revisa los datos de la tarjeta.',
    cc_rejected_call_for_authorize: 'Tu banco pide que autorices este pago. Llámale y vuelve a intentar.',
    cc_rejected_card_disabled: 'Tu tarjeta está desactivada. Llama a tu banco para activarla.',
    cc_rejected_duplicated_payment: 'Ya hiciste un pago por este monto hace un momento.',
    cc_rejected_high_risk: 'El pago no fue aprobado por seguridad. Prueba con otra tarjeta.',
    cc_rejected_max_attempts: 'Llegaste al límite de intentos con esta tarjeta. Prueba con otra.',
  };
  return m[detalle] ?? 'Tu banco no aprobó el pago. Prueba con otra tarjeta.';
}

// Frenos en D1 (tabla `frenos`): cuentan intentos sin guardar la IP, solo su huella del día.
async function suma(env: Env, clave: string): Promise<number> {
  if (!env.DB) return 0;
  try {
    const f = await env.DB.prepare('INSERT INTO frenos (clave, n, creado) VALUES (?, 1, ?) ON CONFLICT (clave) DO UPDATE SET n = n + 1 RETURNING n').bind(clave, new Date().toISOString()).first<{ n: number }>();
    return f?.n ?? 0;
  } catch (e) { console.error('frenos', String(e)); return 0; }
}
async function cuenta(env: Env, clave: string): Promise<number> {
  if (!env.DB) return 0;
  try { return (await env.DB.prepare('SELECT n FROM frenos WHERE clave = ?').bind(clave).first<{ n: number }>())?.n ?? 0; } catch { return 0; }
}

async function donar(request: Request, env: Env, origen: string, ctx: ExecutionContext): Promise<Response> {
  if (!mpListo(env)) return fallo(503, 'Las donaciones todavía no están abiertas.');
  // Solo el propio sitio puede cobrar.
  if (request.headers.get('origin') !== origen) return fallo(403, 'Origen no permitido.');
  const ip = request.headers.get('cf-connecting-ip') ?? 'anon';
  if (env.LIMITE_DONAR && !(await env.LIMITE_DONAR.limit({ key: ip })).success) return fallo(429, 'Demasiados intentos. Espera un minuto.', { 'Retry-After': '60' });
  let b: { monto?: unknown; frecuencia?: unknown; correo?: unknown; hp?: unknown; pago?: { token?: unknown; payment_method_id?: unknown; issuer_id?: unknown; device_id?: unknown } };
  try { b = JSON.parse((await request.text()).slice(0, 4000)); } catch { return fallo(400, 'JSON inválido.'); }
  if (typeof b?.hp === 'string' && b.hp) return fallo(400, 'Solicitud inválida.');
  const monto = Number(b?.monto);
  if (!Number.isInteger(monto) || monto < DON_MIN || monto > DON_MAX) return fallo(422, [{ type: 'range', loc: ['body', 'monto'], msg: `Monto entero en pesos, entre ${DON_MIN} y ${DON_MAX}.`, input: b?.monto ?? null }]);
  const mensual = b?.frecuencia === 'mensual';
  if (!mensual && b?.frecuencia !== 'unica') return fallo(422, [{ type: 'enum', loc: ['body', 'frecuencia'], msg: 'Valores: unica, mensual', input: b?.frecuencia ?? null }]);
  const correo = typeof b?.correo === 'string' ? b.correo.trim().toLowerCase() : '';
  if (correo.length > 254 || !/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/.test(correo)) return fallo(422, [{ type: 'email', loc: ['body', 'correo'], msg: 'Escribe un correo válido.', input: null }]);
  const pago = b?.pago ?? {};
  const token = typeof pago.token === 'string' ? pago.token : '', medio = typeof pago.payment_method_id === 'string' ? pago.payment_method_id : '';
  if (!/^[A-Za-z0-9]{16,64}$/.test(token) || !/^[a-z0-9_]{2,32}$/.test(medio)) return fallo(400, 'Revisa los datos de tu tarjeta.');
  const emisor = pago.issuer_id != null && /^[0-9]{1,12}$/.test(String(pago.issuer_id)) ? String(pago.issuer_id) : null;
  const dispositivo = typeof pago.device_id === 'string' && /^[A-Za-z0-9_:-]{8,128}$/.test(pago.device_id) ? pago.device_id : null;

  // Frenos: tope por conexión y día, y pausa general si se acumulan rechazos en la hora.
  const ahora = new Date().toISOString(), dia = ahora.slice(0, 10), hora = ahora.slice(0, 13);
  const huella = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ip}|${dia}|${env.NA_INGEST_KEY ?? ''}`)))].slice(0, 12).map((x) => x.toString(16).padStart(2, '0')).join('');
  if ((await cuenta(env, `don:rechazos:${hora}`)) >= DON_RECHAZOS_HORA) return fallo(503, 'Las donaciones están en pausa por un momento. Intenta más tarde.', { 'Retry-After': '3600' });
  if ((await suma(env, `don:ip:${dia}:${huella}`)) > DON_INTENTOS_DIA) return fallo(429, 'Llegaste al límite de intentos de hoy. Intenta mañana.');
  if (env.DB) ctx.waitUntil(env.DB.prepare('DELETE FROM frenos WHERE creado < ?').bind(new Date(Date.now() - 2 * 86_400_000).toISOString()).run().then(() => {}, () => {}));

  const ref = `NA-DON-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const cabeceras = { 'X-Idempotency-Key': `${ref}-${token.slice(0, 16)}`, ...(dispositivo ? { 'X-meli-session-id': dispositivo } : {}) };
  const r = mensual
    ? await mp(env, '/preapproval', { reason: 'Apoyo mensual a Network Alert', external_reference: ref, payer_email: correo, card_token_id: token, auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: monto, currency_id: 'MXN' }, back_url: `${origen}/apoyar/gracias`, status: 'authorized' }, cabeceras)
    : await mp(env, '/v1/payments', {
        transaction_amount: monto, token, description: 'Donación a Network Alert', installments: 1, payment_method_id: medio, ...(emisor ? { issuer_id: emisor } : {}),
        binary_mode: true, capture: true, external_reference: ref, statement_descriptor: 'NETWORKALERT', payer: { email: correo },
        additional_info: { items: [{ id: 'donacion', title: 'Donación a Network Alert', description: 'Donación voluntaria para sostener networkalert.dev', category_id: 'donations', quantity: 1, unit_price: monto }] },
      }, cabeceras);
  const p = r.cuerpo ?? {}, bien = r.status === 200 || r.status === 201;
  if (bien && p.status === (mensual ? 'authorized' : 'approved')) return json({ ok: true, referencia: ref, monto_mxn: monto, frecuencia: mensual ? 'mensual' : 'unica' }, 'no-store');
  ctx.waitUntil(suma(env, `don:rechazos:${hora}`));
  console.error('mp', mensual ? 'mensual' : 'unica', r.status, String(p.status ?? ''), String(p.status_detail ?? p.message ?? '').slice(0, 200));
  if (bien && typeof p.status === 'string') return fallo(402, rechazo(String(p.status_detail ?? '')));
  if (r.status >= 400 && r.status < 500) return fallo(mensual ? 402 : 400, mensual ? 'No se pudo activar el apoyo mensual con esa tarjeta. Prueba con otra o dona una vez.' : 'Revisa los datos de tu tarjeta.');
  return fallo(502, 'No se pudo procesar el pago. No se hizo ningún cargo; intenta de nuevo en un momento.');
}

// Revisión de un dominio. Se cachea 10 minutos por dominio para no repetir consultas hacia fuera.
async function revisa(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const dado = url.searchParams.get('domain') ?? '';
  const dominio = normaliza(dado);
  if (!dominio) return fallo(422, [{ type: 'domain', loc: ['query', 'domain'], msg: 'Escribe un dominio público, por ejemplo: ejemplo.com', input: dado.slice(0, 80) }]);
  const llave = new Request(`${SITIO}/__revisar/v4/${dominio}`);
  const cache = (caches as unknown as { default: Cache }).default;
  const previa = await cache.match(llave).catch(() => undefined);
  if (previa) return previa;
  if (env.LIMITE_REVISAR) {
    const { success } = await env.LIMITE_REVISAR.limit({ key: request.headers.get('cf-connecting-ip') ?? 'anon' });
    if (!success) return fallo(429, 'Demasiadas revisiones seguidas. Espera un minuto.', { 'Retry-After': '60' });
  }
  const r = await revisar(dominio, propio(env, url.hostname)(dominio));
  if (!r) return fallo(404, `El dominio ${dominio} no existe o no tiene DNS.`);
  const res = json(r, 'public, max-age=600');
  ctx.waitUntil(cache.put(llave, res.clone()).catch(() => {}));
  return res;
}

// Reloj del recolector. El cron de GitHub Actions puede atrasarse horas o no arrancar; este reloj de Cloudflare
// corre cada 5 minutos y, si el dato tiene 9 minutos o más, pide a GitHub que ejecute el recolector.
const REPO = 'DabtcAvila/networkalert';
async function reloj(env: Env): Promise<void> {
  const texto = await env.NA_KV.get(CLAVE);
  const edad = texto ? Date.now() - Date.parse((JSON.parse(texto) as Snapshot).generated_at) : Infinity;
  await anota(env, { revisiones: 1, atrasadas: edad > 30 * 60_000 ? 1 : 0 });
  if (!env.GH_DISPATCH_TOKEN || edad < 9 * 60_000) return;
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/recolector.yml/dispatches`, {
    method: 'POST', signal: AbortSignal.timeout(15_000), body: JSON.stringify({ ref: 'main' }),
    headers: { Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'networkalert-reloj', 'Content-Type': 'application/json' },
  });
  if (!r.ok) console.error('reloj', r.status, (await r.text()).slice(0, 200));
}

// El propio sitio se lee de sus archivos: un Worker no puede pedirse a sí mismo por la red.
const propio = (env: Env, host: string) => (dominio: string) => (dominio === host ? (u: string) => env.ASSETS.fetch(new Request(u)) : undefined);

async function avisos(env: Env): Promise<unknown> {
  const snap = await leer(env);
  return vuelta(env, snap?.datos.alerts ?? [], propio(env, new URL(env.ORIGEN ?? SITIO).hostname));
}

// «Mi lista»: todo va por POST con JSON para que la llave nunca quede en una dirección ni en un registro.
async function lista(request: Request, env: Env, ruta: string, url: URL): Promise<Response> {
  if (request.method !== 'POST') return fallo(405, 'Método no permitido.', { Allow: 'POST' });
  const da = (s: Salida) => json(s.cuerpo, 'no-store', s.status);
  if (ruta === '/api/lista/vuelta') {
    const dada = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!env.NA_INGEST_KEY || !dada || !(await llaveValida(dada, env.NA_INGEST_KEY))) return fallo(401, 'No autorizado.');
    return json(await avisos(env), 'no-store');
  }
  if (env.LIMITE_REVISAR) {
    const { success } = await env.LIMITE_REVISAR.limit({ key: `lista:${request.headers.get('cf-connecting-ip') ?? 'anon'}` });
    if (!success) return fallo(429, 'Demasiados intentos seguidos. Espera un minuto.', { 'Retry-After': '60' });
  }
  let b: Record<string, unknown> = {};
  try { const t = (await request.text()).slice(0, 8000); if (t && !t.startsWith('List-Unsubscribe')) b = JSON.parse(t); } catch { return fallo(400, 'JSON inválido.'); }
  // La baja con un clic llega desde el programa de correo, con la llave en la dirección y sin origen.
  if (ruta === '/api/lista/baja') return da(await baja(env, b?.t ?? url.searchParams.get('t')));
  if (request.headers.get('origin') !== url.origin) return fallo(403, 'Origen no permitido.');
  switch (ruta) {
    case '/api/lista': return da(await solicita(env, b));
    case '/api/lista/confirmar': return da(await confirma(env, b?.t));
    case '/api/lista/ver': return da(await ver(env, b?.t));
  }
  return fallo(404, 'Ruta no encontrada.');
}

// ---------------------------------------------------------------------------
// Páginas con el contenido en el HTML. Cada una parte de su archivo estático; si algo falla, se sirve tal cual.
// ---------------------------------------------------------------------------
const base = (env: Env, url: URL, ruta: string) => env.ASSETS.fetch(new Request(new URL(ruta, url.origin), { headers: { accept: 'text/html' } }));
const nombres = (s: Snapshot | null) => { const m = new Map((s?.sources ?? []).map((f) => [f.id, f.name])); return (id: string) => m.get(id) ?? id; };
const noEsta = async (env: Env, url: URL) => { const r = await base(env, url, '/404'); const h = new Headers(r.headers); h.delete('etag'); h.set('Cache-Control', 'no-store'); return new Response(r.body, { status: 404, headers: h }); };

// La instantánea, lista para ir dentro de la página (el navegador la lee en vez de pedirla otra vez).
async function conAlertas(env: Env, url: URL, ruta: string, snap: { texto: string; datos: Snapshot } | null): Promise<Response> {
  const pagina = await base(env, url, ruta);
  if (!snap || !pagina.ok) return pagina;
  const s = snap.datos, nombre = nombres(s);
  const edad = Math.max(0, Math.round((Date.now() - Date.parse(s.generated_at)) / 60000));
  const texto: Record<string, string> = { '#actualizado': `Actualizado ${edad < 1 ? 'hace un momento' : edad < 60 ? `hace ${edad} min` : `hace ${Math.round(edad / 60)} h`} · ${s.counts.sources_ok} de ${s.counts.sources_total} fuentes` };
  const html: Record<string, string> = {};
  if (ruta === '/') {
    html['#lista-hoy'] = s.alerts.filter((a) => !a.stale && a.status === 'active').slice(0, 4).map((a) => renglonHoy(a, nombre)).join('');
    texto['#ver-todas'] = `Ver las ${s.alerts.length} alertas`;
  } else html['#lista-alertas'] = s.alerts.filter((a) => ORDEN[a.severity] <= 2).slice(0, 14).map((a) => tarjeta(a, nombre)).join('');
  return reescribe(pagina, { html, texto, datos: snap.texto }, 'public, max-age=60');
}

async function paginaAlerta(env: Env, url: URL, slug: string, s: Snapshot | null): Promise<Response> {
  if (!SLUG_VALIDO.test(slug)) return noEsta(env, url);
  let a: Guardada | undefined, estado: Estado = { activa: true };
  const viva = s?.alerts.find((x) => slugDe(x) === slug);
  if (viva) { const f = s!.sources.find((x) => x.id === viva.source); a = { ...viva, source_name: f?.name, source_url: f?.url, source_license: f?.license }; }
  let sev = viva ? ORDEN[viva.severity] ?? 4 : 4;
  if (!a && env.DB) {
    const fila = await porSlug(env.DB, slug).catch(() => null);
    if (fila) {
      try { a = JSON.parse(fila.datos) as Guardada; } catch { /* fila ilegible: se trata como inexistente */ }
      // Si la fila aún no se marca como cerrada pero ya no viene en la instantánea, se toma la última lectura como cierre.
      estado = { activa: false, cerrada: fila.cerrada ?? s?.generated_at ?? fila.actualizada, sevMax: fila.sev_max, actualizada: fila.actualizada };
      sev = fila.sev_max;
    }
  }
  if (!a) return noEsta(env, url);
  // La dirección canónica siempre es la de producción, también en el preview, para que no compitan en buscadores.
  const canonical = `${SITIO}/alerta/${slug}`;
  return reescribe(await base(env, url, '/alerta'), {
    titulo: a.title_es ?? a.title, descripcion: descripcionDe(a), canonical, articulo: true, noindex: !indexable(sev),
    html: { '#ficha': ficha(a, estado) }, ld: ldAlerta(a, estado, SITIO, canonical),
  }, estado.activa ? 'public, max-age=300' : 'public, max-age=3600');
}

async function paginaArchivo(env: Env, url: URL, ruta: string, s: Snapshot | null): Promise<Response> {
  const todos = meses();
  const mes = ruta === '/archivo' ? todos[0] : ruta.slice('/archivo/'.length);
  if (!todos.includes(mes) || !env.DB) return noEsta(env, url);
  const filas = await delMes(env.DB, mes);
  const propia = ruta === '/archivo';
  return reescribe(await base(env, url, '/archivo'), {
    ...(propia ? {} : { titulo: `Archivo de alertas de ${nombreMes(mes)}`, descripcion: `Alertas de Network Alert vistas por primera vez en ${nombreMes(mes)}: fallas en ataque, incidentes de plataformas y cortes de Internet, cada una con su página y su fuente.`, canonical: `${SITIO}/archivo/${mes}` }),
    html: { '#archivo-lista': listaArchivo(filas, nombres(s)), '#archivo-meses': navMeses(mes) },
    texto: { '#archivo-mes': `${nombreMes(mes)} · ${filas.length} ${filas.length === 1 ? 'alerta' : 'alertas'}` },
  }, 'public, max-age=600');
}

// El sitemap recorre todo el archivo: se guarda seis horas en la caché de Cloudflare para no repetir la consulta.
async function sitemapAlertas(env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.DB) return fallo(503, 'Archivo no disponible.');
  const cache = (caches as unknown as { default: Cache }).default, llave = new Request(`${SITIO}/__sitemap-alertas/v2`);
  const previa = await cache.match(llave).catch(() => undefined);
  if (previa) return previa;
  const res = new Response(sitemap(SITIO, await paraSitemap(env.DB)), { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600, s-maxage=21600', 'X-Content-Type-Options': 'nosniff' } });
  ctx.waitUntil(cache.put(llave, res.clone()).catch(() => {}));
  return res;
}

// Corte a nivel país: solo la alerta de IODA para México entero. `countries.MX` también cuenta lo regional y lo de un proveedor.
const corteNacional = (s: Snapshot) => s.alerts.find((a) => a.id === 'ioda:MX' && !a.stale)?.severity;

// México: proveedores y estados de la última lectura, alertas activas que lo tocan y lo archivado en 30 días.
async function paginaMexico(env: Env, url: URL, s: Snapshot | null): Promise<Response> {
  const pagina = await base(env, url, '/mexico');
  if (!s || !pagina.ok) return pagina;
  const nombre = nombres(s), m = s.mexico ?? null;
  const activas = s.alerts.filter((a) => a.countries.includes('MX'));
  const historial = env.DB ? await delPais(env.DB, 'MX').catch(() => []) : [];
  const html: Record<string, string> = {
    '#mx-alertas': activas.length ? activas.map((a) => tarjeta(a, nombre)).join('') : '<li class="vacio">Ninguna alerta activa toca a México en este momento.</li>',
    '#mx-historial': listaHistorial(historial, nombre),
  };
  if (m) { html['#mx-proveedores'] = tablero(m.providers); html['#mx-estados'] = tablero(m.states); }
  return reescribe(pagina, { html, texto: {
    '#mx-resumen': resumenMexico(m, corteNacional(s)),
    '#mx-actualizado': m ? `Última lectura: ${horaMx(m.checked_at)}, hora del centro de México${m.stale ? ' · la fuente no respondió en la lectura más reciente' : ''}` : 'Todavía no hay lectura por estado y por proveedor.',
  } }, 'public, max-age=120');
}

async function pagina(env: Env, ctx: ExecutionContext, url: URL, ruta: string, snap: { texto: string; datos: Snapshot } | null): Promise<Response | null> {
  if (ruta === '/mexico') return paginaMexico(env, url, snap?.datos ?? null);
  if (ruta === '/' || ruta === '/alertas') return conAlertas(env, url, ruta, snap);
  if (ruta === '/alerta') return Response.redirect(`${url.origin}/alertas`, 301);
  if (ruta.startsWith('/alerta/')) return paginaAlerta(env, url, ruta.slice('/alerta/'.length), snap?.datos ?? null);
  if (ruta === '/archivo' || ruta.startsWith('/archivo/')) return paginaArchivo(env, url, ruta, snap?.datos ?? null);
  if (ruta === '/sitemap-alertas.xml') return sitemapAlertas(env, ctx);
  return null;
}

export default {
  async scheduled(_evento: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(reloj(env).catch((e) => console.error('reloj', String(e))));
    ctx.waitUntil(avisos(env).catch((e) => console.error('avisos', String(e))));
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const ruta = url.pathname.replace(/\/$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...BASE, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' } });
    if (ruta === '/api/ingest') return request.method === 'POST' ? ingest(request, env, ctx) : fallo(405, 'Método no permitido.', { Allow: 'POST' });
    if (ruta === '/api/lista' || ruta.startsWith('/api/lista/')) return lista(request, env, ruta, url);
    const esDonar = ruta === '/api/donar' && request.method === 'POST';
    if (!esDonar && request.method !== 'GET' && request.method !== 'HEAD') return fallo(405, 'Método no permitido.', { Allow: ruta === '/api/donar' ? 'POST' : 'GET, HEAD, OPTIONS' });

    if (env.LIMITE) {
      const { success } = await env.LIMITE.limit({ key: request.headers.get('cf-connecting-ip') ?? 'anon' });
      if (!success) return fallo(429, 'Rate limit exceeded. Try again later.', { 'Retry-After': '60' });
    }
    if (esDonar) return donar(request, env, url.origin, ctx);
    if (ruta === '/api/donar') return fallo(405, 'Método no permitido.', { Allow: 'POST' });
    if (ruta === '/api/donar/estado') return json({ abierto: mpListo(env), minimo_mxn: DON_MIN, maximo_mxn: DON_MAX, public_key: mpListo(env) ? env.MP_PUBLIC_KEY : null }, 'no-store');

    if (ruta === '/api/v1/check') return revisa(request, env, ctx, url);
    if (ruta === '/api/v1/history') return historial(env);

    const snap = await leer(env);
    if (ruta === '/health') {
      const edad = snap ? Math.round((Date.now() - Date.parse(snap.datos.generated_at)) / 1000) : null;
      return json({ status: !snap ? 'sin_datos' : edad! > 3600 ? 'atrasado' : 'ok', version: VERSION, hora_utc: new Date().toISOString(), generated_at: snap?.datos.generated_at ?? null, age_s: edad }, 'no-store', snap ? 200 : 503);
    }
    if (ruta === '/badge.svg') return insignia(snap?.datos ?? null);
    if (!ruta.startsWith('/api/')) {
      // Si escribir el contenido falla, se sirve la página estática: el sitio nunca se cae por esto.
      try { const p = await pagina(env, ctx, url, ruta, snap); if (p) return p; }
      catch (e) { console.error('pagina', ruta, String(e)); return env.ASSETS.fetch(request); }
    }
    if (!snap) return fallo(503, 'Todavía no hay una instantánea publicada.', { 'Retry-After': '120' });
    const s = snap.datos;

    switch (ruta) {
      case '/api/v1/snapshot.json': return responde(snap.texto, 'application/json; charset=utf-8');
      case '/api/v1/status': return json({ ...procedencia(s), status: s.status, counts: s.counts, context: s.context });
      case '/api/v1/alerts': return alertas(s, url.searchParams);
      case '/api/v1/platforms': return json({ ...procedencia(s), platforms: s.platforms });
      case '/api/v1/sources': return json({ ...procedencia(s), sources: s.sources });
      case '/api/v1/mexico': return json({ ...procedencia(s), country: corteNacional(s) ? { severity: corteNacional(s) } : null, mexico: s.mexico ?? null, alerts: s.alerts.filter((a) => a.countries.includes('MX')) });
      case '/feed.xml': return feedRss(s);
      case '/feed.json': return feedJson(s);
    }
    if (ruta.startsWith('/api/')) return fallo(404, 'Ruta no encontrada. Documentación: https://networkalert.dev/api');
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
