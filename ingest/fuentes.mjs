// Catálogo de fuentes de Network Alert. Cada fuente declara de dónde sale el dato, bajo qué términos
// y cómo se normaliza. Regla del proyecto: ninguna alerta se publica sin fuente primaria enlazada.
//
// Todas son públicas y gratuitas. Las que piden credencial (opcional) se saltan si no hay variable de entorno.

const UA = 'NetworkAlert/1.0 (+https://networkalert.dev/fuentes)';
const DIA = 86_400_000;

export async function pedir(url, { timeout = 20_000, headers = {}, tipo = 'json' } = {}) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: tipo === 'json' ? 'application/json' : '*/*', ...headers }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return tipo === 'json' ? r.json() : r.text();
}

const iso = (d) => { const t = new Date(d); return Number.isNaN(t.getTime()) ? null : t.toISOString(); };
// Texto plano y corto. Algunas fuentes escapan dos veces (&amp;gt;): se deshace aquí; al mostrarlo siempre se vuelve a escapar.
const ENTIDAD = { '&gt;': '>', '&lt;': '<', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&amp;': '&', '&nbsp;': ' ' };
const recorta = (s, n = 320) => { const t = String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&(gt|lt|quot|#39|apos|amp|nbsp);/g, (e) => ENTIDAD[e]).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
const desdeHace = (dias) => Date.now() - dias * DIA;
// Fecha en palabras («4 de diciembre de 2026») para el campo `action`.
const fechaLarga = (d) => { const t = new Date(`${String(d).slice(0, 10)}T12:00:00Z`); return Number.isNaN(t.getTime()) ? null : new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(t); };

// `action`: qué hacer, en una línea y en español. Solo se arma cuando la fuente da un dato concreto para decirlo
// (versión corregida, fecha límite, página de estado). Si no lo hay, la alerta va sin `action` en vez de inventarlo.
function accionPaquetes(paquetes) {
  if (!paquetes.length) return null;
  const con = paquetes.filter((v) => v.first_patched_version), sin = paquetes.filter((v) => !v.first_patched_version);
  const partes = [];
  const mas = con.length > 3 ? ` y ${con.length - 3} más (ver la fuente)` : '';
  // Si todos se corrigen en la misma versión, se dice una sola vez.
  if (con.length > 1 && new Set(con.map((v) => v.first_patched_version)).size === 1) partes.push(`Actualiza ${con.slice(0, 3).map((v) => v.package.name).join(', ')}${mas} a la versión ${con[0].first_patched_version} o posterior.`);
  else if (con.length) partes.push(`Actualiza ${con.slice(0, 3).map((v) => `${v.package.name} a la versión ${v.first_patched_version} o posterior`).join('; ')}${mas ? `;${mas}` : ''}.`);
  if (sin.length) partes.push(`${sin.slice(0, 3).map((v) => v.package.name).join(', ')}: todavía no hay versión corregida; revisa en la fuente las medidas temporales.`);
  return partes.join(' ');
}

// Lector mínimo de RSS/Atom: basta para título, enlace, fecha y resumen de cada entrada.
function leerFeed(xml) {
  const des = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
  const campo = (bloque, nombres) => { for (const n of nombres) { const m = bloque.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, 'i')); if (m) return des(m[1]).trim(); } return ''; };
  return [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].map(([b]) => ({
    titulo: campo(b, ['title']),
    url: campo(b, ['link']) || (b.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? ''),
    fecha: campo(b, ['pubDate', 'updated', 'published', 'dc:date']),
    resumen: campo(b, ['description', 'summary', 'content']),
    id: campo(b, ['guid', 'id']),
  }));
}

/* ------------------------------------------------------------------ Vulnerabilidades */

// CISA KEV: vulnerabilidades con explotación confirmada en el mundo real. Dominio público (gobierno de EE. UU.).
// CISA escribe «Multiple Products» cuando la falla toca varios productos del fabricante.
const productoKev = (v) => (!v.product || v.product === v.vendorProject ? '' : /^multiple\b/i.test(v.product) ? ' para varios de sus productos' : ` para ${v.product}`);
// La fecha límite es para agencias de EE. UU., pero sirve de referencia. Cuando ya pasó se dice así, en vez de dejar una fecha vieja como si faltara.
function plazoKev(due) {
  const f = fechaLarga(due);
  if (!f) return '';
  return Date.parse(`${String(due).slice(0, 10)}T23:59:59Z`) < Date.now()
    ? ` La fecha límite que CISA dio a las agencias de EE. UU. venció el ${f}: si aún no lo corriges, hazlo cuanto antes.`
    : ` CISA da a las agencias de EE. UU. hasta el ${f} para hacerlo.`;
}
const accionKev = (v) => `Instala la corrección que publicó ${v.vendorProject || 'el fabricante'}${productoKev(v)}. Si aún no existe, aplica sus medidas temporales o deja de usar el producto.${plazoKev(v.dueDate)}`;
const urlKev = (texto) => `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=${encodeURIComponent(texto)}`;
const nombreKev = (v) => (String(v.vulnerabilityName ?? '').toLowerCase().startsWith(String(v.vendorProject ?? '').toLowerCase()) ? v.vulnerabilityName : `${v.vendorProject} ${v.product}: ${v.vulnerabilityName}`);

export function alertasKev(vulnerabilidades) {
  // Menos ruido: las fallas del mismo producto que CISA agregó el mismo día y con la misma fecha límite piden lo mismo
  // (instalar la corrección de ese producto), así que van en una sola alerta que las lista.
  const grupos = new Map();
  for (const v of vulnerabilidades) {
    const k = `${v.vendorProject}|${v.product}|${v.dateAdded}|${v.dueDate}`;
    (grupos.get(k) ?? grupos.set(k, []).get(k)).push(v);
  }
  return [...grupos.values()].map((vs) => {
    const v = vs[0], ransomware = vs.some((x) => x.knownRansomwareCampaignUse === 'Known');
    const base = { source: 'cisa-kev', category: 'vulnerability', severity: ransomware ? 'critical' : 'high', published: iso(v.dateAdded), status: 'active', action: accionKev(v) };
    if (vs.length === 1) return {
      ...base,
      id: `kev:${v.cveID}`,
      // El nombre que da CISA ya suele empezar con fabricante y producto; no se repiten.
      title: nombreKev(v),
      summary: recorta(v.shortDescription),
      url: urlKev(v.cveID),
      tags: ['explotada', v.vendorProject, v.product].filter(Boolean),
      extra: { cve: v.cveID, ransomware, due: v.dueDate, action: recorta(v.requiredAction, 240), cwes: v.cwes ?? [] },
    };
    // «PHP Group» + «PHP» se queda en «PHP»; «Multiple Products» no se pone.
    const soloProducto = v.product && String(v.vendorProject ?? '').toLowerCase().includes(String(v.product).toLowerCase());
    const producto = soloProducto ? v.product : [v.vendorProject, /^multiple\b/i.test(v.product ?? '') ? '' : v.product].filter(Boolean).join(' ');
    return {
      ...base,
      id: `kev:grupo:${`${v.vendorProject}-${v.product}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}:${String(v.dateAdded).slice(0, 10)}`,
      title: `${producto}: ${vs.length} fallas en ataque`,
      summary: recorta(vs.map((x) => x.shortDescription).join(' '), 480),
      url: urlKev(producto),
      tags: ['explotada', v.vendorProject, v.product, ...vs.map((x) => x.cveID)].filter(Boolean),
      extra: { grouped: vs.length, ransomware, due: v.dueDate, cwes: [...new Set(vs.flatMap((x) => x.cwes ?? []))],
        advisories: vs.map((x) => ({ id: x.cveID, title: nombreKev(x), url: urlKev(x.cveID), severity: x.knownRansomwareCampaignUse === 'Known' ? 'critical' : 'high', published: iso(x.dateAdded) })) },
    };
  });
}
async function kev() {
  const j = await pedir('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', { timeout: 40_000 });
  const corte = desdeHace(30);
  return alertasKev(j.vulnerabilities.filter((v) => Date.parse(v.dateAdded) >= corte));
}

// Qué puede pasar, en una línea y en palabras llanas. Sale del tipo de falla que declara la fuente (CWE) y de su
// vector CVSS; si la fuente no da un tipo que esté en esta tabla, no se dice nada en vez de inventarlo.
// Solo entran tipos de falla cuya consecuencia es clara; los ambiguos (configuración insegura por defecto,
// validación de datos en general) se dejan fuera para no decir algo que el aviso no dice.
const RIESGO_CWE = [
  [[94, 95, 96, 77, 78, 88, 917, 1336, 502], 'Un atacante puede ejecutar sus propias órdenes en tu servidor'],
  [[89, 564, 943], 'Un atacante puede leer o cambiar tu base de datos'],
  [[287, 288, 290, 294, 302, 303, 304, 305, 306, 307, 384, 1390, 798, 259, 321], 'Un atacante puede entrar sin una contraseña válida'],
  [[862, 863, 284, 285, 639, 269, 732], 'Alguien puede ver o hacer cosas para las que no tiene permiso'],
  [[22, 23, 24, 35, 36, 73, 434], 'Un atacante puede leer o escribir archivos de tu servidor que no debería'],
  [[79, 80, 83, 87], 'Un atacante puede meter código en las páginas que ven tus usuarios'],
  [[918], 'Un atacante puede hacer que tu servidor consulte direcciones internas en su nombre'],
  [[345, 347, 295, 296, 297, 327, 328, 326, 330, 338, 354], 'Se pueden dar por buenos datos, firmas o certificados falsos'],
  [[200, 201, 203, 209, 212, 312, 319, 359, 522, 532, 538, 540], 'Puede quedar expuesta información que debería ser privada'],
  [[352], 'Un sitio ajeno puede hacer acciones a nombre de un usuario con la sesión abierta'],
  [[601], 'Un enlace de tu sitio puede mandar a tus usuarios a un sitio falso'],
  [[611, 776], 'Un archivo preparado puede leer datos de tu servidor o dejarlo sin responder'],
  [[119, 120, 121, 122, 125, 787, 416, 415, 190, 191, 476, 843], 'Datos preparados pueden tirar el programa o, en el peor caso, tomar su control'],
  [[400, 770, 407, 1333, 674, 835, 834, 405, 409, 789], 'Un atacante puede dejar tu servicio lento o sin responder'],
];
export function riesgoDe(cwes, vector) {
  const ids = (cwes ?? []).map((c) => Number(String(c.cwe_id ?? c).replace(/\D/g, '')));
  const frase = RIESGO_CWE.find(([lista]) => ids.some((i) => lista.includes(i)))?.[1];
  if (!frase) return null;
  const v = String(vector ?? '');
  // Desde dónde se puede aprovechar: solo cuando el vector CVSS lo dice de forma expresa.
  const como = /\/AV:N/.test(v) ? (/\/PR:N/.test(v) ? ' Según la fuente, se puede aprovechar a distancia y sin iniciar sesión.' : /\/PR:[LH]/.test(v) ? ' Según la fuente, se puede aprovechar a distancia con una cuenta de usuario.' : ' Según la fuente, se puede aprovechar a distancia.') : '';
  return `${frase}.${como}`;
}

const ORD_SEV = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const resumenPaquetes = (paquetes) => paquetes.slice(0, 4).map((v) => `${v.package.name} (${v.package.ecosystem}) ${v.vulnerable_version_range ?? ''}${v.first_patched_version ? ` → corregido en ${v.first_patched_version}` : ' → sin parche'}`).join(' · ');

// GitHub Advisory Database (revisadas): fallas en paquetes de npm, PyPI, Composer, Go, etc. Licencia CC BY 4.0.
export function alertasGhsa(avisos) {
  const unos = avisos.map((a) => {
    const paquetes = [...new Map((a.vulnerabilities ?? []).filter((v) => v.package?.name).map((v) => [`${v.package.ecosystem}:${v.package.name}`, v])).values()];
    const riesgo = riesgoDe(a.cwes, a.cvss_severities?.cvss_v3?.vector_string ?? a.cvss_severities?.cvss_v4?.vector_string ?? a.cvss?.vector_string);
    return {
      id: `ghsa:${a.ghsa_id}`,
      source: 'github-advisories',
      category: 'vulnerability',
      severity: a.severity === 'critical' ? 'critical' : 'high',
      title: a.summary,
      summary: [riesgo, resumenPaquetes(paquetes)].filter(Boolean).join(' '),
      action: accionPaquetes(paquetes),
      url: a.html_url,
      published: iso(a.published_at),
      updated: iso(a.updated_at),
      status: 'active',
      tags: [...new Set(paquetes.map((v) => v.package?.ecosystem).filter(Boolean))],
      extra: { cve: a.cve_id ?? null, ghsa: a.ghsa_id, cvss: a.cvss?.score ?? null, ...(riesgo ? { risk: riesgo } : {}), packages: paquetes.slice(0, 8).map((v) => ({ ecosystem: v.package.ecosystem, name: v.package.name, range: v.vulnerable_version_range, patched: v.first_patched_version ?? null })) },
      // Para agrupar: mismos paquetes y misma versión corregida = misma instrucción.
      _clave: paquetes.length ? paquetes.map((v) => `${v.package.ecosystem}:${v.package.name}@${v.first_patched_version ?? ''}`).sort().join('|') : null,
    };
  });
  // Menos ruido: varios avisos del mismo paquete que se corrigen con la misma versión piden exactamente lo mismo.
  // Van en una sola alerta que los lista, con la gravedad del más grave.
  const grupos = new Map();
  for (const a of unos) { const k = a._clave ?? a.id; (grupos.get(k) ?? grupos.set(k, []).get(k)).push(a); }
  return [...grupos.values()].map((as) => {
    for (const a of as) delete a._clave;
    if (as.length === 1) return as[0];
    const orden = [...as].sort((x, y) => ORD_SEV[x.severity] - ORD_SEV[y.severity] || (y.extra.cvss ?? 0) - (x.extra.cvss ?? 0) || Date.parse(y.published) - Date.parse(x.published));
    const p = orden[0].extra.packages, uno = p[0];
    const nombres = `${p.slice(0, 2).map((x) => x.name).join(', ')}${p.length > 2 ? ` y ${p.length - 2} más` : ''}`;
    // De un grupo se dice solo el riesgo de la falla más grave, y se avisa que es la más grave: las demás están en la lista.
    const r0 = orden[0].extra.risk, riesgos = r0 ? [`Lo más grave: ${r0[0].toLowerCase()}${r0.slice(1)}`] : [];
    return {
      id: `ghsa:grupo:${`${uno.ecosystem}-${uno.name}-${uno.patched ?? 'sin-parche'}`.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')}`,
      source: 'github-advisories', category: 'vulnerability', severity: orden[0].severity,
      title: uno.patched ? `${nombres}: ${as.length} fallas que se corrigen con la versión ${uno.patched}` : `${nombres}: ${as.length} fallas sin versión corregida`,
      summary: [...riesgos, `${as.length} avisos para ${nombres} (${uno.ecosystem})${uno.patched ? `; todos se corrigen al actualizar a ${uno.patched}` : ''}.`].join(' '),
      action: orden[0].action,
      url: `https://github.com/advisories?query=${encodeURIComponent(`${uno.name} ecosystem:${String(uno.ecosystem).toLowerCase()}`)}`,
      published: as.map((a) => a.published).sort().at(-1),
      updated: as.map((a) => a.updated ?? a.published).sort().at(-1),
      status: 'active',
      tags: orden[0].tags,
      extra: { grouped: as.length, cvss: Math.max(...as.map((a) => a.extra.cvss ?? 0)) || null, ...(riesgos.length ? { risk: riesgos[0] } : {}), packages: p,
        advisories: orden.slice(0, 15).map((a) => ({ id: a.extra.ghsa, cve: a.extra.cve, title: a.title, url: a.url, severity: a.severity, published: a.published })) },
    };
  });
}
async function ghsa() {
  const headers = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'x-github-api-version': '2022-11-28' } : {};
  const desde = new Date(desdeHace(7)).toISOString().slice(0, 10);
  const pag = (sev) => pedir(`https://api.github.com/advisories?type=reviewed&severity=${sev}&published=%3E%3D${desde}&per_page=100&sort=published&direction=desc`, { headers });
  const [crit, altas] = await Promise.all([pag('critical'), pag('high')]);
  const corteAltas = desdeHace(3);
  return alertasGhsa([...crit, ...altas.filter((a) => Date.parse(a.published_at) >= corteAltas)].filter((a) => !a.withdrawn_at));
}

