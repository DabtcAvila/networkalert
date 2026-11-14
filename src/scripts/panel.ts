import { coincide } from '../lib/lista';
import { leeLista } from './lista-local';

// Panel del Inicio: lee la instantánea pública y pinta nivel, cifras, alertas, mapa y plataformas.
// Todo el texto entra con textContent (los títulos vienen de terceros); nada de innerHTML con datos.

type Alerta = { id: string; source: string; category: string; severity: string; title: string; title_es?: string; summary?: string; summary_es?: string; action?: string; url: string; published: string; first_seen: string; status: string; countries: string[]; tags: string[]; stale?: boolean; extra?: { cve?: string; epss?: { score: number }; ransomware?: boolean; cvss?: number; max_drop_pct?: number } };
type Plataforma = { id: string; name: string; group: string; url: string; indicator: string; description: string; incidents: number };
type Fuente = { id: string; name: string; ok: boolean | null };
type Snapshot = { generated_at: string; status: { level: string; points: number; factors: Record<string, number> }; counts: { total: number; by_category: Record<string, number>; platforms_degraded: number; platforms_total: number; countries_affected: number; sources_ok: number; sources_total: number }; context: { infocon?: string | null }; platforms: Plataforma[]; countries: Record<string, { alerts: number; severity: string }>; alerts: Alerta[]; sources: Fuente[] };

const SEV: Record<string, string> = { critical: 'Crítica', high: 'Alta', medium: 'Media', low: 'Baja', info: 'Informativa' };
const CAT: Record<string, string> = { vulnerability: 'Vulnerabilidad', platform: 'Plataforma', connectivity: 'Conectividad', advisory: 'Aviso' };
const NIVEL: Record<string, [string, string]> = {
  normal: ['Normal', 'Nada fuera de lo habitual.'],
  elevated: ['Elevado', 'Revisa las alertas altas hoy.'],
  high: ['Alto', 'Incidentes mayores en curso.'],
};
const IND: Record<string, string> = { none: 'Operando', minor: 'Degradación menor', major: 'Incidente mayor', critical: 'Caída crítica', maintenance: 'Mantenimiento' };
const ORDEN: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...hijos: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === 'class' ? (el.className = v) : el.setAttribute(k, v);
  for (const c of hijos) if (c) el.append(c);
  return el;
}
const hace = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (m < 1) return 'hace un momento';
  if (m < 60) return `hace ${m} min`;
  if (m < 60 * 36) return `hace ${Math.round(m / 60)} h`;
  return `hace ${Math.round(m / 1440)} días`;
};
// Solo se enlaza a https: una fuente comprometida no puede colar un javascript: en el panel.
const enlaceSeguro = (u: string) => (/^https:\/\//.test(u) ? u : '#');

// Conteo animado de una cifra («82», «9/25»): solo el primer número corre, y solo la primera vez que se ve.
const contado = new WeakSet<HTMLElement>();
function cuenta(el: HTMLElement, valor: string) {
  const m = valor.match(/^(\d+)(.*)$/);
  if (!m || contado.has(el) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = valor; return; }
  const fin = Number(m[1]), resto = m[2];
  const corre = () => {
    contado.add(el);
    const t0 = performance.now(), dur = 1100;
    const paso = (t: number) => { const k = Math.min(1, (t - t0) / dur), e = 1 - (1 - k) ** 3; el.textContent = `${Math.round(fin * e)}${resto}`; if (k < 1) requestAnimationFrame(paso); };
    requestAnimationFrame(paso);
  };
  el.textContent = `0${resto}`;
  const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) { io.disconnect(); corre(); } }, { threshold: 0.6 });
  io.observe(el);
}

// Tarjeta «Lo más urgente ahora»: rota entre las tres primeras alertas con una barra de progreso.
let destacadas: Alerta[] = [], iDest = 0, relojDest = 0;
function pintaDestacada() {
  const a = destacadas[iDest]; if (!a) return;
  const caja = $<HTMLAnchorElement>('destacada'), t = $('destacada-titulo'), sub = $('destacada-sub'), cab = $('destacada-cab'), barra = $('destacada-barra');
  if (!caja || !t || !sub || !cab || !barra) return;
  caja.dataset.sev = a.severity;
  cab.textContent = `Lo más urgente · ${iDest + 1} de ${destacadas.length}`;
  t.textContent = a.title_es ?? a.title;
  sub.textContent = `${SEV[a.severity] ?? ''} · ${datos?.sources.find((f) => f.id === a.source)?.name ?? a.source} · ${hace(a.published)}`;
  caja.href = enlaceSeguro(a.url); caja.target = '_blank'; caja.rel = 'noopener noreferrer';
  t.classList.remove('entra'); barra.classList.remove('corre'); void barra.offsetWidth; t.classList.add('entra');
  clearTimeout(relojDest);
  if (destacadas.length > 1 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && !document.querySelector('.portada--quieta')) {
    barra.classList.add('corre');
    relojDest = window.setTimeout(() => { iDest = (iDest + 1) % destacadas.length; pintaDestacada(); }, 7000);
  }
}

