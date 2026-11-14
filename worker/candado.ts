/**
 * Fecha del candado INSTALADO. Abre una conexión al puerto 443 del sitio, saluda como lo haría un navegador
 * (TLS 1.2) y lee el certificado que el servidor presenta, que en esa versión viaja sin cifrar. No se completa
 * la conexión ni se pide ninguna página.
 * Límites: Cloudflare no deja a un Worker abrir conexiones directas a sitios que están detrás de Cloudflare, y hay
 * servidores que solo aceptan TLS 1.3 (ahí el certificado viaja cifrado). En esos casos devuelve null y quien llama
 * usa el registro público de certificados emitidos.
 */
import { connect } from 'cloudflare:sockets';

const u16 = (n: number) => [n >> 8, n & 255];
const u24 = (n: number) => [n >> 16, (n >> 8) & 255, n & 255];
const conLargo16 = (b: number[]) => [...u16(b.length), ...b];

function saludo(host: string): Uint8Array {
  const nombre = [...new TextEncoder().encode(host)];
  const ext = (tipo: number, cuerpo: number[]) => [...u16(tipo), ...conLargo16(cuerpo)];
  const extensiones = [
    ...ext(0, conLargo16([0, ...conLargo16(nombre)])),                                   // nombre del sitio (SNI)
    ...ext(10, conLargo16([0x00, 0x1d, 0x00, 0x17, 0x00, 0x18])),                        // curvas
    ...ext(11, [1, 0]),                                                                  // formato de puntos
    ...ext(13, conLargo16([4, 3, 8, 4, 4, 1, 5, 3, 8, 5, 5, 1, 8, 6, 6, 1, 2, 1])),      // firmas
  ];
  const suites = [0xc02f, 0xc02b, 0xc030, 0xc02c, 0xcca8, 0xcca9, 0x009e, 0x009c, 0x002f, 0x0035, 0x00ff].flatMap(u16);
  const cuerpo = [3, 3, ...crypto.getRandomValues(new Uint8Array(32)), 0, ...conLargo16(suites), 1, 0, ...conLargo16(extensiones)];
  const mensaje = [1, ...u24(cuerpo.length), ...cuerpo];
  return new Uint8Array([0x16, 3, 1, ...u16(mensaje.length), ...mensaje]);
}

// Lector mínimo de DER: devuelve etiqueta, inicio y fin del contenido del elemento que empieza en `i`.
function der(b: Uint8Array, i: number): { tag: number; ini: number; fin: number } {
  const tag = b[i]; let n = b[i + 1], ini = i + 2;
  if (n & 0x80) { const k = n & 0x7f; n = 0; for (let j = 0; j < k; j++) n = n * 256 + b[ini + j]; ini += k; }
  if (!(ini + n <= b.length)) throw new Error('DER');
  return { tag, ini, fin: ini + n };
}
function fecha(b: Uint8Array, e: { tag: number; ini: number; fin: number }): string {
  const t = new TextDecoder().decode(b.subarray(e.ini, e.fin));
  // UTCTime (AAMMDDhhmmssZ) o GeneralizedTime (AAAAMMDDhhmmssZ).
  const m = e.tag === 0x17 ? t.match(/^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/) : t.match(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?/);
  if (!m) throw new Error('fecha');
  const anio = e.tag === 0x17 ? (Number(m[1]) >= 50 ? 1900 : 2000) + Number(m[1]) : Number(m[1]);
  return new Date(Date.UTC(anio, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0))).toISOString();
}
/** Vigencia de un certificado X.509 en DER. */
export function vigencia(cert: Uint8Array): { issued: string; expires: string } {
  const tbs = der(cert, der(cert, 0).ini);
  let e = der(cert, tbs.ini);
  if (e.tag === 0xa0) e = der(cert, e.fin);       // versión (opcional)
  e = der(cert, e.fin);                            // tras el número de serie: algoritmo
  e = der(cert, e.fin);                            // emisor
  const val = der(cert, e.fin);                    // vigencia
  const desde = der(cert, val.ini), hasta = der(cert, desde.fin);
  return { issued: fecha(cert, desde), expires: fecha(cert, hasta) };
}

export async function candadoInstalado(host: string, ms = 6000): Promise<{ issued: string; expires: string } | null> {
  let socket: ReturnType<typeof connect> | null = null;
  const lee = async () => {
    socket = connect({ hostname: host, port: 443 }, { secureTransport: 'off', allowHalfOpen: false });
    const w = socket.writable.getWriter();
    await w.write(saludo(host)); w.releaseLock();
    const r = socket.readable.getReader();
    let crudo = new Uint8Array(0), manos = new Uint8Array(0);
    const suma = (a: Uint8Array, b: Uint8Array) => { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; };
    for (let total = 0; total < 64_000;) {
      const { value, done } = await r.read();
      if (done || !value) return null;
      total += value.length; crudo = suma(crudo, value);
      // Registros completos: tipo (1), versión (2), largo (2).
      while (crudo.length >= 5) {
        const n = (crudo[3] << 8) | crudo[4];
        if (crudo.length < 5 + n) break;
        if (crudo[0] !== 0x16) return null;        // alerta u otra cosa: el servidor no siguió con TLS 1.2
        manos = suma(manos, crudo.subarray(5, 5 + n)); crudo = crudo.subarray(5 + n);
      }
      // Mensajes del saludo: tipo (1), largo (3). El 11 es el certificado.
      let i = 0;
      while (manos.length >= i + 4) {
        const n = (manos[i + 1] << 16) | (manos[i + 2] << 8) | manos[i + 3];
        if (manos.length < i + 4 + n) break;
        if (manos[i] === 11) { const c = i + 4 + 3, largo = (manos[c] << 16) | (manos[c + 1] << 8) | manos[c + 2]; return vigencia(manos.subarray(c + 3, c + 3 + largo)); }
        if (manos[i] === 14) return null;          // fin del saludo sin certificado
        i += 4 + n;
      }
    }
    return null;
  };
  try { return await Promise.race([lee(), new Promise<null>((res) => setTimeout(() => res(null), ms))]); }
  catch { return null; }
  finally { try { await (socket as ReturnType<typeof connect> | null)?.close(); } catch { /* ya cerrado */ } }
}