// Avisos de seguridad de Node.js (releases de seguridad del runtime). Licencia MIT del sitio nodejs.org.
async function nodejs() {
  const xml = await pedir('https://nodejs.org/en/feed/vulnerability.xml', { tipo: 'texto' });
  const corte = desdeHace(21);
  return leerFeed(xml).filter((e) => Date.parse(e.fecha) >= corte).map((e) => ({
    id: `nodejs:${e.url.split('/').filter(Boolean).pop()}`,
    source: 'nodejs-security', category: 'advisory', severity: 'medium',
    title: `Node.js: ${e.titulo}`, summary: recorta(e.resumen) || 'Aviso de seguridad del equipo de Node.js. El detalle y las versiones corregidas están en la fuente.', action: 'Actualiza Node.js a la versión más reciente de la línea que usas (la fuente lista las versiones corregidas).', url: e.url, published: iso(e.fecha), status: 'active', tags: ['nodejs'], extra: {},
  }));
}

// CERT/CC (Carnegie Mellon): notas de vulnerabilidad coordinadas, suelen cubrir fallas de protocolo y de cadena de suministro.
async function certcc() {
  const xml = await pedir('https://www.kb.cert.org/vuls/atomfeed/', { tipo: 'texto' });
  const corte = desdeHace(21);
  return leerFeed(xml).filter((e) => Date.parse(e.fecha) >= corte).map((e) => ({
    id: `certcc:${(e.url.match(/id\/(\d+)/) ?? [])[1] ?? e.id}`,
    source: 'cert-cc', category: 'advisory', severity: 'medium',
    // Las notas empiezan con el encabezado «Overview»: se quita para que el resumen abra con el contenido.
    title: e.titulo, summary: recorta(String(e.resumen).replace(/<[^>]+>/g, ' ').replace(/^\s*Overview\b[\s:]*/i, '')), url: e.url, published: iso(e.fecha), status: 'active', tags: ['coordinada'], extra: {},
    action: 'Revisa en la nota si usas alguno de los productos afectados: ahí está la lista de fabricantes y cuáles ya publicaron corrección.',
  }));
}

