/**
 * Páginas con el contenido ya escrito en el HTML (para buscadores, lectores sin JavaScript y para enlazar):
 *   /alerta/<slug>      una página por alerta, activa o archivada
 *   /archivo[/AAAA-MM]  índice por mes
 *   / y /alertas        las mismas páginas estáticas, con las alertas del momento ya dentro
 *
 * El diseño no se repite aquí: cada página parte de su archivo estático (cabecera, pie, estilos) y solo se le
 * escribe el contenido con HTMLRewriter. Todo texto de terceros pasa por `esc`.
 */
import { ORDEN, SEV_INDEXABLE, slugDe, type Alerta, type Guardada, type Renglon } from './archivo';

const CLAVES = ['critical', 'high', 'medium', 'low', 'info'];
const SEV: Record<string, string> = { critical: 'Crítica', high: 'Alta', medium: 'Media', low: 'Baja', info: 'Informativa' };
const CAT: Record<string, string> = { vulnerability: 'Vulnerabilidad', platform: 'Plataforma', connectivity: 'Conectividad', advisory: 'Aviso' };
const FASE: Record<string, string> = { investigating: 'En investigación', identified: 'Causa identificada', monitoring: 'Corregido, en observación', resolved: 'Resuelto', scheduled: 'Mantenimiento programado', in_progress: 'Mantenimiento en curso', verifying: 'Verificando', completed: 'Terminado' };
export const PRIMER_MES = '2026-11';

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
// Solo se enlaza a https: una fuente comprometida no puede colar otra cosa.
const https = (u: unknown) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : '#');
const recorta = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const hace = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (m < 1) return 'hace un momento';
  if (m < 60) return `hace ${m} min`;
  if (m < 60 * 36) return `hace ${Math.round(m / 60)} h`;
  return `hace ${Math.round(m / 1440)} días`;
};
const MX = 'America/Mexico_City';
const fmt = (o: Intl.DateTimeFormatOptions) => { const f = new Intl.DateTimeFormat('es-MX', o); return (iso: unknown) => { const t = new Date(String(iso)); return Number.isNaN(t.getTime()) ? '' : f.format(t); }; };
const fechaMx = fmt({ day: 'numeric', month: 'long', year: 'numeric', timeZone: MX }), fechaUtc = fmt({ day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
// Las fuentes que solo dan el día llegan como medianoche UTC: se muestran en UTC para no correrlas al día anterior.
const fecha = (iso: unknown) => (/T00:00:00(\.0+)?Z$/.test(String(iso)) ? fechaUtc(iso) : fechaMx(iso));
const fechaHora = fmt({ day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: MX });
const diaUtc = fmt({ day: 'numeric', month: 'long', timeZone: 'UTC' });
export const nombreMes = (mes: string) => fmt({ month: 'long', year: 'numeric', timeZone: 'UTC' })(`${mes}-15T12:00:00Z`);
const paises = new Intl.DisplayNames(['es'], { type: 'region' });
const pais = (c: string) => { try { return paises.of(c) ?? c; } catch { return c; } };

export const rutaDe = (a: Alerta) => `/alerta/${slugDe(a)}`;
type Nombres = (fuente: string) => string;

/** Tarjeta de la lista de /alertas. Mismo marcado que arma el navegador en src/scripts/panel.ts (función `tarjeta`). */
export function tarjeta(a: Alerta, nombre: Nombres): string {
  const x = (a.extra ?? {}) as { cve?: string; cvss?: number; epss?: { score: number }; ransomware?: boolean };
  const pie = [
    x.ransomware ? '<span class="tag tag--fuerte">Usada en ransomware</span>' : '',
    x.cve ? `<span class="tag">${esc(x.cve)}</span>` : '',
    x.cvss != null ? `<span class="tag">CVSS ${esc(x.cvss)}</span>` : '',
    x.epss && x.epss.score >= 0.05 ? `<span class="tag" title="Probabilidad de explotación en 30 días según EPSS (FIRST.org)">EPSS ${(x.epss.score * 100).toFixed(0)}%</span>` : '',
    ...a.tags.filter((t) => t !== 'explotada').slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`),
    a.stale ? '<span class="tag" title="La fuente no respondió en la última lectura; este es el último dato conocido.">sin actualizar</span>' : '',
  ].join('');
  return `<li class="alerta" data-sev="${esc(a.severity)}"><p class="alerta__cab"><span class="sev">${esc(SEV[a.severity] ?? a.severity)}</span><span>${esc(CAT[a.category] ?? a.category)}</span>`
    + `<a class="alerta__fuente" href="${esc(https(a.url))}" target="_blank" rel="noopener noreferrer">${esc(nombre(a.source))}</a><time datetime="${esc(a.published)}">${hace(a.published)}</time></p>`
    + `<h3 class="alerta__titulo"><a href="${rutaDe(a)}"${a.title_es ? ` title="Original: ${esc(a.title.trim())}"` : ''}>${esc(a.title_es ?? a.title)}</a></h3>`
    + (a.summary ? `<p class="alerta__resumen">${esc(a.summary_es ?? a.summary)}</p>` : '')
    + (a.action ? `<p class="alerta__accion"><strong>Qué hacer: </strong>${esc(a.action)}</p>` : '')
    + `<p class="alerta__pie">${pie}</p></li>`;
}

/** Renglón del módulo «Hoy» de la portada (`pintaHoy` en panel.ts). */
export const renglonHoy = (a: Alerta, nombre: Nombres) =>
  `<li class="hoy__fila" data-sev="${esc(a.severity)}"><span class="sev">${esc(SEV[a.severity] ?? a.severity)}</span><a class="hoy__titulo" href="${rutaDe(a)}">${esc(a.title_es ?? a.title)}</a><span class="hoy__meta">${esc(nombre(a.source))} · ${hace(a.published)}</span></li>`;

export type Estado = { activa: boolean; cerrada?: string | null; sevMax?: number; actualizada?: string };

/** Cuerpo de la página de una alerta. */
export function ficha(a: Guardada, e: Estado): string {
  const x = (a.extra ?? {}) as { cve?: string; ghsa?: string; cvss?: number; epss?: { score: number; percentile?: number }; ransomware?: boolean; due?: string; phase?: string; cwes?: string[]; grouped?: number; incidents?: { name?: string; url?: string; severity?: string; phase?: string | null; started?: string }[]; packages?: { ecosystem?: string; name?: string; range?: string; patched?: string | null }[] };
  const fuente = a.source_name ?? a.source;
  const mes = String(a.first_seen).slice(0, 7);
  const tecnica = a.category === 'vulnerability' || a.category === 'advisory';
  const estado = e.activa
    ? '<strong>Activa.</strong> Aparece en la lectura más reciente de la fuente.'
    : `<strong>En el archivo.</strong> ${tecnica ? `Salió de la lista de alertas recientes el ${fecha(e.cerrada)}. Eso no quiere decir que el riesgo terminó: las versiones sin corregir siguen expuestas.` : x.grouped ? `Este grupo dejó de publicarse el ${fecha(e.cerrada)}: quedaron menos de tres incidentes menores abiertos a la vez.` : `La fuente dejó de reportarla el ${fecha(e.cerrada)}.`}`;
  const dato = (k: string, v: string) => (v ? `<div><dt>${k}</dt><dd>${v}</dd></div>` : '');
  const datos = [
    dato('Gravedad', esc(SEV[a.severity] ?? a.severity) + (e.sevMax != null && e.sevMax < (ORDEN[a.severity] ?? 4) ? ` (llegó a ${esc(SEV[CLAVES[e.sevMax]]).toLowerCase()})` : '')),
    dato('Tipo', esc(CAT[a.category] ?? a.category)),
    dato('Identificador', [x.cve && `<a href="https://www.cve.org/CVERecord?id=${encodeURIComponent(x.cve)}" target="_blank" rel="noopener noreferrer">${esc(x.cve)}</a>`, x.ghsa && esc(x.ghsa)].filter(Boolean).join(' · ')),
    dato('CVSS', x.cvss != null ? `${esc(x.cvss)} de 10` : ''),
    dato('Probabilidad de ataque', x.epss ? `${(x.epss.score * 100).toFixed(x.epss.score < 0.1 ? 1 : 0)} % en los próximos 30 días (EPSS, FIRST.org)` : ''),
    dato('Ransomware', x.ransomware ? 'Usada en campañas de ransomware, según CISA' : ''),
    dato('Fecha límite de CISA', x.due ? `${fecha(`${String(x.due).slice(0, 10)}T12:00:00Z`)} (para agencias de EE. UU.)` : ''),
    dato(e.activa ? 'Etapa' : 'Última etapa registrada', x.phase ? esc(FASE[x.phase] ?? x.phase) : ''),
    dato('Países', a.countries.map((c) => esc(pais(c))).join(', ')),
    dato('Publicada por la fuente', fecha(a.published)),
    dato('Vista por primera vez', `${fechaHora(a.first_seen)} (hora de México)`),
    dato('Subió de nivel', a.escalated_at ? fechaHora(a.escalated_at) : ''),
    dato('Etiquetas', a.tags.filter((t) => t !== 'explotada').map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')),
    dato('Fuente', `<a href="${esc(https(a.source_url ?? a.url))}" target="_blank" rel="noopener noreferrer">${esc(fuente)}</a>${a.source_license ? ` · ${esc(a.source_license)}` : ''}`),
  ].join('');
  const paquetes = (x.packages ?? []).filter((p) => p?.name);
  return `<nav class="migas" aria-label="Ruta"><a href="/alertas">Alertas</a><span aria-hidden="true">›</span><a href="/archivo/${esc(mes)}">${esc(nombreMes(mes))}</a></nav>`
    + `<article class="ficha stack" data-sev="${esc(a.severity)}">`
    + `<header class="stack--sm stack"><p class="alerta__cab"><span class="sev">${esc(SEV[a.severity] ?? a.severity)}</span><span>${esc(CAT[a.category] ?? a.category)}</span><span>${esc(fuente)}</span><time datetime="${esc(a.published)}">${fecha(a.published)}</time></p>`
    + `<h1 class="display display--600 ficha__titulo">${esc(a.title_es ?? a.title)}</h1>${a.title_es ? `<p class="meta" lang="en">Título original: ${esc(a.title.trim())}</p>` : ''}</header>`
    + `<p class="aviso">${estado}</p>`
    // En los avisos de paquetes el resumen es la misma lista que la tabla de abajo: no se repite.
    + (a.summary && !(paquetes.length && a.source === 'github-advisories') ? `<section class="stack--sm stack"><h2>Qué pasó</h2><p class="ficha__texto">${esc(a.summary_es ?? a.summary)}</p>${a.summary_es ? `<p class="meta" lang="en">Texto original: ${esc(a.summary)}</p>` : ''}</section>` : '')
    // Un incidente de plataforma o un corte que ya terminó no pide ninguna acción.
    + (a.action && (e.activa || tecnica) ? `<section class="stack--sm stack"><h2>Qué hacer</h2><p class="ficha__texto alerta__accion">${esc(a.action)}</p></section>` : '')
    + (paquetes.length ? `<section class="stack--sm stack"><h2>Paquetes afectados</h2><div class="tabla-wrap"><table class="tabla"><thead><tr><th>Paquete</th><th>Gestor</th><th>Versiones afectadas</th><th>Corregido en</th></tr></thead><tbody>${paquetes.map((p) => `<tr><td class="mono">${esc(p.name)}</td><td>${esc(p.ecosystem)}</td><td class="mono">${esc(p.range ?? '')}</td><td class="mono">${p.patched ? esc(p.patched) : 'Sin versión corregida'}</td></tr>`).join('')}</tbody></table></div></section>` : '')
    + (x.incidents?.length ? `<section class="stack--sm stack"><h2>${e.activa ? 'Incidentes abiertos' : 'Incidentes que incluía'}</h2><ul class="ficha__lista">${x.incidents.map((i) => `<li><a href="${esc(https(i.url))}" target="_blank" rel="noopener noreferrer" lang="en">${esc(i.name)}</a><span class="meta"> · ${esc(SEV[i.severity ?? ''] ?? '')}${i.phase ? ` · ${esc(FASE[i.phase] ?? i.phase)}` : ''}${i.started ? ` · desde el ${fecha(i.started)}` : ''}</span></li>`).join('')}</ul>${(x.grouped ?? 0) > x.incidents.length ? `<p class="meta">Se muestran ${x.incidents.length} de ${x.grouped}; el resto está en la página de estado.</p>` : ''}</section>` : '')
    + `<section class="stack--sm stack"><h2>Datos</h2><dl class="ficha__datos">${datos}</dl></section>`
    + `<p class="cluster"><a class="btn btn--primary" href="${esc(https(a.url))}" target="_blank" rel="noopener noreferrer">Ver en la fuente</a><a class="enlace-flecha" href="/mi-lista">Recibir avisos de lo que uso</a><a class="enlace-flecha" href="/alertas">Todas las alertas</a></p>`
    + `<p class="meta">Network Alert compila y resume; la fuente manda. ${a.title_es || a.summary_es ? 'La traducción es automática. ' : ''}Verifica en la fuente antes de actuar. ¿Viste un error? Está en <a href="/correcciones">Correcciones</a> cómo reportarlo.</p>`
    + '</article>';
}

export function descripcionDe(a: Alerta): string {
  return recorta([a.summary_es ?? a.summary, a.action && `Qué hacer: ${a.action}`].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || `${SEV[a.severity] ?? ''} · ${CAT[a.category] ?? ''}`, 200);
}

/** Datos estructurados de la página de una alerta. */
export function ldAlerta(a: Guardada, e: Estado, origen: string, canonical: string): unknown[] {
  const org = { '@type': 'Organization', name: 'Network Alert', url: origen, logo: `${origen}/icon-512.png` };
  const mes = String(a.first_seen).slice(0, 7);
  return [
    { '@context': 'https://schema.org', '@type': 'Article', headline: recorta(a.title_es ?? a.title, 110), description: descripcionDe(a), inLanguage: 'es-MX', datePublished: a.first_seen, dateModified: e.actualizada ?? a.updated ?? a.first_seen, mainEntityOfPage: canonical, isBasedOn: https(a.url), image: `${origen}/og.png`, author: org, publisher: org },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Alertas', item: `${origen}/alertas` },
      { '@type': 'ListItem', position: 2, name: nombreMes(mes), item: `${origen}/archivo/${mes}` },
      { '@type': 'ListItem', position: 3, name: recorta(a.title_es ?? a.title, 110), item: canonical },
    ] },
  ];
}

/** Meses con archivo, del más reciente al primero. Se calculan, no se consultan. */
export function meses(hoy = new Date()): string[] {
  const out: string[] = [];
  let a = hoy.getUTCFullYear(), m = hoy.getUTCMonth() + 1;
  for (let i = 0; i < 240; i++) {
    const k = `${a}-${String(m).padStart(2, '0')}`;
    if (k < PRIMER_MES) break;
    out.push(k);
    if (--m === 0) { m = 12; a--; }
  }
  return out;
}

/** Lista del archivo de un mes, agrupada por día. */
export function listaArchivo(filas: Renglon[], nombre: Nombres): string {
  if (!filas.length) return '<p class="vacio">Sin alertas guardadas en este mes.</p>';
  const dias = new Map<string, Renglon[]>();
  for (const f of filas) { const d = f.primera.slice(0, 10); (dias.get(d) ?? dias.set(d, []).get(d)!).push(f); }
  return [...dias].map(([d, fs]) => `<section class="stack--sm stack"><h2 class="archivo__dia">${diaUtc(`${d}T12:00:00Z`)}</h2><ul class="hoy__lista">${fs.map((f) => {
    const sev = CLAVES[f.sev_max] ?? 'info';
    return `<li class="hoy__fila" data-sev="${sev}"><span class="sev">${SEV[sev]}</span><a class="hoy__titulo" href="/alerta/${esc(f.slug)}">${esc(f.titulo)}</a><span class="hoy__meta">${esc(nombre(f.fuente))} · ${f.cerrada ? 'en el archivo' : 'activa'}</span></li>`;
  }).join('')}</ul></section>`).join('');
}

export const navMeses = (actual: string) =>
  meses().map((m) => `<a class="chip chip--chico" href="/archivo/${m}"${m === actual ? ' aria-current="page"' : ''}>${esc(nombreMes(m))}</a>`).join('');

export function sitemap(origen: string, filas: { slug: string; actualizada: string }[]): string {
  const url = (loc: string, mod?: string) => `<url><loc>${esc(loc)}</loc>${mod ? `<lastmod>${esc(mod)}</lastmod>` : ''}</url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${meses().slice(1).map((m) => url(`${origen}/archivo/${m}`)).join('')}${filas.map((f) => url(`${origen}/alerta/${f.slug}`, f.actualizada)).join('')}</urlset>`;
}

export type Cambios = {
  titulo?: string; descripcion?: string; canonical?: string; noindex?: boolean; articulo?: boolean;
  /** selector → HTML ya escapado que reemplaza el contenido del elemento */
  html?: Record<string, string>;
  /** selector → texto plano */
  texto?: Record<string, string>;
  ld?: unknown[];
  /** JSON que el navegador lee al cargar, para no pedir la instantánea otra vez */
  datos?: string;
};
const jsonSeguro = (t: string) => t.replace(/</g, '\\u003c');

/** Escribe el contenido sobre una página estática. Conserva sus cabeceras (CSP y demás) y cambia la caché. */
export function reescribe(base: Response, c: Cambios, cache: string, status = 200): Response {
  let r = new HTMLRewriter();
  const attr = (sel: string, nombre: string, valor: string) => { r = r.on(sel, { element(el) { el.setAttribute(nombre, valor); } }); };
  if (c.titulo) {
    const t = `${c.titulo} · Network Alert`;
    r = r.on('title', { element(el) { el.setInnerContent(t); } });
    attr('meta[property="og:title"]', 'content', t); attr('meta[name="twitter:title"]', 'content', t);
  }
  if (c.descripcion) for (const s of ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) attr(s, 'content', c.descripcion);
  if (c.canonical) { attr('link[rel="canonical"]', 'href', c.canonical); attr('meta[property="og:url"]', 'content', c.canonical); }
  if (c.articulo) attr('meta[property="og:type"]', 'content', 'article');
  for (const [sel, h] of Object.entries(c.html ?? {})) r = r.on(sel, { element(el) { el.setInnerContent(h, { html: true }); } });
  for (const [sel, t] of Object.entries(c.texto ?? {})) r = r.on(sel, { element(el) { el.setInnerContent(t); } });
  const cabeza = [c.noindex ? '<meta name="robots" content="noindex, follow">' : '', ...(c.ld ?? []).map((o) => `<script type="application/ld+json">${jsonSeguro(JSON.stringify(o))}</script>`)].join('');
  if (cabeza) r = r.on('head', { element(el) { el.append(cabeza, { html: true }); } });
  if (c.noindex) r = r.on('link[rel="canonical"]', { element(el) { el.remove(); } });
  if (c.datos) { const d = `<script type="application/json" id="na-datos">${jsonSeguro(c.datos)}</script>`; r = r.on('body', { element(el) { el.append(d, { html: true }); } }); }
  const salida = r.transform(base);
  const h = new Headers(salida.headers);
  h.delete('etag'); h.delete('content-length'); h.delete('last-modified');
  h.set('Cache-Control', cache);
  return new Response(salida.body, { status, headers: h });
}

export const indexable = (sev: number) => sev <= SEV_INDEXABLE;