let datos: Snapshot | null = null;
// La landing enlaza aquí con ?f=<filtro> y ?q=<texto>.
const inicial = new URLSearchParams(location.search);
const miLista = leeLista();
const hayLista = miLista.proveedores.length + miLista.palabras.length > 0;
const enLista = (a: Alerta) => hayLista && coincide(a, miLista);
let filtro = ['vulnerability', 'platform', 'connectivity', 'advisory', 'mexico', 'lista'].includes(inicial.get('f') ?? '') ? inicial.get('f')! : 'todo';
let busca = inicial.get('q') ?? '';
let limite = 14;
let ultimaVisita = 0;
try { ultimaVisita = Number(localStorage.getItem('na-visita') ?? 0); } catch {}

function pintaNivel(s: Snapshot) {
  const [nombre, sub] = NIVEL[s.status.level] ?? ['Sin dato', ''];
  $('radar')?.setAttribute('data-nivel', s.status.level);
  const n = $('radar-nivel'); if (n) n.textContent = nombre;
  const sb = $('radar-sub'); if (sb) sb.textContent = sub;
  const act = $('actualizado');
  if (act) { act.textContent = `Actualizado ${hace(s.generated_at)} · ${s.counts.sources_ok} de ${s.counts.sources_total} fuentes`; act.setAttribute('title', new Date(s.generated_at).toLocaleString('es-MX')); }
  const viejo = Date.now() - Date.parse(s.generated_at) > 45 * 60000;
  const av = $('aviso-atraso'); if (av) av.hidden = !viejo;
  const altas = s.alerts.filter((a) => ORDEN[a.severity] <= 1 && !a.stale);
  const cifras: Record<string, string> = {
    'c-altas': String(altas.length),
    'c-vuln': String(s.alerts.filter((a) => a.source === 'cisa-kev').length),
    'c-plat': `${s.counts.platforms_degraded}/${s.counts.platforms_total}`,
    'c-paises': String(Object.values(s.countries).filter((p) => ORDEN[p.severity] <= 3).length),
  };
  for (const [id, v] of Object.entries(cifras)) { const el = $(id); if (el) cuenta(el, v); }
  const top = s.alerts.filter((a) => !a.stale && a.status === 'active').slice(0, 3);
  if (top.map((a) => a.id).join() !== destacadas.map((a) => a.id).join()) { destacadas = top; iDest = 0; pintaDestacada(); }
}

function tarjeta(a: Alerta): HTMLLIElement {
  const nuevo = ultimaVisita > 0 && Date.parse(a.first_seen) > ultimaVisita;
  const pie: (Node | null | false | undefined)[] = [
    !!a.extra?.ransomware && h('span', { class: 'tag tag--fuerte' }, 'Usada en ransomware'),
    !!a.extra?.cve && h('span', { class: 'tag' }, a.extra.cve!),
    a.extra?.cvss != null && h('span', { class: 'tag' }, `CVSS ${a.extra.cvss}`),
    a.extra?.epss != null && a.extra.epss.score >= 0.05 && h('span', { class: 'tag', title: 'Probabilidad de explotación en 30 días según EPSS (FIRST.org)' }, `EPSS ${(a.extra.epss.score * 100).toFixed(0)}%`),
    ...a.tags.filter((t) => t !== 'explotada').slice(0, 4).map((t) => h('span', { class: 'tag' }, t)),
    a.stale && h('span', { class: 'tag', title: 'La fuente no respondió en la última lectura; este es el último dato conocido.' }, 'sin actualizar'),
  ];
  return h('li', { class: 'alerta', 'data-sev': a.severity },
    h('p', { class: 'alerta__cab' },
      h('span', { class: 'sev' }, SEV[a.severity] ?? a.severity),
      h('span', {}, CAT[a.category] ?? a.category),
      h('span', {}, datos?.sources.find((f) => f.id === a.source)?.name ?? a.source),
      h('time', { datetime: a.published }, hace(a.published)),
      nuevo && h('span', { class: 'tag tag--nuevo' }, 'Nuevo')),
    h('h3', { class: 'alerta__titulo' }, h('a', { href: enlaceSeguro(a.url), rel: 'noopener noreferrer', target: '_blank', ...(a.title_es ? { title: `Original: ${a.title.trim()}` } : {}) }, a.title_es ?? a.title)),
    !!a.summary && h('p', { class: 'alerta__resumen', ...(a.summary_es ? { title: `Original: ${a.summary}` } : {}) }, a.summary_es ?? a.summary),
    !!a.action && h('p', { class: 'alerta__accion' }, h('strong', {}, 'Qué hacer: '), a.action),
    h('p', { class: 'alerta__pie' }, ...pie));
}

