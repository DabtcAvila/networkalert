/**
 * Títulos en español. Las fuentes publican en inglés; aquí se traduce cada título una sola vez con
 * Workers AI (cuota gratuita) y se guarda en KV. El original nunca se pierde: queda en `title`,
 * la traducción va en `title_es`. Si la traducción falla o no pasa las comprobaciones, se deja el original.
 */
export interface IA { run(modelo: string, entrada: unknown): Promise<unknown> }
type Alerta = { source: string; title: string; title_es?: string };

const MODELO = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const LOTE = 20, MAX_POR_CORRIDA = 40;
// Fuentes cuyos títulos ya se arman en español.
const YA_EN_ESPANOL = new Set(['ioda', 'cloudflare-radar']);
const SISTEMA = `Traduces al español de México títulos de alertas de seguridad informática y de fallas de servicios de Internet.
Reglas:
- Conserva tal cual, sin traducir: nombres de empresas, productos, paquetes y regiones, identificadores (CVE-…, VU#…), versiones y el texto antes de los primeros dos puntos.
- No agregues ni quites información. No expliques.
- Español claro y directo. «Outage» es «caída»; «degraded performance» es «servicio lento»; «vulnerability» es «falla»; «remote code execution» es «ejecución remota de código».
- Responde solo con las traducciones, una por línea, cada una con el mismo número al inicio.`;

export type Mapa = Record<string, string>;

/** Pone `title_es` en cada alerta que ya tenga traducción guardada. Una cadena vacía significa «la traducción no pasó las comprobaciones; se deja el original». */
export function aplica(alertas: Alerta[], mapa: Mapa) {
  for (const a of alertas) { const es = mapa[a.title]; if (es) a.title_es = es; else delete a.title_es; }
}

export const pendientes = (alertas: Alerta[], mapa: Mapa) =>
  [...new Set(alertas.filter((a) => !YA_EN_ESPANOL.has(a.source) && !(a.title in mapa)).map((a) => a.title))].slice(0, MAX_POR_CORRIDA);

// Una traducción se acepta solo si conserva los identificadores y el nombre que va antes de los dos puntos, y no se alarga de más.
function valida(orig: string, es: string): boolean {
  if (!es || es.length > orig.length * 2.2 + 24) return false;
  for (const id of orig.match(/CVE-\d{4}-\d+|VU#\d+/gi) ?? []) if (!es.toLowerCase().includes(id.toLowerCase())) return false;
  const i = orig.indexOf(': ');
  // El nombre antes de los dos puntos (empresa o producto) debe seguir presente, en el orden que sea.
  if (i > 0 && i < 40 && !orig.slice(0, i).split(/\s+/).every((p) => es.toLowerCase().includes(p.toLowerCase()))) return false;
  return true;
}

async function lote(ia: IA, titulos: string[]): Promise<Mapa> {
  const r = (await ia.run(MODELO, {
    messages: [{ role: 'system', content: SISTEMA }, { role: 'user', content: titulos.map((t, i) => `${i + 1}. ${t.trim()}`).join('\n') }],
    max_tokens: 2048, temperature: 0,
  })) as { response?: unknown };
  const texto = typeof r?.response === 'string' ? r.response : '';
  const salida: Mapa = {};
  for (const linea of texto.split('\n')) {
    const m = linea.match(/^\s*(\d+)[.)]\s*(.+?)\s*$/);
    if (!m) continue;
    const orig = titulos[Number(m[1]) - 1];
    if (orig === undefined || orig in salida) continue;
    const pasa = valida(orig.trim(), m[2]);
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
  const hechos = await Promise.all(grupos.map((g) => lote(ia, g).catch(() => ({}) as Mapa)));
  let cambio = false;
  for (const m of hechos) for (const [k, v] of Object.entries(m)) { mapa[k] = v; cambio = true; }
  // Se olvidan los títulos que ya no están en la instantánea, para que el mapa no crezca sin límite.
  const vivos = new Set(alertas.map((a) => a.title));
  for (const k of Object.keys(mapa)) if (!vivos.has(k)) { delete mapa[k]; cambio = true; }
  return cambio;
}
