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
const recorta = (s, n = 320) => { const t = String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
const desdeHace = (dias) => Date.now() - dias * DIA;

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
async function kev() {
  const j = await pedir('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', { timeout: 40_000 });
  const corte = desdeHace(30);
  return j.vulnerabilities.filter((v) => Date.parse(v.dateAdded) >= corte).map((v) => ({
    id: `kev:${v.cveID}`,
    source: 'cisa-kev',
    category: 'vulnerability',
    severity: v.knownRansomwareCampaignUse === 'Known' ? 'critical' : 'high',
    // El nombre que da CISA ya suele empezar con fabricante y producto; no se repiten.
    title: String(v.vulnerabilityName ?? '').toLowerCase().startsWith(String(v.vendorProject ?? '').toLowerCase()) ? v.vulnerabilityName : `${v.vendorProject} ${v.product}: ${v.vulnerabilityName}`,
    summary: recorta(v.shortDescription),
    url: `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=${v.cveID}`,
    published: iso(v.dateAdded),
    status: 'active',
    tags: ['explotada', v.vendorProject, v.product].filter(Boolean),
    extra: { cve: v.cveID, ransomware: v.knownRansomwareCampaignUse === 'Known', due: v.dueDate, action: recorta(v.requiredAction, 240), cwes: v.cwes ?? [] },
  }));
}

// GitHub Advisory Database (revisadas): fallas en paquetes de npm, PyPI, Composer, Go, etc. Licencia CC BY 4.0.
async function ghsa() {
  const headers = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'x-github-api-version': '2022-11-28' } : {};
  const desde = new Date(desdeHace(7)).toISOString().slice(0, 10);
  const pag = (sev) => pedir(`https://api.github.com/advisories?type=reviewed&severity=${sev}&published=%3E%3D${desde}&per_page=100&sort=published&direction=desc`, { headers });
  const [crit, altas] = await Promise.all([pag('critical'), pag('high')]);
  const corteAltas = desdeHace(3);
  return [...crit, ...altas.filter((a) => Date.parse(a.published_at) >= corteAltas)].filter((a) => !a.withdrawn_at).map((a) => {
    const paquetes = [...new Map((a.vulnerabilities ?? []).map((v) => [`${v.package?.ecosystem}:${v.package?.name}`, v])).values()];
    return {
      id: `ghsa:${a.ghsa_id}`,
      source: 'github-advisories',
      category: 'vulnerability',
      severity: a.severity === 'critical' ? 'critical' : 'high',
      title: a.summary,
      summary: paquetes.slice(0, 4).map((v) => `${v.package.name} (${v.package.ecosystem}) ${v.vulnerable_version_range ?? ''}${v.first_patched_version ? ` → corregido en ${v.first_patched_version}` : ' → sin parche'}`).join(' · '),
      url: a.html_url,
      published: iso(a.published_at),
      updated: iso(a.updated_at),
      status: 'active',
      tags: [...new Set(paquetes.map((v) => v.package?.ecosystem).filter(Boolean))],
      extra: { cve: a.cve_id ?? null, ghsa: a.ghsa_id, cvss: a.cvss?.score ?? null, packages: paquetes.slice(0, 8).map((v) => ({ ecosystem: v.package.ecosystem, name: v.package.name, range: v.vulnerable_version_range, patched: v.first_patched_version ?? null })) },
    };
  });
}

// Avisos de seguridad de Node.js (releases de seguridad del runtime). Licencia MIT del sitio nodejs.org.
async function nodejs() {
  const xml = await pedir('https://nodejs.org/en/feed/vulnerability.xml', { tipo: 'texto' });
  const corte = desdeHace(21);
  return leerFeed(xml).filter((e) => Date.parse(e.fecha) >= corte).map((e) => ({
    id: `nodejs:${e.url.split('/').filter(Boolean).pop()}`,
    source: 'nodejs-security', category: 'advisory', severity: 'medium',
    title: `Node.js: ${e.titulo}`, summary: recorta(e.resumen), url: e.url, published: iso(e.fecha), status: 'active', tags: ['nodejs'], extra: {},
  }));
}

