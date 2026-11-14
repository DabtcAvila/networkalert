// Lo que «Mi lista» guarda en este navegador: la lista y, si hay avisos por correo, la llave para cambiarlos.
import { VACIA, type Lista } from '../lib/lista';

const K_LISTA = 'na-lista', K_LLAVE = 'na-lista-llave';
const textos = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase()) : []);

export function leeLista(): Lista {
  try {
    const o = JSON.parse(localStorage.getItem(K_LISTA) ?? 'null');
    if (o && typeof o === 'object') return { proveedores: textos(o.proveedores), palabras: textos(o.palabras), dominios: textos(o.dominios) };
  } catch {}
  return { ...VACIA };
}
export function guardaLista(l: Lista | null) {
  try { if (l) localStorage.setItem(K_LISTA, JSON.stringify(l)); else localStorage.removeItem(K_LISTA); } catch {}
}
export function leeLlave(): string | null {
  try { const t = localStorage.getItem(K_LLAVE); return t && /^[a-f0-9]{48}$/.test(t) ? t : null; } catch { return null; }
}
export function guardaLlave(t: string | null) {
  try { if (t) localStorage.setItem(K_LLAVE, t); else localStorage.removeItem(K_LLAVE); } catch {}
}