/* ------------------------------------------------------------------ Conectividad por país */

// IODA (Georgia Tech): detección de cortes de Internet a partir de BGP, sondeo activo y telescopio de red.
const IODA = 'https://api.ioda.inetintel.cc.gatech.edu/v2';
const SENAL = { bgp: 'rutas BGP', 'ping-slash24': 'sondeo activo', 'merit-nt': 'telescopio de red', gtr: 'tráfico de Google' };
// La última alerta de cada (entidad, señal) dice el estado vigente: si no es «normal», la señal sigue caída.
function senalesIoda(datos) {
  const ultimo = new Map();
  for (const a of datos ?? []) {
    const k = `${a.entity.code}|${a.datasource}`;
    if (!ultimo.has(k) || ultimo.get(k).time < a.time) ultimo.set(k, a);
  }
  const porEntidad = new Map();
  for (const a of ultimo.values()) {
    if (a.level === 'normal') continue;
    const p = porEntidad.get(a.entity.code) ?? { nombre: a.entity.name, senales: [] };
    p.senales.push({ signal: a.datasource, level: a.level, time: a.time, drop: a.historyValue ? Math.round((1 - a.value / a.historyValue) * 100) : null });
    porEntidad.set(a.entity.code, p);
  }
  return porEntidad;
}
// Una sola señal con caída pequeña es ruido frecuente; se publica como informativa y no mueve el nivel global.
function gravedadIoda(senales) {
  const caida = Math.max(0, ...senales.map((s) => s.drop ?? 0));
  const criticas = senales.filter((s) => s.level === 'critical').length;
  return { caida, severity: criticas >= 2 && caida >= 25 ? 'high' : criticas >= 2 || caida >= 25 ? 'medium' : caida >= 8 ? 'low' : 'info' };
}
const resumenIoda = (senales) => senales.map((s) => `${SENAL[s.signal] ?? s.signal}${s.drop != null ? ` −${s.drop}%` : ''}`).join(' · ');

