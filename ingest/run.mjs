#!/usr/bin/env node
// Recolecta todas las fuentes, normaliza y arma la «instantánea» que sirve el sitio y la API.
//
//   node ingest/run.mjs                → escribe .datos/snapshot.json (para desarrollo y revisión)
//   node ingest/run.mjs --publicar     → además la envía a POST {NA_ORIGEN}/api/ingest con NA_INGEST_KEY
//
// Diseño: una fuente caída nunca tumba la corrida. Si falla, se conservan sus alertas de la instantánea
// anterior marcadas como `stale` y la fuente queda con ok:false y el error a la vista del público.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { FUENTES, alcance, epss } from './fuentes.mjs';

const ORIGEN = process.env.NA_ORIGEN ?? 'https://networkalert.dev';
const SALIDA = new URL('../.datos/snapshot.json', import.meta.url);
const ORDEN = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const HORA = 3_600_000;

async function anterior() {
  try { return JSON.parse(await readFile(SALIDA, 'utf8')); } catch { /* sigue */ }
  try { const r = await fetch(`${ORIGEN}/api/v1/snapshot.json`, { signal: AbortSignal.timeout(10_000) }); if (r.ok) return await r.json(); } catch { /* primera corrida */ }
  return null;
}

// Nivel del día: una palabra y una frase que responden «¿hay hoy algo que toque a mucha gente?».
// Solo sube con lo que alcanza a muchos: una plataforma grande caída, una falla que ya se está atacando en un
// producto muy usado, una falla crítica en un paquete muy usado o un país entero sin Internet (México pesa más). Lo que toca a pocos
// (equipos de empresa, paquetes poco usados) sigue en la lista de alertas, pero no mueve el nivel: si lo moviera,
// el nivel estaría «elevado» casi todos los días y dejaría de decir algo. La fórmula es pública (/metodologia).
const enumera = (xs, max = 3) => {
  const u = [...new Set(xs.filter(Boolean))], v = u.slice(0, max), resto = u.length - v.length;
  if (resto > 0) return `${v.join(', ')} y ${resto} más`;
  return v.length > 1 ? `${v.slice(0, -1).join(', ')} y ${v.at(-1)}` : v[0] ?? '';
};
// Nombre corto de lo afectado, para la frase.
const nombreProducto = (a) => {
  if (a.extra?.grouped) return a.title.split(':')[0];
  const [, fabricante, producto] = a.tags ?? [];
  if (!producto || /^multiple\b/i.test(producto)) return fabricante;
  return producto.toLowerCase().startsWith(String(fabricante).toLowerCase()) ? producto : `${fabricante} ${producto}`;
};
const nombrePaquete = (a) => { const i = a.title.indexOf(': '); return i > 0 && i <= 28 ? a.title.slice(0, i) : a.extra?.packages?.[0]?.name ?? a.title.slice(0, 28); };

