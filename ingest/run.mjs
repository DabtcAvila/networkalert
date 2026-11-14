#!/usr/bin/env node
// Recolecta todas las fuentes, normaliza y arma la «instantánea» que sirve el sitio y la API.
//
//   node ingest/run.mjs                → escribe .datos/snapshot.json (para desarrollo y revisión)
//   node ingest/run.mjs --publicar     → además la envía a POST {NA_ORIGEN}/api/ingest con NA_INGEST_KEY
//
// Diseño: una fuente caída nunca tumba la corrida. Si falla, se conservan sus alertas de la instantánea
// anterior marcadas como `stale` y la fuente queda con ok:false y el error a la vista del público.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { FUENTES, epss } from './fuentes.mjs';

const ORIGEN = process.env.NA_ORIGEN ?? 'https://networkalert.dev';
const SALIDA = new URL('../.datos/snapshot.json', import.meta.url);
const ORDEN = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const HORA = 3_600_000;

async function anterior() {
  try { return JSON.parse(await readFile(SALIDA, 'utf8')); } catch { /* sigue */ }
  try { const r = await fetch(`${ORIGEN}/api/v1/snapshot.json`, { signal: AbortSignal.timeout(10_000) }); if (r.ok) return await r.json(); } catch { /* primera corrida */ }
  return null;
}

// Nivel global: una sola palabra que resume «¿tengo que mirar esto hoy?». La fórmula es pública (/metodologia).
function nivel(alertas, plataformas) {
  const reciente = (a, h) => Date.now() - Date.parse(a.published) <= h * HORA;
  const activas = alertas.filter((a) => a.status === 'active' && !a.stale);
  const platCrit = plataformas.filter((p) => p.indicator === 'critical').length;
  const platMayor = plataformas.filter((p) => p.indicator === 'major').length;
  const kev72 = activas.filter((a) => a.source === 'cisa-kev' && reciente(a, 72)).length;
  const crit72 = activas.filter((a) => a.source === 'github-advisories' && a.severity === 'critical' && reciente(a, 72)).length;
  const cortes = activas.filter((a) => a.category === 'connectivity' && a.severity === 'high').length;
  const puntos = 3 * platCrit + 2 * platMayor + Math.min(kev72, 4) + Math.min(crit72, 3) + Math.min(cortes, 3);
  const level = platCrit > 0 || puntos >= 8 ? 'high' : puntos >= 4 ? 'elevated' : 'normal';
  return { level, points: puntos, factors: { platforms_critical: platCrit, platforms_major: platMayor, kev_72h: kev72, critical_advisories_72h: crit72, country_outages_high: cortes } };
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
// Dentro de cada severidad va primero lo que más probablemente te toca: lo explotado, luego las plataformas,
// luego cortes, y al final los avisos de paquetes (que son muchos y casi todos de nicho).
const PESO = (a) => (a.source === 'cisa-kev' ? 0 : a.category === 'platform' ? 1 : a.category === 'connectivity' ? 2 : a.category === 'vulnerability' ? 3 : 4);
alertas = [...unicas.values()].sort((x, y) => ORDEN[x.severity] - ORDEN[y.severity] || PESO(x) - PESO(y) || Date.parse(y.published) - Date.parse(x.published));

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