// Cortes por país.
async function ioda() {
  const ahora = Math.floor(Date.now() / 1000);
  const j = await pedir(`${IODA}/outages/alerts?from=${ahora - 86_400}&until=${ahora}&entityType=country&limit=2000`, { timeout: 30_000 });
  return [...senalesIoda(j.data)].map(([code, p]) => {
    // IODA da el nombre en inglés («Norfolk Island»): se usa el nombre en español del código de país.
    try { p.nombre = nombrePais.of(code) ?? p.nombre; } catch { /* se queda el de la fuente */ }
    const { caida, severity } = gravedadIoda(p.senales);
    const desde = Math.min(...p.senales.map((s) => s.time));
    return {
      id: `ioda:${code}`,
      source: 'ioda', category: 'connectivity', severity,
      title: `${p.nombre}: señales de corte de Internet`,
      summary: resumenIoda(p.senales),
      url: `https://ioda.inetintel.cc.gatech.edu/country/${code}`,
      published: iso(desde * 1000), status: 'active', countries: [code], tags: ['corte'],
      action: `No depende de ti. Si tienes visitantes o servidores en ${p.nombre}, pueden tener lentitud o no poder entrar; la gráfica de la fuente muestra cuándo se recupera.`,
      extra: { signals: p.senales, max_drop_pct: caida },
    };
  });
}

/* ------------------------------------------------------------------ México: estados y proveedores */

// Los 32 estados, con el código que usa IODA. «Distrito Federal» y «México» se muestran con su nombre actual.
export const ESTADOS_MX = [
  ['2563', 'Aguascalientes'], ['2552', 'Baja California'], ['2553', 'Baja California Sur'], ['2568', 'Campeche'], ['2581', 'Chiapas'], ['2555', 'Chihuahua'],
  ['2573', 'Ciudad de México'], ['2554', 'Coahuila'], ['2564', 'Colima'], ['2556', 'Durango'], ['2577', 'Estado de México'], ['2574', 'Guanajuato'],
  ['2575', 'Guerrero'], ['2576', 'Hidalgo'], ['2565', 'Jalisco'], ['2566', 'Michoacán'], ['2578', 'Morelos'], ['2567', 'Nayarit'], ['2560', 'Nuevo León'],
  ['2569', 'Oaxaca'], ['2570', 'Puebla'], ['2579', 'Querétaro'], ['2582', 'Quintana Roo'], ['2561', 'San Luis Potosí'], ['2557', 'Sinaloa'], ['2558', 'Sonora'],
  ['2571', 'Tabasco'], ['2562', 'Tamaulipas'], ['2572', 'Tlaxcala'], ['2580', 'Veracruz'], ['2583', 'Yucatán'], ['2559', 'Zacatecas'],
];
// Proveedores de acceso con más usuarios en México y los sistemas autónomos (redes) con que aparecen en IODA.
// `legal` es el titular registrado de la red, tal como lo publica IODA.
export const PROVEEDORES_MX = [
  { id: 'telmex', name: 'Telmex', legal: 'Uninet', asns: [8151] },
  { id: 'telcel', name: 'Telcel', legal: 'Radiomóvil Dipsa', asns: [28403] },
  { id: 'totalplay', name: 'Totalplay', legal: 'Total Play Telecomunicaciones', asns: [22884, 17072] },
  { id: 'izzi', name: 'izzi', legal: 'Televisión Internacional, Cablevisión y Cablemás', asns: [11888, 28548, 28509] },
  { id: 'megacable', name: 'Megacable', legal: 'Mega Cable', asns: [13999] },
  { id: 'att', name: 'AT&T México', legal: 'AT&T Comunicaciones Digitales', asns: [28469] },
  { id: 'movistar', name: 'Movistar México', legal: 'Pegaso PCS', asns: [7438] },
  { id: 'axtel', name: 'Axtel', legal: 'Axtel', asns: [6503] },
  { id: 'alestra', name: 'Alestra', legal: 'Alestra', asns: [11172] },
  { id: 'altan', name: 'Altán Redes', legal: 'Altán Redes', asns: [265540] },
];

// Por estado y por proveedor las señales son más ruidosas que por país. Aquí solo cuenta una caída de 8 % o más
// que se vea en rutas BGP o en sondeo activo (el telescopio de red solo no basta), y la gravedad no pasa de «media»:
// así un corte regional se ve en México sin mover el nivel global.
function nivelMx(senales) {
  const firmes = senales.filter((s) => s.signal !== 'merit-nt');
  if (!firmes.length) return { level: 'normal', caida: 0 };
  const { caida, severity } = gravedadIoda(senales);
  return { level: severity === 'info' ? 'normal' : severity === 'low' ? 'low' : 'medium', caida };
}