// CERT/CC (Carnegie Mellon): notas de vulnerabilidad coordinadas, suelen cubrir fallas de protocolo y de cadena de suministro.
async function certcc() {
  const xml = await pedir('https://www.kb.cert.org/vuls/atomfeed/', { tipo: 'texto' });
  const corte = desdeHace(21);
  return leerFeed(xml).filter((e) => Date.parse(e.fecha) >= corte).map((e) => ({
    id: `certcc:${(e.url.match(/id\/(\d+)/) ?? [])[1] ?? e.id}`,
    source: 'cert-cc', category: 'advisory', severity: 'medium',
    title: e.titulo, summary: recorta(e.resumen), url: e.url, published: iso(e.fecha), status: 'active', tags: ['coordinada'], extra: {},
  }));
}

/* ------------------------------------------------------------------ Conectividad por país */

// IODA (Georgia Tech): detección de cortes de Internet por país a partir de BGP, sondeo activo y telescopio de red.
async function ioda() {
  const ahora = Math.floor(Date.now() / 1000);
  const j = await pedir(`https://api.ioda.inetintel.cc.gatech.edu/v2/outages/alerts?from=${ahora - 86_400}&until=${ahora}&entityType=country&limit=2000`, { timeout: 30_000 });
  // La última alerta de cada (país, señal) dice el estado vigente: si no es «normal», la señal sigue caída.
  const ultimo = new Map();
  for (const a of j.data ?? []) {
    const k = `${a.entity.code}|${a.datasource}`;
    if (!ultimo.has(k) || ultimo.get(k).time < a.time) ultimo.set(k, a);
  }
  const porPais = new Map();
  for (const a of ultimo.values()) {
    if (a.level === 'normal') continue;
    const p = porPais.get(a.entity.code) ?? { nombre: a.entity.name, senales: [] };
    p.senales.push({ signal: a.datasource, level: a.level, time: a.time, drop: a.historyValue ? Math.round((1 - a.value / a.historyValue) * 100) : null });
    porPais.set(a.entity.code, p);
  }
  const NOMBRE = { bgp: 'rutas BGP', 'ping-slash24': 'sondeo activo', 'merit-nt': 'telescopio de red', gtr: 'tráfico de Google' };
  return [...porPais].map(([code, p]) => {
    const caida = Math.max(0, ...p.senales.map((s) => s.drop ?? 0));
    const criticas = p.senales.filter((s) => s.level === 'critical').length;
    // Una sola señal con caída pequeña es ruido frecuente; se publica como informativa y no mueve el nivel global.
    const severity = criticas >= 2 && caida >= 25 ? 'high' : criticas >= 2 || caida >= 25 ? 'medium' : caida >= 8 ? 'low' : 'info';
    const desde = Math.min(...p.senales.map((s) => s.time));
    return {
      id: `ioda:${code}`,
      source: 'ioda', category: 'connectivity', severity,
      title: `${p.nombre}: señales de corte de Internet`,
      summary: p.senales.map((s) => `${NOMBRE[s.signal] ?? s.signal}${s.drop != null ? ` −${s.drop}%` : ''}`).join(' · '),
      url: `https://ioda.inetintel.cc.gatech.edu/country/${code}`,
      published: iso(desde * 1000), status: 'active', countries: [code], tags: ['corte'],
      extra: { signals: p.senales, max_drop_pct: caida },
    };
  });
}

// Cloudflare Radar: cortes verificados por su equipo (causa, alcance, proveedor). CC BY-NC 4.0. Requiere token gratuito.
async function radar() {
  const token = process.env.CF_RADAR_TOKEN;
  if (!token) return null;
  const j = await pedir('https://api.cloudflare.com/client/v4/radar/annotations/outages?dateRange=7d&limit=100&format=json', { headers: { authorization: `Bearer ${token}` } });
  return (j.result?.annotations ?? []).map((a) => ({
    id: `radar:${a.id}`,
    source: 'cloudflare-radar', category: 'connectivity',
    severity: a.endDate ? 'info' : a.scope ? 'medium' : 'high',
    title: `${(a.locationsDetails ?? []).map((l) => l.name).join(', ') || 'Corte'}: ${a.outage?.outageCause?.replace(/_/g, ' ').toLowerCase() ?? 'corte de Internet'}`,
    summary: recorta([a.description, a.scope && `Alcance: ${a.scope}`, (a.asnsDetails ?? []).map((x) => x.name).join(', ')].filter(Boolean).join(' · ')),
    url: a.linkedUrl || 'https://radar.cloudflare.com/outage-center',
    published: iso(a.startDate), updated: iso(a.endDate ?? a.startDate), status: a.endDate ? 'resolved' : 'active',
    countries: a.locations ?? [], tags: ['corte', 'verificado'], extra: { cause: a.outage?.outageCause ?? null, type: a.outage?.outageType ?? null, asns: a.asns ?? [] },
  }));
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
    summary: recorta(i.incident_updates?.[0]?.body ?? ''),
    url: i.shortlink || `${p.base}/incidents/${i.id}`,
    published: iso(i.started_at ?? i.created_at), updated: iso(i.updated_at), status: 'active',
    tags: [p.grupo, ...(i.components ?? []).slice(0, 4).map((c) => c.name)], extra: { platform: p.id, phase: i.status, impact: i.impact },
  }));
  return { plataforma: { id: p.id, name: p.name, group: p.grupo, url: p.base, indicator: st.status?.indicator ?? 'none', description: st.status?.description ?? '', incidents: incidentes.length }, incidentes };
}