function pintaAlertas(s: Snapshot) {
  const lista = $('lista-alertas'); if (!lista) return;
  const q = busca.trim().toLowerCase();
  const visibles = s.alerts.filter((a) =>
    (filtro === 'todo' ? ORDEN[a.severity] <= 2 : filtro === 'mexico' ? a.countries.includes('MX') : filtro === 'lista' ? enLista(a) : a.category === filtro) &&
    (!q || `${a.title} ${a.title_es ?? ''} ${a.summary ?? ''} ${a.summary_es ?? ''} ${a.tags.join(' ')} ${a.extra?.cve ?? ''}`.toLowerCase().includes(q)));
  lista.replaceChildren(...visibles.slice(0, limite).map(tarjeta));
  const vacio = $('alertas-vacio');
  if (vacio) { vacio.hidden = visibles.length > 0; vacio.textContent = q ? `Nada coincide con «${busca.trim()}». Buena señal.` : filtro === 'lista' ? (hayLista ? 'Nada activo toca lo que usas. Buena señal.' : 'Aún no marcas lo que usas.') : filtro === 'mexico' ? 'Sin cortes en México en las últimas 24 horas.' : 'Sin alertas en esta categoría.'; }
  const ed = $('lista-editar'); if (ed) ed.hidden = filtro !== 'lista';
  const mas = $<HTMLButtonElement>('ver-mas');
  if (mas) { mas.hidden = visibles.length <= limite; mas.textContent = `Ver ${Math.min(20, visibles.length - limite)} más (${visibles.length - limite} restantes)`; }
}

// Conteos de los filtros (en la landing son enlaces; en /alertas, botones).
function pintaCuentas(s: Snapshot) {
  document.querySelectorAll<HTMLElement>('[data-cuenta]').forEach((el) => {
    const k = el.dataset.cuenta!;
    el.textContent = k === 'lista' ? (hayLista ? String(s.alerts.filter(enLista).length) : '') : String(k === 'todo' ? s.alerts.filter((a) => ORDEN[a.severity] <= 2).length : k === 'mexico' ? s.alerts.filter((a) => a.countries.includes('MX')).length : s.counts.by_category[k] ?? 0);
  });
}

// Módulo «Hoy» de la landing: solo las cuatro primeras, en una línea cada una.
function pintaHoy(s: Snapshot) {
  const ul = $('lista-hoy'); if (!ul) return;
  const top = s.alerts.filter((a) => !a.stale && a.status === 'active').slice(0, 4);
  ul.replaceChildren(...top.map((a) => h('li', { class: 'hoy__fila', 'data-sev': a.severity },
    h('span', { class: 'sev' }, SEV[a.severity] ?? a.severity),
    h('a', { class: 'hoy__titulo', href: enlaceSeguro(a.url), target: '_blank', rel: 'noopener noreferrer' }, a.title_es ?? a.title),
    h('span', { class: 'hoy__meta' }, `${s.sources.find((f) => f.id === a.source)?.name ?? a.source} · ${hace(a.published)}`))));
  const todas = $('ver-todas'); if (todas) todas.textContent = `Ver las ${s.alerts.length} alertas`;
}