async function iodaMexico() {
  const ahora = Math.floor(Date.now() / 1000);
  const consulta = (tipo) => pedir(`${IODA}/outages/alerts?from=${ahora - 86_400}&until=${ahora}&entityType=${tipo}&relatedTo=country/MX&limit=2000`, { timeout: 30_000 });
  const [regiones, redes] = await Promise.all([consulta('region'), consulta('asn')]);
  const porEstado = senalesIoda(regiones.data), porRed = senalesIoda(redes.data);
  const alertas = [];
  const alerta = (id, titulo, url, senales, nivel, etiqueta, accion, extra) => alertas.push({
    id, source: 'ioda-mexico', category: 'connectivity', severity: nivel.level, title: titulo, summary: resumenIoda(senales), url,
    published: iso(Math.min(...senales.map((s) => s.time)) * 1000), status: 'active', countries: ['MX'], tags: ['corte', 'México', etiqueta], action: accion,
    extra: { signals: senales, max_drop_pct: nivel.caida, ...extra },
  });

  const states = ESTADOS_MX.map(([code, name]) => {
    const senales = porEstado.get(code)?.senales ?? [], nivel = nivelMx(senales);
    const url = `https://ioda.inetintel.cc.gatech.edu/region/${code}`;
    if (nivel.level !== 'normal') alerta(`ioda:MX:estado:${code}`, `México · ${name}: señales de corte de Internet`, url, senales, nivel, name,
      `No depende de ti. Si tienes visitantes, clientes o equipos en ${name}, pueden tener lentitud o no poder entrar; la gráfica de la fuente muestra cuándo se recupera.`, { scope: 'state', state: name });
    return { code, name, level: nivel.level, drop_pct: nivel.level === 'normal' ? null : nivel.caida, url };
  });

  const providers = PROVEEDORES_MX.map((p) => {
    // Se toma la red más afectada del proveedor.
    const redesP = p.asns.map((asn) => { const senales = porRed.get(String(asn))?.senales ?? []; return { asn, senales, nivel: nivelMx(senales) }; });
    const peor = redesP.sort((a, b) => b.nivel.caida - a.nivel.caida)[0];
    const url = `https://ioda.inetintel.cc.gatech.edu/asn/${peor.asn}`;
    if (peor.nivel.level !== 'normal') alerta(`ioda:MX:red:${p.id}`, `México · ${p.name}: señales de corte en su red`, url, peor.senales, peor.nivel, p.name,
      `No depende de ti. Si tú o tus usuarios se conectan con ${p.name}, puede haber lentitud o cortes; confirma en los avisos del proveedor antes de reiniciar equipos.`, { scope: 'provider', provider: p.id, asn: peor.asn });
    return { id: p.id, name: p.name, legal: p.legal, asns: p.asns, level: peor.nivel.level, drop_pct: peor.nivel.level === 'normal' ? null : peor.nivel.caida, url };
  });

  return { alertas, mexico: { checked_at: new Date().toISOString(), states, providers, affected_states: states.filter((e) => e.level !== 'normal').length, affected_providers: providers.filter((e) => e.level !== 'normal').length } };
}

// Cloudflare Radar: cortes verificados por su equipo (causa, alcance, proveedor). CC BY-NC 4.0. Requiere token gratuito.
const CAUSA_RADAR = { TECHNICAL_PROBLEM: 'problema técnico', POWER_OUTAGE: 'apagón eléctrico', CABLE_CUT: 'corte de cable', GOVERNMENT_DIRECTED: 'corte ordenado por el gobierno', WEATHER: 'clima', CYBERATTACK: 'ciberataque', MILITARY_ACTION: 'acción militar', MAINTENANCE: 'mantenimiento', FIRE: 'incendio', EARTHQUAKE: 'sismo', NATURAL_DISASTER: 'desastre natural', UNKNOWN: 'causa desconocida' };
const nombrePais = new Intl.DisplayNames(['es'], { type: 'region' });
async function radar() {
  const token = process.env.CF_RADAR_TOKEN;
  if (!token) return null;
  const j = await pedir('https://api.cloudflare.com/client/v4/radar/annotations/outages?dateRange=7d&limit=100&format=json', { headers: { authorization: `Bearer ${token}` } });
  return (j.result?.annotations ?? []).map((a) => {
    const paises = a.locations ?? [];
    const lugares = paises.map((c) => { try { return nombrePais.of(c) ?? c; } catch { return c; } }).join(', ');
    const plataforma = a.outage?.outageType === 'PLATFORM';
    // Radar no siempre anota el fin. Sin fecha de fin solo se toma como en curso durante 24 horas; después queda
    // como informativa, para no dejar «activa» durante días una falla que ya pasó.
    const enCurso = !a.endDate && Date.now() - Date.parse(a.startDate) < DIA;
    // «Alta» solo para un país entero sin conexión. Lo regional, lo de un proveedor o lo de una plataforma es «media».
    const severity = !enCurso ? 'info' : paises.length && !a.scope && !plataforma ? 'high' : 'medium';
    const causa = CAUSA_RADAR[a.outage?.outageCause] ?? a.outage?.outageCause?.replace(/_/g, ' ').toLowerCase() ?? 'corte de Internet';
    return {
      id: `radar:${a.id}`,
      source: 'cloudflare-radar', category: plataforma ? 'platform' : 'connectivity', severity,
      title: `${lugares || (plataforma ? 'Falla de plataforma' : 'Corte de Internet')}: ${causa}`,
      summary: recorta([a.description, a.scope && `Scope: ${a.scope}`, (a.asnsDetails ?? []).map((x) => x.name).join(', ')].filter(Boolean).join(' · ')),
      action: enCurso ? (lugares ? `No depende de ti. Si tienes visitantes o servidores en ${lugares}, pueden tener lentitud o no poder entrar.` : 'No depende de ti. Si usas el servicio afectado, sigue el avance en su página de estado.') : 'Ya terminó: no tienes que hacer nada. Queda aquí como registro de lo que pasó.',
      url: a.linkedUrl || 'https://radar.cloudflare.com/outage-center',
      published: iso(a.startDate), updated: iso(a.endDate ?? a.startDate), status: enCurso ? 'active' : 'resolved',
      countries: paises, tags: [plataforma ? 'plataforma' : 'corte', 'verificado'], extra: { cause: a.outage?.outageCause ?? null, type: a.outage?.outageType ?? null, asns: a.asns ?? [], ended: iso(a.endDate) },
    };
  });
}

/* ------------------------------------------------------------------ Plataformas */