function nivel(alertas, plataformas) {
  const reciente = (a, h) => Date.now() - Date.parse(a.published) <= h * HORA;
  const activas = alertas.filter((a) => a.status === 'active' && !a.stale);
  const muyUsado = (a) => a.extra?.reach?.level === 'wide';
  const suma = (xs) => xs.reduce((n, x) => n + x, 0);

  // Solo cuentan las plataformas de uso masivo; las demás (`counts_for_level: false`) se muestran y avisan, pero no mueven el nivel.
  const masivas = plataformas.filter((p) => p.counts_for_level !== false);
  const caidas = masivas.filter((p) => p.indicator === 'critical'), mayores = masivas.filter((p) => p.indicator === 'major');
  // Una alerta que junta varias fallas cuenta por las que junta.
  const enAtaque = activas.filter((a) => a.source === 'cisa-kev' && muyUsado(a) && reciente(a, 72));
  const nAtaque = suma(enAtaque.map((a) => a.extra?.grouped ?? 1));
  const criticas = activas.filter((a) => a.source === 'github-advisories' && muyUsado(a))
    .map((a) => ({ a, n: a.extra?.advisories ? a.extra.advisories.filter((x) => x.severity === 'critical' && reciente(x, 72)).length : a.severity === 'critical' && reciente(a, 72) ? 1 : 0 }))
    .filter((x) => x.n > 0);
  const nCriticas = suma(criticas.map((x) => x.n));
  const cortes = activas.filter((a) => a.category === 'connectivity' && a.severity === 'high');
  // Un corte en México entero pesa más: es el país de casi todos los que leen este sitio. Basta para «elevado».
  const mexico = cortes.some((a) => (a.countries ?? []).includes('MX')) ? 1 : 0;
  const otros = cortes.filter((a) => !(a.countries ?? []).includes('MX'));

  const puntos = 3 * caidas.length + 2 * mayores.length + 2 * Math.min(nAtaque, 3) + Math.min(nCriticas, 3) + 4 * mexico + Math.min(otros.length, 3);
  const level = caidas.length > 0 || puntos >= 8 ? 'high' : puntos >= 4 ? 'elevated' : 'normal';

  // La frase nombra lo que cuenta, de lo más grave a lo menos.
  const razones = [
    caidas.length ? `caída en ${enumera(caidas.map((p) => p.name))}` : '',
    mayores.length ? `falla mayor en ${enumera(mayores.map((p) => p.name))}` : '',
    nAtaque ? `${nAtaque === 1 ? 'una falla que ya se está atacando' : `${nAtaque} fallas que ya se están atacando`} en ${enumera(enAtaque.map(nombreProducto))}` : '',
    nCriticas ? `${nCriticas === 1 ? 'una falla crítica' : `${nCriticas} fallas críticas`} en ${enumera(criticas.map((x) => nombrePaquete(x.a)))}` : '',
    cortes.length ? `corte de Internet en ${enumera([mexico ? 'México' : '', ...otros.map((a) => a.title.split(':')[0])])}` : '',
  ].filter(Boolean);
  const lista = razones.join('; ');
  const summary = level === 'high' ? `Hay algo grave en curso: ${lista}.`
    : level === 'elevated' ? `Conviene revisar hoy: ${lista}.`
    : razones.length ? `Nada grave para la mayoría. Para tener en cuenta: ${lista}.` : 'Nada fuera de lo habitual.';
  return { level, points: puntos, summary, reasons: razones,
    factors: { platforms_critical: caidas.length, platforms_major: mayores.length, exploited_wide_72h: nAtaque, critical_packages_wide_72h: nCriticas, mexico_outage: mexico, country_outages_high: otros.length } };
}

const previa = await anterior();
const inicio = Date.now();
const resultados = await Promise.all(FUENTES.filter((f) => f.run).map(async (f) => {
  const t = Date.now();
  try { return { f, valor: await f.run(), ms: Date.now() - t }; }
  catch (e) { return { f, error: String(e?.message ?? e), ms: Date.now() - t }; }
}));

let alertas = [];
const plataformas = [];
const fuentes = [];
let infocon = previa?.context?.infocon ?? null;
// México por estado y por proveedor. Si la fuente falla se conserva lo último, señalado como no actualizado.
let mexico = previa?.mexico ? { ...previa.mexico, stale: true } : null;

