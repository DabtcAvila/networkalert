/**
 * Títulos y resúmenes en español. Las fuentes publican en inglés; aquí se traduce cada texto una sola vez con
 * Workers AI (cuota gratuita) y se guarda en KV. El original nunca se pierde: queda en `title` y `summary`,
 * la traducción va en `title_es` y `summary_es`. Si la traducción falla o no pasa las comprobaciones, se deja el original.
 */
export interface IA { run(modelo: string, entrada: unknown): Promise<unknown> }
type Incluida = { title?: string; title_es?: string };
type Alerta = { source: string; title: string; title_es?: string; summary?: string; summary_es?: string; extra?: { grouped?: number; advisories?: Incluida[] } & Record<string, unknown> };

const MODELO = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const LOTE = 20, MAX_POR_CORRIDA = 80;
const LOTE_RESUMENES = 8, MAX_RESUMENES_POR_CORRIDA = 24;
// Fuentes cuyos títulos ya se arman en español.
const YA_EN_ESPANOL = new Set(['ioda', 'ioda-mexico', 'cloudflare-radar']);
// Fuentes cuyo resumen ya se arma en español (paquete, versiones afectadas y versión corregida).
// Radar no está aquí: su descripción llega en inglés y sí se traduce.
const RESUMEN_EN_ESPANOL = new Set(['ioda', 'ioda-mexico', 'github-advisories']);
const SISTEMA = `Traduces al español de México títulos de alertas de seguridad informática y de fallas de servicios de Internet.
Reglas:
- Conserva tal cual, sin traducir: nombres de empresas, productos, paquetes y regiones, identificadores (CVE-…, VU#…), versiones y el texto antes de los primeros dos puntos.
- No agregues ni quites información. No expliques.
- Español claro y directo. «Outage» es «caída»; «degraded performance» es «servicio lento»; «vulnerability» es «falla»; «remote code execution» es «ejecución remota de código».
- «Denial of service» es siempre «denegación de servicio» (nunca «servicio de denegación»); «bypass» es «evasión»; «Security Advisory» es «aviso de seguridad»; «path traversal» es «salto de directorio»; «authentication» es «autenticación»; «privilege escalation» es «escalada de privilegios»; «Multiple Products» es «varios productos».
- No repitas la misma idea con dos palabras («la ruta del camino»): una sola basta.
- Responde solo con las traducciones, una por línea, cada una con el mismo número al inicio.`;

const SISTEMA_RESUMEN = `Traduces al español de México resúmenes breves de alertas de seguridad informática y de fallas de servicios de Internet.
Reglas:
- Conserva tal cual, sin traducir: nombres de empresas, productos, paquetes y regiones, identificadores (CVE-…, VU#…), versiones, números, horas y direcciones web.
- No agregues ni quites información. No expliques ni des consejos.
- Conserva las oraciones separadas con punto, como en el original.
- Español claro y directo, sin tecnicismos innecesarios. «Outage» es «caída»; «degraded performance» es «servicio lento»; «vulnerability» es «falla»; «remote code execution» es «ejecución remota de código»; «we are investigating» es «estamos investigando».
- Cada resumen va en una sola línea. Responde solo con las traducciones, una por línea, cada una con el mismo número al inicio.`;

export type Mapa = Record<string, string>;

// Una alerta que junta varias (`extra.grouped`) ya trae su título armado en español.
const enEspanol = (a: Alerta) => YA_EN_ESPANOL.has(a.source) || !!a.extra?.grouped;
// Las fallas que lista una alerta agrupada conservan su título original: también se traducen.
const incluidas = (a: Alerta): Incluida[] => (Array.isArray(a.extra?.advisories) ? a.extra!.advisories!.filter((x) => typeof x?.title === 'string' && x.title) : []);
const titulosDe = (alertas: Alerta[]) => alertas.flatMap((a) => [...(enEspanol(a) ? [] : [a.title]), ...incluidas(a).map((x) => x.title!)]);

// Retoques fijos sobre la traducción automática: términos que el modelo suele dejar en inglés o calcar.
const RETOQUES: [RegExp, string][] = [
  [/\bel bypass\b/g, 'la evasión'], [/\bun bypass\b/g, 'una evasión'], [/\bBypass\b/g, 'Evasión'], [/\bbypass\b/g, 'evasión'],
  [/^Microsoft Security Advisory\b/, 'Aviso de seguridad de Microsoft'], [/\bImpersonación\b/g, 'Suplantación'], [/\bimpersonación\b/g, 'suplantación'],
  [/\bcomputación de la raíz\b/g, 'cálculo de la raíz'],
  [/\bde la oficina trasera\b/g, 'del panel de administración'], [/\bla oficina trasera\b/g, 'el panel de administración'], [/\boficina trasera\b/g, 'panel de administración'],
  [/\bisolación\b/g, 'aislamiento'], [/\bIsolación\b/g, 'Aislamiento'],
];
const pule = (es: string) => RETOQUES.reduce((t, [de, a]) => t.replace(de, a), es);

/** Pone `title_es` en cada alerta que ya tenga traducción guardada. Una cadena vacía significa «la traducción no pasó las comprobaciones; se deja el original». */
export function aplica(alertas: Alerta[], mapa: Mapa) {
  for (const a of alertas) {
    const es = enEspanol(a) ? '' : mapa[a.title];
    if (es) a.title_es = pule(es); else delete a.title_es;
    for (const x of incluidas(a)) { const t = mapa[x.title!]; if (t) x.title_es = pule(t); else delete x.title_es; }
  }
}
/** Lo mismo para los resúmenes (`summary_es`). */
export function aplicaResumenes(alertas: Alerta[], mapa: Mapa) {
  for (const a of alertas) { const es = a.summary ? mapa[a.summary] : ''; if (es) a.summary_es = pule(es); else delete a.summary_es; }
}

