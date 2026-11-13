/**
 * «Revisa tu dominio»: mira un dominio desde fuera, como lo vería cualquiera, y dice qué atender.
 * Solo hace lecturas normales (la portada, DNS público, RDAP y registros públicos de certificados).
 * No guarda el dominio ni el resultado: la respuesta se arma al momento y se cachea unos minutos.
 */
export type Nivel = 'urgent' | 'fix' | 'improve' | 'ok';
export type Hallazgo = { level: Nivel; key: string; title: string; action?: string };

const UA = 'NetworkAlert-Revisar/1.0 (+https://networkalert.dev/revisar)';
const RESERVADOS = new Set(['local', 'localhost', 'internal', 'test', 'example', 'invalid', 'onion', 'arpa', 'lan', 'home', 'corp']);
const DIA = 86_400_000;
const dias = (f: string) => Math.floor((Date.parse(f) - Date.now()) / DIA);

/** Deja el dominio limpio (sin https://, ruta ni www) o devuelve null si no es un dominio público válido. */
export function normaliza(entrada: string): string | null {
  let s = entrada.trim().toLowerCase().slice(0, 300);
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = 'http://' + s;
  let host: string;
  try { host = new URL(s).hostname; } catch { return null; }
  host = host.replace(/\.$/, '').replace(/^www\./, '');
  if (host.length < 4 || host.length > 253) return null;
  if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24}|xn--[a-z0-9-]{2,59})$/.test(host)) return null;
  if (RESERVADOS.has(host.split('.').pop()!)) return null;
  return host;
}

const pide = (url: string, init: RequestInit = {}, ms = 9000) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(ms), headers: { 'user-agent': UA, ...(init.headers as Record<string, string> | undefined) } });
const intenta = async <T>(fn: () => Promise<T>): Promise<T | { error: string }> => { try { return await fn(); } catch (e) { const x = e as Error; return { error: x?.name && x.name !== 'Error' ? x.name : String(x?.message ?? e) }; } };
const fallo = (x: unknown): x is { error: string } => !!x && typeof x === 'object' && 'error' in x;

type Dns = { status: number; ad: boolean; datos: string[] };
async function dns(nombre: string, tipo: string): Promise<Dns> {
  const r = await pide(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(nombre)}&type=${tipo}&do=1`, { headers: { accept: 'application/dns-json' } }, 6000);
  if (!r.ok) throw new Error(`DNS ${r.status}`);
  const j = (await r.json()) as { Status: number; AD?: boolean; Answer?: { type: number; data: string }[] };
  const n = ({ A: 1, TXT: 16, MX: 15, CAA: 257 } as Record<string, number>)[tipo];
  // Los TXT llegan partidos en trozos entre comillas: se unen.
  const datos = (j.Answer ?? []).filter((a) => a.type === n).map((a) => (tipo === 'TXT' ? a.data.replace(/"\s+"/g, '').replace(/^"|"$/g, '') : a.data));
  return { status: j.Status, ad: !!j.AD, datos };
}

async function registro(dominio: string) {
  // RDAP solo conoce el dominio registrado: si es un subdominio se intenta también con el nivel de arriba.
  const candidatos = [dominio, ...(dominio.split('.').length > 2 ? [dominio.split('.').slice(1).join('.')] : [])];
  // rdap.org reenvía al registro de cada terminación. Algunos registros (los de .dev y .app) limitan las consultas
  // desde servidores compartidos; por eso se intenta también con el RDAP de Cloudflare Registrar.
  let ultimo = 'sin RDAP';
  for (const d of candidatos) for (const base of ['https://rdap.org/domain/', 'https://rdap.cloudflare.com/rdap/v1/domain/']) {
    const r = await pide(base + d, { headers: { accept: 'application/rdap+json' } }, 8000).catch(() => null);
    if (!r?.ok) { if (r) { ultimo = `RDAP ${r.status} en ${new URL(r.url).hostname}`; await r.body?.cancel(); } continue; }
    const j = (await r.json()) as { events?: { eventAction: string; eventDate: string }[]; status?: string[]; entities?: { roles?: string[]; vcardArray?: [string, [string, unknown, string, string][]] }[] };
    const vence = (j.events?.find((e) => e.eventAction === 'expiration') ?? j.events?.find((e) => /expiration/.test(e.eventAction)))?.eventDate ?? null;
    if (!vence) continue;
    const registrador = j.entities?.find((e) => e.roles?.includes('registrar'))?.vcardArray?.[1]?.find((v) => v[0] === 'fn')?.[3] ?? null;
    return { domain: d, expires: vence, registrar: registrador, locked: (j.status ?? []).some((x) => /transfer prohibited/i.test(x)) };
  }
  throw new Error(ultimo);
}

async function certificado(dominio: string) {
  // Registro público de certificados emitidos (Certificate Transparency). Es el más reciente emitido, no necesariamente el instalado.
  const r = await pide(`https://api.certspotter.com/v1/issuances?domain=${dominio}&include_subdomains=false&expand=dns_names`, {}, 7000);
  if (!r.ok) throw new Error(`CT ${r.status}`);
  const lista = (await r.json()) as { not_after: string; revoked?: boolean; dns_names?: string[] }[];
  const comodin = '*.' + dominio.split('.').slice(1).join('.');
  const vigentes = lista.filter((c) => !c.revoked && (c.dns_names ?? []).some((n) => n === dominio || n === comodin)).map((c) => c.not_after).sort();
  return { expires: vigentes.pop() ?? null };
}