// Páginas de estado con API de Statuspage (v2). `stack` marca las que más pesan para sitios web y apps.
export const PLATAFORMAS = [
  { id: 'cloudflare', name: 'Cloudflare', base: 'https://www.cloudflarestatus.com', grupo: 'infraestructura' },
  { id: 'github', name: 'GitHub', base: 'https://www.githubstatus.com', grupo: 'desarrollo' },
  { id: 'npm', name: 'npm', base: 'https://status.npmjs.org', grupo: 'desarrollo' },
  { id: 'vercel', name: 'Vercel', base: 'https://www.vercel-status.com', grupo: 'infraestructura' },
  { id: 'netlify', name: 'Netlify', base: 'https://www.netlifystatus.com', grupo: 'infraestructura' },
  { id: 'digitalocean', name: 'DigitalOcean', base: 'https://status.digitalocean.com', grupo: 'infraestructura' },
  { id: 'render', name: 'Render', base: 'https://status.render.com', grupo: 'infraestructura' },
  { id: 'flyio', name: 'Fly.io', base: 'https://status.flyio.net', grupo: 'infraestructura' },
  { id: 'supabase', name: 'Supabase', base: 'https://status.supabase.com', grupo: 'datos' },
  { id: 'docker', name: 'Docker Hub', base: 'https://www.dockerstatus.com', grupo: 'desarrollo' },
  { id: 'pypi', name: 'Python / PyPI', base: 'https://status.python.org', grupo: 'desarrollo' },
  { id: 'expo', name: 'Expo', base: 'https://status.expo.dev', grupo: 'desarrollo' },
  { id: 'sentry', name: 'Sentry', base: 'https://status.sentry.io', grupo: 'desarrollo' },
  { id: 'mercadopago', name: 'Mercado Pago', base: 'https://status.mercadopago.com', grupo: 'pagos' },
  { id: 'twilio', name: 'Twilio', base: 'https://status.twilio.com', grupo: 'comunicación' },
  { id: 'resend', name: 'Resend', base: 'https://resend-status.com', grupo: 'comunicación' },
  { id: 'zoom', name: 'Zoom', base: 'https://www.zoomstatus.com', grupo: 'comunicación' },
  { id: 'godaddy', name: 'GoDaddy', base: 'https://status.godaddy.com', grupo: 'dominios' },
  { id: 'openai', name: 'OpenAI', base: 'https://status.openai.com', grupo: 'ia' },
  { id: 'claude', name: 'Claude', base: 'https://status.claude.com', grupo: 'ia' },
  { id: 'atlassian', name: 'Atlassian', base: 'https://status.atlassian.com', grupo: 'desarrollo' },
  { id: 'dropbox', name: 'Dropbox', base: 'https://status.dropbox.com', grupo: 'datos' },
];

const IMPACTO = { critical: 'critical', major: 'high', minor: 'medium', maintenance: 'info', none: 'info' };

const ACCION_PLATAFORMA = 'No depende de ti. Sigue el avance en la página de estado del proveedor y, si tus usuarios lo notan, avísales.';

async function statuspage(p) {
  // Las páginas clásicas exponen status + incidents/unresolved (ligeros). Las de nueva generación solo traen
  // summary.json, donde `incidents` ya son los abiertos.
  let st, inc;
  try {
    [st, inc] = await Promise.all([pedir(`${p.base}/api/v2/status.json`, { timeout: 15_000 }), pedir(`${p.base}/api/v2/incidents/unresolved.json`, { timeout: 15_000 })]);
  } catch (e) {
    if (!/HTTP 404/.test(String(e?.message))) throw e;
    st = inc = await pedir(`${p.base}/api/v2/summary.json`, { timeout: 15_000 });
  }
  const incidentes = (inc.incidents ?? []).map((i) => ({
    id: `status:${p.id}:${i.id}`,
    source: `status-${p.id}`, category: 'platform', severity: IMPACTO[i.impact] ?? 'medium',
    title: `${p.name}: ${i.name}`,
    summary: recorta(i.incident_updates?.[0]?.body ?? ''), action: ACCION_PLATAFORMA,
    url: i.shortlink || `${p.base}/incidents/${i.id}`,
    published: iso(i.started_at ?? i.created_at), updated: iso(i.updated_at), status: 'active',
    tags: [p.grupo, ...(i.components ?? []).slice(0, 4).map((c) => c.name)], extra: { platform: p.id, phase: i.status, impact: i.impact },
  }));
  return { plataforma: { id: p.id, name: p.name, group: p.grupo, url: p.base, indicator: st.status?.indicator ?? 'none', description: st.status?.description ?? '', incidents: incidentes.length }, incidentes: agrupa(p, incidentes) };
}

// Menos ruido: cuando una plataforma tiene tres o más incidentes menores abiertos a la vez (lo habitual en las que
// reportan cada operador o región por separado), se publican como una sola alerta que los lista. Los altos y críticos
// siempre van uno por uno.
const MIN_GRUPO = 3;
export function agrupa(p, incidentes) {
  const menores = incidentes.filter((i) => i.severity !== 'critical' && i.severity !== 'high');
  if (menores.length < MIN_GRUPO) return incidentes;
  const recientes = [...menores].sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  const sinNombre = (t) => t.replace(new RegExp(`^${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*`), '');
  const ORD = { medium: 0, low: 1, info: 2 };
  const grupo = {
    id: `status:${p.id}:varios`,
    source: `status-${p.id}`, category: 'platform',
    severity: [...menores].sort((a, b) => (ORD[a.severity] ?? 3) - (ORD[b.severity] ?? 3))[0].severity,
    title: `${p.name}: ${menores.length} incidentes menores abiertos`,
    summary: recorta(recientes.slice(0, 4).map((i) => sinNombre(i.title)).join(' · ') + (menores.length > 4 ? ` · y ${menores.length - 4} más` : ''), 480),
    action: ACCION_PLATAFORMA,
    url: p.base,
    published: recientes[0].published,
    updated: recientes.map((i) => i.updated ?? i.published).sort().at(-1),
    status: 'active',
    tags: [p.grupo],
    extra: { platform: p.id, grouped: menores.length, incidents: recientes.slice(0, 15).map((i) => ({ name: sinNombre(i.title), url: i.url, severity: i.severity, phase: i.extra?.phase ?? null, started: i.published })) },
  };
  return [...incidentes.filter((i) => i.severity === 'critical' || i.severity === 'high'), grupo];
}

// Stripe publica un JSON propio.
async function stripe() {
  const j = await pedir('https://status.stripe.com/current');
  const caidos = Object.entries(j.statuses ?? {}).filter(([, v]) => v !== 'up');
  const indicator = j.largestatus === 'up' ? 'none' : caidos.length > 2 ? 'major' : 'minor';
  const plataforma = { id: 'stripe', name: 'Stripe', group: 'pagos', url: 'https://status.stripe.com', indicator, description: j.message ?? '', incidents: caidos.length ? 1 : 0 };
  const incidentes = caidos.length ? [{
    id: `status:stripe:${caidos.map(([k]) => k).join('-')}`, source: 'status-stripe', category: 'platform', severity: IMPACTO[indicator],
    title: `Stripe: degradación en ${caidos.map(([k]) => k).join(', ')}`, summary: recorta(j.message), action: ACCION_PLATAFORMA, url: 'https://status.stripe.com',
    published: new Date().toISOString(), status: 'active', tags: ['pagos'], extra: { platform: 'stripe' },
  }] : [];
  return { plataforma, incidentes };
}