export const pendientes = (alertas: Alerta[], mapa: Mapa) =>
  [...new Set(titulosDe(alertas).filter((t) => !(t in mapa)))].slice(0, MAX_POR_CORRIDA);
const traducible = (a: Alerta) => !RESUMEN_EN_ESPANOL.has(a.source) && !!a.summary && a.summary.trim().length >= 12;
export const resumenesPendientes = (alertas: Alerta[], mapa: Mapa) =>
  [...new Set(alertas.filter((a) => traducible(a) && !(a.summary! in mapa)).map((a) => a.summary!))].slice(0, MAX_RESUMENES_POR_CORRIDA);

// Una traducción se acepta solo si conserva los identificadores y el nombre que va antes de los dos puntos, y no se alarga de más.
function valida(orig: string, es: string): boolean {
  if (!es || es.length > orig.length * 2.2 + 24) return false;
  // Errores conocidos de la traducción automática: mejor el original que un término al revés.
  if (/servicio de denegaci[oó]n|ruta del camino/i.test(es)) return false;
  for (const id of orig.match(/CVE-\d{4}-\d+|VU#\d+/gi) ?? []) if (!es.toLowerCase().includes(id.toLowerCase())) return false;
  const i = orig.indexOf(': ');
  // El nombre antes de los dos puntos (empresa o producto) debe seguir presente, en el orden que sea.
  if (i > 0 && i < 40 && !orig.slice(0, i).split(/\s+/).every((p) => es.toLowerCase().includes(p.toLowerCase()))) return false;
  return true;
}

// Un resumen se acepta solo si conserva identificadores y números de versión, y su largo es razonable.
function validaResumen(orig: string, es: string): boolean {
  if (!es || es.length > orig.length * 1.9 + 40 || es.length < orig.length * 0.4) return false;
  const bajo = es.toLowerCase();
  for (const id of orig.match(/CVE-\d{4}-\d+|VU#\d+|GHSA-[\w-]+/gi) ?? []) if (!bajo.includes(id.toLowerCase())) return false;
  for (const v of orig.match(/\d+(?:\.\d+)+/g) ?? []) if (!es.includes(v)) return false;
  return true;
}

async function lote(ia: IA, titulos: string[], sistema = SISTEMA, valida_ = valida): Promise<Mapa> {
  const r = (await ia.run(MODELO, {
    messages: [{ role: 'system', content: sistema }, { role: 'user', content: titulos.map((t, i) => `${i + 1}. ${t.replace(/\s+/g, ' ').trim()}`).join('\n') }],
    max_tokens: 3072, temperature: 0,
  })) as { response?: unknown };
  const texto = typeof r?.response === 'string' ? r.response : '';
  const salida: Mapa = {};
  for (const linea of texto.split('\n')) {
    const m = linea.match(/^\s*(\d+)[.)]\s*(.+?)\s*$/);
    if (!m) continue;
    const orig = titulos[Number(m[1]) - 1];
    if (orig === undefined || orig in salida) continue;
    const pasa = valida_(orig.trim(), m[2]);
    if (!pasa) console.warn('traducción descartada:', orig.trim(), '→', m[2]);
    salida[orig] = pasa ? m[2] : '';
  }
  // Lo que el modelo no devolvió queda sin marcar: se reintenta en la siguiente lectura.
  return salida;
}

/** Traduce lo que falte. Devuelve true si el mapa cambió. Nunca lanza: si la IA falla, se reintenta en la siguiente lectura. */
export async function completa(ia: IA, alertas: Alerta[], mapa: Mapa): Promise<boolean> {
  const faltan = pendientes(alertas, mapa);
  const grupos: string[][] = [];
  for (let i = 0; i < faltan.length; i += LOTE) grupos.push(faltan.slice(i, i + LOTE));
  const hechos = await Promise.all(grupos.map((g) => lote(ia, g).catch((e) => { console.warn('traducir: un lote falló', String(e)); return {} as Mapa; })));
  let cambio = false;
  for (const m of hechos) for (const [k, v] of Object.entries(m)) { mapa[k] = v; cambio = true; }
  // Se olvidan los títulos que ya no están en la instantánea, para que el mapa no crezca sin límite.
  const vivos = new Set(titulosDe(alertas));
  for (const k of Object.keys(mapa)) if (!vivos.has(k)) { delete mapa[k]; cambio = true; }
  return cambio;
}

/** Lo mismo para los resúmenes: traduce los que falten y olvida los que ya no están. */
export async function completaResumenes(ia: IA, alertas: Alerta[], mapa: Mapa): Promise<boolean> {
  const faltan = resumenesPendientes(alertas, mapa);
  const grupos: string[][] = [];
  for (let i = 0; i < faltan.length; i += LOTE_RESUMENES) grupos.push(faltan.slice(i, i + LOTE_RESUMENES));
  const hechos = await Promise.all(grupos.map((g) => lote(ia, g, SISTEMA_RESUMEN, validaResumen).catch((e) => { console.warn('traducir: un lote falló', String(e)); return {} as Mapa; })));
  let cambio = false;
  for (const m of hechos) for (const [k, v] of Object.entries(m)) { mapa[k] = v; cambio = true; }
  const vivos = new Set(alertas.map((a) => a.summary).filter(Boolean));
  for (const k of Object.keys(mapa)) if (!vivos.has(k)) { delete mapa[k]; cambio = true; }
  return cambio;
}