/**
 * `propio`: cuando el dominio revisado es el de este mismo sitio, un Worker no puede pedirse a sí mismo por la red
 * (Cloudflare responde 522). En ese caso las páginas se leen directo de los archivos del sitio y se omite la prueba de http.
 */
export async function revisar(dominio: string, propio?: (url: string) => Promise<Response>) {
  const lee = (url: string, init: RequestInit, ms: number) => (propio ? propio(url) : pide(url, init, ms));
  const [w, http, www, sec, a, txt, dmarc, mx, caa, reg, cert] = await Promise.all([
    intenta(async () => { const r = await lee(`https://${dominio}/`, { redirect: 'follow' }, 12_000); await r.body?.cancel(); return { status: r.status, final: r.url || `https://${dominio}/`, h: r.headers }; }),
    intenta(async () => { if (propio) throw new Error('no aplica'); const r = await pide(`http://${dominio}/`, { redirect: 'manual' }, 8000); await r.body?.cancel(); return { status: r.status, destino: r.headers.get('location') ?? '' }; }),
    intenta(async () => { const r = await pide(`https://www.${dominio}/`, { redirect: 'manual' }, 8000); await r.body?.cancel(); return { status: r.status, destino: r.headers.get('location') ?? '' }; }),
    intenta(async () => { const r = await lee(`https://${dominio}/.well-known/security.txt`, {}, 7000); return r.ok && /contact:/i.test((await r.text()).slice(0, 4000)); }),
    intenta(() => dns(dominio, 'A')), intenta(() => dns(dominio, 'TXT')), intenta(() => dns(`_dmarc.${dominio}`, 'TXT')), intenta(() => dns(dominio, 'MX')), intenta(() => dns(dominio, 'CAA')),
    intenta(() => registro(dominio)), intenta(() => certificado(dominio)),
  ]);
  if (!fallo(a) && a.status === 3) return null; // el dominio no existe

  const spf = fallo(txt) ? undefined : (txt.datos.find((t) => /^v=spf1/i.test(t)) ?? null);
  const dm = fallo(dmarc) ? undefined : (dmarc.datos.find((t) => /^v=DMARC1/i.test(t)) ?? null);
  const politica = dm ? (dm.match(/\bp=(\w+)/i)?.[1]?.toLowerCase() ?? null) : null;
  const recibeCorreo = !fallo(mx) && mx.datos.some((m) => !/\s\.$/.test(m));
  const hostFinal = fallo(w) ? null : new URL(w.final).hostname;
  const venceCert = fallo(cert) ? null : cert.expires;
  const venceDom = fallo(reg) ? null : reg.expires;

  const h: Hallazgo[] = [];
  const pon = (level: Nivel, key: string, title: string, action?: string) => h.push({ level, key, title, action });

  // 1. ¿Abre?
  if (fallo(w)) pon('urgent', 'web', 'El sitio no abre por conexión segura (https).', 'Revisa con tu proveedor de hospedaje que el sitio esté arriba y que el candado esté instalado.');
  else if (w.status >= 500) pon('urgent', 'web', `El sitio responde con error ${w.status}.`, 'Es una falla del servidor. Revisa tu hospedaje o el último cambio que subiste.');
  else if (w.status >= 400) pon('fix', 'web', `La portada responde con error ${w.status}.`, 'Confirma que la página de inicio exista y sea pública.');
  else pon('ok', 'web', 'El sitio abre con candado (https).');

  // 2. Candado
  if (!fallo(w) && venceCert) {
    const d = dias(venceCert);
    if (d < 7) pon('urgent', 'cert', `El candado (certificado) vence en ${d} días.`, 'Si no se renueva, los navegadores mostrarán «sitio no seguro». Renuévalo o revisa la renovación automática.');
    else if (d < 21) pon('fix', 'cert', `El candado (certificado) vence en ${d} días.`, 'Confirma que la renovación automática esté funcionando.');
    else pon('ok', 'cert', `El candado (certificado) vence en ${d} días.`);
  }
  if (!fallo(http) && !fallo(w)) {
    const aSeguro = http.status >= 300 && http.status < 400 && /^https:\/\//i.test(http.destino);
    if (aSeguro) pon('ok', 'http', 'Quien entra sin candado (http) es enviado a la versión segura.');
    else pon('fix', 'http', 'Quien entra sin candado (http) no es enviado a la versión segura.', 'Activa «forzar HTTPS» en tu hospedaje o en Cloudflare (Always Use HTTPS).');
  }

  // 3. Dominio
  if (venceDom) {
    const d = dias(venceDom);
    if (d < 30) pon('urgent', 'domain', `El dominio vence en ${d} días.`, 'Renuévalo ya. Si vence, el sitio y el correo dejan de funcionar y alguien más puede comprarlo.');
    else if (d < 75) pon('fix', 'domain', `El dominio vence en ${d} días.`, 'Confirma la renovación automática y que la tarjeta esté vigente.');
    else pon('ok', 'domain', `El dominio vence en ${d} días.`);
  } else pon('improve', 'domain', 'No se pudo consultar cuándo vence el dominio.', 'Algunas terminaciones (como .mx) no publican la fecha. Revísala con quien te vendió el dominio.');
  if (!fallo(reg) && reg.locked === false) pon('fix', 'lock', 'El dominio no está bloqueado contra transferencias.', 'Activa el «bloqueo de transferencia» (registrar lock) donde lo compraste.');

  // 4. Correo
  if (dm === null) pon('fix', 'dmarc', 'Cualquiera puede enviar correos que parecen venir de este dominio.', 'Falta el registro DMARC. Se agrega en el DNS; en Cloudflare está en Email → DMARC Management.');
  else if (politica === 'none') pon('improve', 'dmarc', 'La protección contra correos falsos está en modo «solo observar».', 'Cuando confirmes que tu correo legítimo pasa, sube DMARC de p=none a p=quarantine.');
  else if (dm) pon('ok', 'dmarc', 'El dominio rechaza correos falsos enviados a su nombre (DMARC).');
  if (spf === null) pon(recibeCorreo ? 'fix' : 'improve', 'spf', 'No declara qué servidores pueden enviar correo a su nombre.', recibeCorreo ? 'Falta el registro SPF. Tu proveedor de correo te da el valor exacto.' : 'Si el dominio no envía correo, publica el registro SPF «v=spf1 -all».');
  else if (spf && /\+all/.test(spf)) pon('urgent', 'spf', 'Autoriza a todo Internet a enviar correo a su nombre.', 'El registro SPF termina en «+all». Cámbialo por «~all» o «-all».');
  else if (spf) pon('ok', 'spf', 'Declara qué servidores pueden enviar correo a su nombre (SPF).');

  // 5. www
  if (!fallo(w)) {
    if (hostFinal === `www.${dominio}`) pon('ok', 'www', 'El dominio sin www manda a la versión con www.');
    else if (propio && (fallo(www) || www.status >= 500)) { /* no se puede probar desde dentro */ }
    else if (fallo(www)) pon('improve', 'www', 'La dirección con www no abre.', 'Quien escriba www verá un error. Agrega una redirección de www al dominio.');
    else if (www.status >= 300 && www.status < 400) pon('ok', 'www', 'La dirección con www manda al dominio principal.');
    else if (www.status < 300) pon('improve', 'www', 'La dirección con www muestra una copia del sitio en vez de redirigir.', 'Los buscadores pueden verlo como contenido duplicado. Redirige www al dominio principal.');
    else pon('improve', 'www', 'La dirección con www no abre.', 'Quien escriba www verá un error. Agrega una redirección de www al dominio.');
  }

  // 6. Protecciones del navegador
  if (!fallo(w)) {
    const c = w.h, csp = c.get('content-security-policy') ?? '';
    const faltan: string[] = [];
    if (!c.get('strict-transport-security')) faltan.push('obligar siempre la conexión segura (HSTS)');
    if (!csp) faltan.push('limitar qué código puede cargar la página (CSP)');
    if (c.get('x-content-type-options') !== 'nosniff') faltan.push('evitar que el navegador adivine tipos de archivo (nosniff)');
    if (!c.get('x-frame-options') && !/frame-ancestors/.test(csp)) faltan.push('impedir que otro sitio lo muestre dentro del suyo (X-Frame-Options)');
    if (faltan.length) pon('improve', 'headers', `Le faltan ${faltan.length} de 4 protecciones del navegador.`, `Falta: ${faltan.join('; ')}. Se agregan como cabeceras en tu hospedaje.`);
    else pon('ok', 'headers', 'Tiene las 4 protecciones básicas del navegador.');
  }

  // 7. DNS y contacto
  if (!fallo(a)) { if (a.ad) pon('ok', 'dnssec', 'Sus direcciones de Internet están firmadas (DNSSEC).'); else pon('improve', 'dnssec', 'Sus direcciones de Internet no están firmadas (DNSSEC).', 'Evita que alguien desvíe a tus visitantes. Se activa con un clic en la mayoría de los proveedores de DNS.'); }
  if (!fallo(caa) && caa.datos.length === 0) pon('improve', 'caa', 'No limita quién puede emitir candados a su nombre (CAA).', 'Opcional: un registro CAA en el DNS indica qué autoridades pueden emitir certificados.');
  if (sec !== true) pon('improve', 'security_txt', 'No dice a quién avisar si alguien encuentra una falla.', 'Publica un archivo /.well-known/security.txt con un correo de contacto.');
  else pon('ok', 'security_txt', 'Dice a quién avisar si alguien encuentra una falla (security.txt).');

  const ORD: Record<Nivel, number> = { urgent: 0, fix: 1, improve: 2, ok: 3 };
  h.sort((x, y) => ORD[x.level] - ORD[y.level]);
  const cuenta = (n: Nivel) => h.filter((x) => x.level === n).length;
  return {
    domain: dominio,
    checked_at: new Date().toISOString(),
    verdict: (cuenta('urgent') ? 'urgent' : cuenta('fix') ? 'fix' : cuenta('improve') ? 'improve' : 'ok') as Nivel,
    summary: { urgent: cuenta('urgent'), fix: cuenta('fix'), improve: cuenta('improve'), ok: cuenta('ok') },
    findings: h,
    details: {
      web: fallo(w) ? { error: w.error } : { status: w.status, final_url: w.final },
      certificate: { expires: venceCert, days_left: venceCert ? dias(venceCert) : null, source: 'Registro público de certificados (Certificate Transparency); es el más reciente emitido.' },
      registration: fallo(reg) ? { expires: null, error: reg.error } : { expires: reg.expires, days_left: reg.expires ? dias(reg.expires) : null, registrar: reg.registrar, locked: reg.locked },
      email: { receives_mail: recibeCorreo, spf: spf ?? null, dmarc: dm ?? null, dmarc_policy: politica },
      dns: { dnssec: fallo(a) ? null : a.ad, caa: fallo(caa) ? null : caa.datos.length > 0 },
    },
    notes: [
      'Revisión hecha desde fuera, con datos públicos. No entra a tu servidor ni prueba contraseñas.',
      'No guardamos el dominio ni el resultado.',
      'Es una orientación, no una auditoría de seguridad.',
    ],
  };
}