for (const { f, valor, error, ms } of resultados) {
  const estado = { id: f.id, name: f.name, url: f.url, license: f.license, kind: f.kind, ok: !error, fetched_at: new Date().toISOString(), ms, items: 0 };
  if (error || valor == null) {
    if (valor == null && !error) { estado.ok = null; estado.note = 'Sin credencial configurada; fuente opcional omitida.'; }
    else estado.error = error;
    // Se conserva lo último conocido, señalado como no actualizado.
    const viejas = (previa?.alerts ?? []).filter((a) => a.source === f.id).map((a) => ({ ...a, stale: true }));
    alertas.push(...viejas);
    const pv = previa?.platforms?.find((p) => `status-${p.id}` === f.id);
    if (pv) plataformas.push({ ...pv, stale: true });
    estado.items = viejas.length;
    if (previa) estado.last_ok_at = previa.sources?.find((s) => s.id === f.id)?.last_ok_at ?? null;
  } else {
    estado.last_ok_at = estado.fetched_at;
    if (f.kind === 'platform') { plataformas.push(valor.plataforma); alertas.push(...valor.incidentes); estado.items = valor.incidentes.length; }
    else if (f.kind === 'context') { infocon = valor; estado.items = 1; }
    else if (f.kind === 'mexico') { mexico = valor.mexico; alertas.push(...valor.alertas); estado.items = valor.alertas.length; }
    else { alertas.push(...valor); estado.items = valor.length; }
  }
  fuentes.push(estado);
}

// Enriquecimiento con EPSS para todo lo que tenga CVE.
const epssFuente = { ...FUENTES.find((f) => f.id === 'first-epss'), run: undefined, ok: true, fetched_at: new Date().toISOString(), items: 0 };
try {
  const cves = [...new Set(alertas.map((a) => a.extra?.cve).filter(Boolean))];
  const mapa = cves.length ? await epss(cves) : new Map();
  for (const a of alertas) { const e = mapa.get(a.extra?.cve); if (e) a.extra.epss = e; }
  epssFuente.items = mapa.size; epssFuente.last_ok_at = epssFuente.fetched_at;
} catch (e) { epssFuente.ok = false; epssFuente.error = String(e?.message ?? e); }
fuentes.push(epssFuente);

// Alcance: qué tan usado es cada paquete afectado (y qué fallas en ataque tocan productos de uso común).
const alcanceFuente = { ...FUENTES.find((f) => f.id === 'ecosystems'), run: undefined, ok: true, fetched_at: new Date().toISOString(), items: 0 };
const cacheAlcance = { ...(previa?.reach_cache ?? {}) };
try { alcanceFuente.items = await alcance(alertas, cacheAlcance); alcanceFuente.last_ok_at = alcanceFuente.fetched_at; }
catch (e) { alcanceFuente.ok = false; alcanceFuente.error = String(e?.message ?? e); alcanceFuente.last_ok_at = previa?.sources?.find((s) => s.id === 'ecosystems')?.last_ok_at ?? null; }
fuentes.push(alcanceFuente);

// first_seen: cuándo vio Network Alert cada alerta por primera vez (permite «nuevo desde tu última visita» y el RSS).
const vistas = new Map((previa?.alerts ?? []).map((a) => [a.id, a.first_seen]));
// escalated_at: cuándo una alerta ya conocida subió a alta o crítica (por ejemplo, un incidente menor que se vuelve mayor).
// Sirve para avisar de nuevo: sin esto, quien la vio como «media» nunca se enteraría de que empeoró.
const previas = new Map((previa?.alerts ?? []).map((a) => [a.id, a]));
const ahora = new Date().toISOString();
const unicas = new Map();
for (const a of alertas) {
  if (!a.id || !a.title || !a.url || !a.published) continue; // sin fuente enlazada o sin fecha no se publica
  a.first_seen = vistas.get(a.id) ?? ahora;
  const antes = previas.get(a.id);
  if (antes && !a.stale) {
    if (ORDEN[a.severity] <= 1 && ORDEN[a.severity] < ORDEN[antes.severity]) a.escalated_at = ahora;
    else if (antes.escalated_at && ORDEN[a.severity] <= 1) a.escalated_at = antes.escalated_at;
  }
  a.countries ??= [];
  if (!a.action) delete a.action;
  a.tags = [...new Set((a.tags ?? []).map(String))].slice(0, 8);
  unicas.set(a.id, a);
}
// Dentro de cada severidad va primero lo que más probablemente te toca: lo explotado (antes lo de uso común), luego
// las plataformas, luego cortes, y al final los avisos de paquetes: primero los muy usados y al último los de nicho.
const ALC = { wide: 0, mid: 1, niche: 2 };
const alc = (a) => ALC[a.extra?.reach?.level] ?? 1;
const PESO = (a) => (a.source === 'cisa-kev' ? 0 : a.category === 'platform' ? 1 : a.category === 'connectivity' ? 2 : a.category === 'vulnerability' ? 3 : 4);
alertas = [...unicas.values()].sort((x, y) => ORDEN[x.severity] - ORDEN[y.severity] || PESO(x) - PESO(y) || alc(x) - alc(y) || Date.parse(y.published) - Date.parse(x.published));