// Google Cloud: incidentes sin fecha de cierre.
async function gcp() {
  const j = await pedir('https://status.cloud.google.com/incidents.json');
  const abiertos = j.filter((i) => !i.end);
  const sev = (i) => (i.severity === 'high' ? 'high' : i.severity === 'medium' ? 'medium' : 'low');
  const incidentes = abiertos.map((i) => ({
    id: `status:gcp:${i.id}`, source: 'status-gcp', category: 'platform', severity: sev(i),
    title: `Google Cloud: ${recorta(i.external_desc, 140)}`, summary: recorta(i.most_recent_update?.text ?? i.updates?.[0]?.text ?? ''), action: ACCION_PLATAFORMA,
    url: `https://status.cloud.google.com/${i.uri ?? ''}`, published: iso(i.begin), updated: iso(i.modified), status: 'active',
    tags: ['infraestructura', ...(i.affected_products ?? []).slice(0, 4).map((x) => x.title)], extra: { platform: 'gcp' },
  }));
  const peor = incidentes.some((i) => i.severity === 'high') ? 'major' : incidentes.length ? 'minor' : 'none';
  return { plataforma: { id: 'gcp', name: 'Google Cloud', group: 'infraestructura', url: 'https://status.cloud.google.com', indicator: peor, description: incidentes.length ? `${incidentes.length} incidente(s) abierto(s)` : 'Sin incidentes abiertos', incidents: incidentes.length }, incidentes };
}

// AWS: el RSS mezcla avisos abiertos y cierres; se toman las últimas 24 h y se descartan los que ya anuncian resolución.
async function aws() {
  const xml = await pedir('https://status.aws.amazon.com/rss/all.rss', { tipo: 'texto' });
  const corte = desdeHace(1);
  const recientes = leerFeed(xml).filter((e) => Date.parse(e.fecha) >= corte);
  const cerrado = (e) => /\[RESOLVED\]|operating normally|has been resolved|recovered/i.test(`${e.titulo} ${e.resumen}`);
  const porServicio = new Map();
  for (const e of recientes) { const k = e.id.split('_').slice(0, -1).join('_') || e.id; if (!porServicio.has(k)) porServicio.set(k, e); }
  const abiertos = [...porServicio.values()].filter((e) => !cerrado(e));
  const incidentes = abiertos.map((e) => ({
    id: `status:aws:${e.id.split('#').pop()}`, source: 'status-aws', category: 'platform', severity: /disruption|outage/i.test(e.titulo) ? 'high' : 'medium',
    title: `AWS: ${recorta(e.titulo, 160)}`, summary: recorta(e.resumen), action: ACCION_PLATAFORMA, url: 'https://health.aws.amazon.com/health/status', published: iso(e.fecha), status: 'active', tags: ['infraestructura'], extra: { platform: 'aws' },
  }));
  const peor = incidentes.some((i) => i.severity === 'high') ? 'major' : incidentes.length ? 'minor' : 'none';
  return { plataforma: { id: 'aws', name: 'AWS', group: 'infraestructura', url: 'https://health.aws.amazon.com/health/status', indicator: peor, description: incidentes.length ? `${incidentes.length} aviso(s) abierto(s) en 24 h` : 'Sin avisos abiertos', incidents: incidentes.length }, incidentes };
}

/* ------------------------------------------------------------------ Contexto */

// SANS Internet Storm Center: semáforo global de amenaza (verde/amarillo/naranja/rojo). CC BY-NC-SA.
async function infocon() {
  const j = await pedir('https://isc.sans.edu/api/infocon?json');
  return j.status ?? null;
}

// EPSS (FIRST.org): probabilidad de explotación en 30 días. Se usa para ordenar, no para alarmar.
export async function epss(cves) {
  const mapa = new Map();
  for (let i = 0; i < cves.length; i += 80) {
    const j = await pedir(`https://api.first.org/data/v1/epss?cve=${cves.slice(i, i + 80).join(',')}`);
    for (const d of j.data ?? []) mapa.set(d.cve, { score: Number(d.epss), percentile: Number(d.percentile) });
  }
  return mapa;
}

/* ------------------------------------------------------------------ Alcance: qué tan usado es lo afectado */

// Una falla crítica en un paquete que casi nadie instala no pesa igual que una en uno que usa medio Internet.
// `reach` lo dice con un dato público: el lugar del paquete entre todos los de su gestor según sus descargas
// (ecosyste.ms, CC BY-SA 4.0). «wide» = está en el 0.5 % más descargado; «niche» = fuera del 5 % más descargado.
// Entre uno y otro no se pone etiqueta. Si no hay dato, tampoco: no se adivina.
const REGISTRO = { npm: 'npmjs.org', pip: 'pypi.org', rubygems: 'rubygems.org', go: 'proxy.golang.org', nuget: 'nuget.org', composer: 'packagist.org', rust: 'crates.io', maven: 'repo1.maven.org', erlang: 'hex.pm', pub: 'pub.dev', swift: 'swiftpackageindex.com', actions: 'github actions' };
export const ALCANCE_AMPLIO = 0.5, ALCANCE_NICHO = 5;
const SEMANA = 7 * DIA;
/** Lugar del paquete en su gestor, en porcentaje (0.1 = entre el 0.1 % más descargado). null si no hay dato. */
async function lugarPaquete(eco, nombre) {
  const registro = REGISTRO[String(eco).toLowerCase()];
  if (!registro) return null;
  // Maven se escribe grupo:artefacto en ambos lados; los demás, tal cual.
  const j = await pedir(`https://packages.ecosyste.ms/api/v1/registries/${encodeURIComponent(registro)}/packages/${encodeURIComponent(nombre)}`, { timeout: 12_000 });
  const r = j.rankings ?? {};
  const pct = r.downloads ?? r.dependent_repos_count ?? null;
  return typeof pct === 'number' ? Math.round(pct * 1000) / 1000 : null;
}
const nivelAlcance = (pct) => (pct == null ? null : pct <= ALCANCE_AMPLIO ? 'wide' : pct > ALCANCE_NICHO ? 'niche' : 'mid');

