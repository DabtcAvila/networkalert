/**
 * «Mi lista»: lo que cada persona usa (proveedores, herramientas y dominios).
 * Este archivo lo comparten la página y el Worker, para que ambos decidan igual qué alerta coincide.
 */
export type Lista = { proveedores: string[]; palabras: string[]; dominios: string[] };
export type AlertaMin = { title: string; title_es?: string; source: string; tags?: string[]; extra?: { platform?: string; cve?: string; packages?: { name?: string }[] } & Record<string, unknown> };

export const MAX = { proveedores: 40, palabras: 20, dominios: 10 };
export const VACIA: Lista = { proveedores: [], palabras: [], dominios: [] };

const unicos = (xs: string[]) => [...new Set(xs)];
const textos = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []);

/** Deja la lista limpia y dentro de los límites. Lo que no es válido se descarta. `dominio` normaliza cada dominio (o devuelve null). */
export function limpia(x: unknown, dominio: (d: string) => string | null): Lista {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  return {
    proveedores: unicos(textos(o.proveedores).map((p) => p.trim().toLowerCase()).filter((p) => /^[a-z0-9-]{2,30}$/.test(p))).slice(0, MAX.proveedores),
    palabras: unicos(textos(o.palabras).map((p) => p.trim().toLowerCase().replace(/\s+/g, ' ')).filter((p) => /^[a-z0-9][a-z0-9 .+#@/_-]{1,39}$/.test(p))).slice(0, MAX.palabras),
    dominios: unicos(textos(o.dominios).map((d) => dominio(d)).filter((d): d is string => !!d)).slice(0, MAX.dominios),
  };
}

export const tieneAlgo = (l: Lista) => l.proveedores.length + l.palabras.length + l.dominios.length > 0;

/** Convierte «wordpress, next.js  django» en palabras sueltas. */
export const partePalabras = (texto: string) => texto.split(/[,\n]+/).map((p) => p.trim()).filter(Boolean);

// Palabras tan generales que casi cualquier alerta las menciona. Se aceptan, pero la página sugiere algo más preciso.
const GENERALES = new Set(['npm', 'pip', 'pypi', 'go', 'maven', 'nuget', 'rubygems', 'gem', 'composer', 'packagist', 'cargo', 'crates', 'js', 'ts', 'api', 'web', 'server', 'cloud', 'app', 'sql', 'http', 'https', 'ssl', 'dns', 'email', 'correo']);
/** ¿La palabra es demasiado general para dar avisos útiles? */
export const esGeneral = (p: string) => p.length < 3 || GENERALES.has(p.toLowerCase());

const escapa = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ¿La alerta toca algo de la lista? Un proveedor coincide por su página de estado; una palabra, como palabra completa en el título, el producto o los paquetes. */
export function coincide(a: AlertaMin, l: Pick<Lista, 'proveedores' | 'palabras'>): boolean {
  const plataforma = a.extra?.platform ?? (a.source.startsWith('status-') ? a.source.slice(7) : null);
  if (plataforma && l.proveedores.includes(plataforma)) return true;
  if (!l.palabras.length) return false;
  // En los avisos de paquetes las etiquetas son solo el gestor (npm, pip…): no cuentan, o «npm» traería todos los avisos de npm.
  const etiquetas = a.source === 'github-advisories' ? [] : (a.tags ?? []);
  const texto = [a.title, a.title_es ?? '', ...etiquetas, a.extra?.cve ?? '', ...(a.extra?.packages ?? []).map((p) => p?.name ?? '')].join(' \n ').toLowerCase();
  return l.palabras.some((p) => new RegExp(`(^|[^a-z0-9])${escapa(p)}([^a-z0-9]|$)`).test(texto));
}