// Stripe publica un JSON propio.
async function stripe() {
  const j = await pedir('https://status.stripe.com/current');
  const caidos = Object.entries(j.statuses ?? {}).filter(([, v]) => v !== 'up');
  const indicator = j.largestatus === 'up' ? 'none' : caidos.length > 2 ? 'major' : 'minor';
  const plataforma = { id: 'stripe', name: 'Stripe', group: 'pagos', url: 'https://status.stripe.com', indicator, description: j.message ?? '', incidents: caidos.length ? 1 : 0 };
  const incidentes = caidos.length ? [{
    id: `status:stripe:${caidos.map(([k]) => k).join('-')}`, source: 'status-stripe', category: 'platform', severity: IMPACTO[indicator],
    title: `Stripe: degradación en ${caidos.map(([k]) => k).join(', ')}`, summary: recorta(j.message), url: 'https://status.stripe.com',
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
    title: `Google Cloud: ${recorta(i.external_desc, 140)}`, summary: recorta(i.most_recent_update?.text ?? i.updates?.[0]?.text ?? ''),
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
    title: `AWS: ${recorta(e.titulo, 160)}`, summary: recorta(e.resumen), url: 'https://health.aws.amazon.com/health/status', published: iso(e.fecha), status: 'active', tags: ['infraestructura'], extra: { platform: 'aws' },
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

export const FUENTES = [
  { id: 'cisa-kev', name: 'CISA Known Exploited Vulnerabilities', url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog', license: 'Dominio público (EE. UU.)', kind: 'alerts', run: kev },
  { id: 'github-advisories', name: 'GitHub Advisory Database', url: 'https://github.com/advisories', license: 'CC BY 4.0', kind: 'alerts', run: ghsa },
  { id: 'nodejs-security', name: 'Node.js Security Releases', url: 'https://nodejs.org/en/blog/vulnerability', license: 'MIT', kind: 'alerts', run: nodejs },
  { id: 'cert-cc', name: 'CERT/CC Vulnerability Notes', url: 'https://www.kb.cert.org/vuls/', license: 'Uso con atribución (CMU SEI)', kind: 'alerts', run: certcc },
  { id: 'ioda', name: 'IODA · Internet Outage Detection and Analysis', url: 'https://ioda.inetintel.cc.gatech.edu', license: 'Uso académico y no comercial con atribución (Georgia Tech)', kind: 'alerts', run: ioda },
  { id: 'cloudflare-radar', name: 'Cloudflare Radar · Outage Center', url: 'https://radar.cloudflare.com/outage-center', license: 'CC BY-NC 4.0', kind: 'alerts', run: radar, optional: true },
  ...PLATAFORMAS.map((p) => ({ id: `status-${p.id}`, name: `${p.name} Status`, url: p.base, license: 'Página de estado pública', kind: 'platform', run: () => statuspage(p) })),
  { id: 'status-stripe', name: 'Stripe Status', url: 'https://status.stripe.com', license: 'Página de estado pública', kind: 'platform', run: stripe },
  { id: 'status-gcp', name: 'Google Cloud Status', url: 'https://status.cloud.google.com', license: 'Página de estado pública', kind: 'platform', run: gcp },
  { id: 'status-aws', name: 'AWS Health', url: 'https://health.aws.amazon.com/health/status', license: 'Página de estado pública', kind: 'platform', run: aws },
  { id: 'sans-infocon', name: 'SANS ISC Infocon', url: 'https://isc.sans.edu/infocon.html', license: 'CC BY-NC-SA 3.0 US', kind: 'context', run: infocon },
  { id: 'first-epss', name: 'FIRST EPSS', url: 'https://www.first.org/epss/', license: 'Uso libre con atribución (FIRST.org)', kind: 'enrichment', run: null },
];