// Fallas en ataque (CISA): no hay descargas que contar. Se marca «wide» solo lo que está en esta lista corta y pública
// de productos que usa casi cualquier sitio, equipo de oficina o teléfono. Lo demás (equipos de red de empresa,
// programas especializados) va sin etiqueta.
const USO_COMUN = /\b(wordpress|woocommerce|php|apache|nginx|node\.?js|openssl|openssh|linux|windows|chrome|chromium|firefox|safari|webkit|android|ios|ipados|macos|microsoft office|outlook|exchange|joomla|drupal|laravel|magento|cpanel|plesk|mysql|mariadb|postgresql|redis|mongodb|docker|kubernetes|git|gitlab|jenkins|roundcube|exim|postfix|react|next\.js|vite|jquery|log4j|spring|django|rails|express|tomcat|grafana|zimbra|whatsapp|zoom|7-zip|winrar)\b/i;
const esUsoComun = (a) => USO_COMUN.test([...(a.tags ?? []).filter((t) => t !== 'explotada' && !/^CVE-/.test(t))].join(' ')) || /^(Apple|Google|Microsoft|Mozilla)\b/i.test(a.tags?.[1] ?? '') && /multiple|varios/i.test(a.tags?.[2] ?? '');

/**
 * Pone `extra.reach` en cada alerta que se pueda medir. `cache` guarda el lugar de cada paquete una semana
 * (cambia muy despacio) para no preguntar lo mismo en cada lectura. Devuelve cuántos paquetes quedaron con dato.
 */
export async function alcance(alertas, cache = {}) {
  const ahora = Date.now();
  const clave = (p) => `${String(p.ecosystem).toLowerCase()}:${p.name}`;
  const faltan = new Map();
  for (const a of alertas) if (a.source === 'github-advisories' && !a.stale) for (const p of a.extra?.packages ?? []) {
    const c = cache[clave(p)];
    if (!c || ahora - c.t > SEMANA) faltan.set(clave(p), p);
  }
  let errores = 0;
  // De cinco en cinco y con tope por lectura: lo que falte se completa en la siguiente.
  const lista = [...faltan].slice(0, 40);
  for (let i = 0; i < lista.length; i += 5) await Promise.all(lista.slice(i, i + 5).map(async ([k, p]) => {
    try { cache[k] = { pct: await lugarPaquete(p.ecosystem, p.name), t: ahora }; }
    catch (e) { if (/HTTP 404/.test(String(e?.message))) cache[k] = { pct: null, t: ahora }; else errores++; }
  }));
  const vivos = new Set();
  for (const a of alertas) {
    if (a.source === 'cisa-kev') { if (esUsoComun(a)) a.extra.reach = { level: 'wide', basis: 'lista' }; else delete a.extra.reach; continue; }
    if (a.source !== 'github-advisories') continue;
    // Si el aviso toca varios paquetes, cuenta el más usado.
    const pcts = (a.extra?.packages ?? []).map((p) => { vivos.add(clave(p)); return cache[clave(p)]?.pct; }).filter((x) => typeof x === 'number');
    if (a.stale) continue;
    const mejor = pcts.length ? Math.min(...pcts) : null, nivel = nivelAlcance(mejor);
    if (nivel) a.extra.reach = { level: nivel, top_pct: mejor, basis: 'descargas' }; else delete a.extra.reach;
  }
  for (const k of Object.keys(cache)) if (!vivos.has(k)) delete cache[k];
  if (errores && errores === lista.length) throw new Error(`sin respuesta para ${errores} paquetes`);
  return Object.values(cache).filter((c) => c.pct != null).length;
}

export const FUENTES = [
  { id: 'cisa-kev', name: 'CISA Known Exploited Vulnerabilities', url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog', license: 'Dominio público (EE. UU.)', kind: 'alerts', run: kev },
  { id: 'github-advisories', name: 'GitHub Advisory Database', url: 'https://github.com/advisories', license: 'CC BY 4.0', kind: 'alerts', run: ghsa },
  { id: 'nodejs-security', name: 'Node.js Security Releases', url: 'https://nodejs.org/en/blog/vulnerability', license: 'MIT', kind: 'alerts', run: nodejs },
  { id: 'cert-cc', name: 'CERT/CC Vulnerability Notes', url: 'https://www.kb.cert.org/vuls/', license: 'Uso con atribución (CMU SEI)', kind: 'alerts', run: certcc },
  { id: 'ioda', name: 'IODA · Internet Outage Detection and Analysis', url: 'https://ioda.inetintel.cc.gatech.edu', license: 'Uso académico y no comercial con atribución (Georgia Tech)', kind: 'alerts', run: ioda },
  { id: 'ioda-mexico', name: 'IODA · México por estado y por proveedor', url: 'https://ioda.inetintel.cc.gatech.edu/country/MX', license: 'Uso académico y no comercial con atribución (Georgia Tech)', kind: 'mexico', run: iodaMexico },
  { id: 'cloudflare-radar', name: 'Cloudflare Radar · Outage Center', url: 'https://radar.cloudflare.com/outage-center', license: 'CC BY-NC 4.0', kind: 'alerts', run: radar, optional: true },
  ...PLATAFORMAS.map((p) => ({ id: `status-${p.id}`, name: `${p.name} Status`, url: p.base, license: 'Página de estado pública', kind: 'platform', run: () => statuspage(p) })),
  { id: 'status-stripe', name: 'Stripe Status', url: 'https://status.stripe.com', license: 'Página de estado pública', kind: 'platform', run: stripe },
  { id: 'status-gcp', name: 'Google Cloud Status', url: 'https://status.cloud.google.com', license: 'Página de estado pública', kind: 'platform', run: gcp },
  { id: 'status-aws', name: 'AWS Health', url: 'https://health.aws.amazon.com/health/status', license: 'Página de estado pública', kind: 'platform', run: aws },
  { id: 'sans-infocon', name: 'SANS ISC Infocon', url: 'https://isc.sans.edu/infocon.html', license: 'CC BY-NC-SA 3.0 US', kind: 'context', run: infocon },
  { id: 'first-epss', name: 'FIRST EPSS', url: 'https://www.first.org/epss/', license: 'Uso libre con atribución (FIRST.org)', kind: 'enrichment', run: null },
  { id: 'ecosystems', name: 'ecosyste.ms · uso de cada paquete', url: 'https://packages.ecosyste.ms', license: 'CC BY-SA 4.0', kind: 'enrichment', run: null },
];