function pintaMapa(s: Snapshot) {
  const caja = document.querySelector<HTMLElement>('.mapa');
  if (!caja) return;
  // centros: código de país → [lon, lat, nombre]. El globo (globo.ts) lee data-paises y escucha «na:paises».
  const centros = JSON.parse(caja.dataset.centros ?? '{}') as Record<string, [number, number, string]>;
  const entradas = Object.entries(s.countries).sort((a, b) => ORDEN[a[1].severity] - ORDEN[b[1].severity]);
  caja.dataset.paises = JSON.stringify([...entradas].reverse().flatMap(([code, p]) => { const c = centros[code]; return c ? [{ lon: c[0], lat: c[1], sev: p.severity, nombre: c[2] }] : []; }));
  caja.dispatchEvent(new CustomEvent('na:paises'));

  const ul = $('lista-paises');
  if (ul) {
    const conecta = s.alerts.filter((a) => a.category === 'connectivity');
    ul.replaceChildren(...entradas.filter(([, p]) => ORDEN[p.severity] <= 3).slice(0, 9).map(([code, p]) => {
      const a = conecta.find((x) => x.countries.includes(code));
      return h('li', { id: `pais-${code}`, 'data-sev': p.severity },
        h('span', { class: 'punto' }),
        h('span', {}, h('a', { href: enlaceSeguro(a?.url ?? '#'), target: '_blank', rel: 'noopener noreferrer' }, centros[code]?.[2] ?? code), h('small', {}, a?.summary ?? '')),
        h('span', { class: 'mono meta' }, SEV[p.severity] ?? ''));
    }));
    const menores = entradas.filter(([, p]) => p.severity === 'info').length;
    const nota = $('paises-nota'); if (nota) nota.textContent = entradas.length === 0 ? 'Sin cortes en las últimas 24 horas.' : menores ? `Más ${menores} con variaciones menores.` : '';
  }
  const mx = $('mx-estado');
  if (mx) {
    const m = s.countries.MX;
    mx.textContent = m && ORDEN[m.severity] <= 3 ? `México: señales de corte (${SEV[m.severity].toLowerCase()}).` : 'Sin cortes en las últimas 24 horas.';
  }
}

function pintaPlataformas(s: Snapshot) {
  const ul = $('lista-plataformas'); if (!ul) return;
  const orden = [...s.platforms].sort((a, b) => (a.indicator === 'none' ? 1 : 0) - (b.indicator === 'none' ? 1 : 0) || a.name.localeCompare(b.name));
  ul.replaceChildren(...orden.map((p) => h('li', { class: 'plataforma', 'data-ind': p.indicator },
    h('a', { href: enlaceSeguro(p.url), target: '_blank', rel: 'noopener noreferrer' }, h('span', { class: 'punto' }), h('strong', {}, p.name), h('small', {}, IND[p.indicator] ?? p.description)))));
  // Marquesina: todas las plataformas pasando en fila, dos veces seguidas para que el bucle no tenga corte.
  const pista = $('marquesina');
  if (pista) {
    const grupo = () => h('div', { class: 'marquesina__grupo' }, ...[...s.platforms].sort((a, b) => a.name.localeCompare(b.name)).map((p) => h('span', { class: 'marca-plat', 'data-ind': p.indicator }, h('i', {}), p.name)));
    pista.replaceChildren(grupo(), grupo());
  }
}

function pinta() { if (!datos) return; pintaNivel(datos); pintaCuentas(datos); pintaHoy(datos); pintaAlertas(datos); pintaMapa(datos); pintaPlataformas(datos); }

async function carga() {
  try {
    const r = await fetch('/api/v1/snapshot.json', { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(String(r.status));
    datos = (await r.json()) as Snapshot;
    const err = $('aviso-error'); if (err) err.hidden = true;
    pinta();
  } catch {
    if (!datos) { const n = $('radar-nivel'); if (n) n.textContent = 'Sin dato'; const sb = $('radar-sub'); if (sb) sb.textContent = 'No se pudo leer la instantánea'; }
    const err = $('aviso-error'); if (err) err.hidden = false;
  }
}

document.querySelectorAll<HTMLButtonElement>('.chip[data-filtro]').forEach((b) => b.addEventListener('click', () => {
  filtro = b.dataset.filtro!; limite = 14;
  document.querySelectorAll('.chip[data-filtro]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  if (datos) pintaAlertas(datos);
}));
$<HTMLInputElement>('buscar')?.addEventListener('input', (e) => { busca = (e.target as HTMLInputElement).value; limite = 14; if (datos) pintaAlertas(datos); });
// Estado inicial que llegó por la URL.
document.querySelectorAll('.chip[data-filtro]').forEach((x) => x.setAttribute('aria-pressed', String((x as HTMLElement).dataset.filtro === filtro)));
{ const b = $<HTMLInputElement>('buscar'); if (b && busca) b.value = busca; }
$('ver-mas')?.addEventListener('click', () => { limite += 20; if (datos) pintaAlertas(datos); });

void carga();
// La marca «Nuevo» compara contra la visita anterior; se guarda al salir para que dure toda la sesión.
window.addEventListener('pagehide', () => { try { localStorage.setItem('na-visita', String(Date.now())); } catch {} });
setInterval(() => { if (!document.hidden) void carga(); }, 120_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && datos && Date.now() - Date.parse(datos.generated_at) > 180_000) void carga(); });

export {};