const paises = {};
for (const a of alertas) for (const c of a.countries) {
  const p = (paises[c] ??= { alerts: 0, severity: 'info' });
  p.alerts++; if (ORDEN[a.severity] < ORDEN[p.severity]) p.severity = a.severity;
}

const cuenta = (fn) => alertas.filter(fn).length;
const snapshot = {
  version: 1,
  generated_at: ahora,
  took_ms: Date.now() - inicio,
  status: nivel(alertas, plataformas),
  counts: {
    total: alertas.length,
    by_category: Object.fromEntries(['vulnerability', 'platform', 'connectivity', 'advisory'].map((c) => [c, cuenta((a) => a.category === c)])),
    by_severity: Object.fromEntries(Object.keys(ORDEN).map((s) => [s, cuenta((a) => a.severity === s)])),
    platforms_degraded: plataformas.filter((p) => p.indicator !== 'none').length,
    platforms_total: plataformas.length,
    countries_affected: Object.keys(paises).length,
    sources_ok: fuentes.filter((s) => s.ok === true).length,
    sources_total: fuentes.filter((s) => s.ok !== null).length,
  },
  context: { infocon },
  platforms: plataformas.sort((a, b) => a.name.localeCompare(b.name)),
  countries: paises,
  mexico,
  reach_cache: cacheAlcance,
  alerts: alertas,
  sources: fuentes.map(({ run, optional, ...s }) => s),
  about: { site: 'https://networkalert.dev', docs: 'https://networkalert.dev/api', license: 'Compilación bajo CC BY 4.0; cada alerta conserva la licencia de su fuente (ver sources[].license).', disclaimer: 'Información para orientar, sin garantía. Verifica siempre en la fuente primaria enlazada.' },
};

await mkdir(new URL('../.datos/', import.meta.url), { recursive: true });
await writeFile(SALIDA, JSON.stringify(snapshot));
const fallas = fuentes.filter((s) => s.ok === false);
console.log(`nivel=${snapshot.status.level} (${snapshot.status.points} pts) · ${alertas.length} alertas · ${plataformas.length} plataformas · ${snapshot.counts.sources_ok}/${snapshot.counts.sources_total} fuentes · ${snapshot.took_ms} ms · ${(JSON.stringify(snapshot).length / 1024).toFixed(0)} KB`);
for (const s of fallas) console.log(`  ✗ ${s.id}: ${s.error}`);

if (process.argv.includes('--publicar')) {
  if (!process.env.NA_INGEST_KEY) { console.error('Falta NA_INGEST_KEY'); process.exit(2); }
  // Freno: si más de la mitad de las fuentes falló, no se pisa la instantánea publicada.
  if (fallas.length > snapshot.counts.sources_total / 2) { console.error('Demasiadas fuentes caídas; no se publica.'); process.exit(3); }
  const r = await fetch(`${ORIGEN}/api/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.NA_INGEST_KEY}` }, body: JSON.stringify(snapshot), signal: AbortSignal.timeout(30_000) });
  console.log(`publicado → ${r.status} ${await r.text()}`);
  if (!r.ok) process.exit(4);
}
