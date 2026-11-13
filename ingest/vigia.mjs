#!/usr/bin/env node
// Vigía privado: revisa TUS dominios desde fuera y dice qué atender. No publica nada.
//
//   node ingest/vigia.mjs            → lee dominios.txt (un dominio por línea), escribe vigia/reporte.md y .json
//
// Qué revisa por dominio: que responda por HTTPS, días para que venza el certificado y el dominio,
// cabeceras de seguridad, SPF y DMARC (suplantación de correo), CAA y security.txt.
// Solo hace peticiones normales de lectura a tus propios sitios y a DNS/RDAP públicos.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { Resolver } from 'node:dns/promises';
import tls from 'node:tls';

const RAIZ = new URL('../', import.meta.url);
const dns = new Resolver({ timeout: 5000, tries: 2 });
dns.setServers(['1.1.1.1', '8.8.8.8']);
const DIA = 86_400_000;
const dias = (f) => Math.floor((new Date(f).getTime() - Date.now()) / DIA);
const intenta = async (fn) => { try { return await fn(); } catch (e) { return { error: e?.code ?? e?.message ?? String(e) }; } };

function certificado(host) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: 10_000 }, () => {
      const c = s.getPeerCertificate();
      resolve({ valido: s.authorized, vence: c.valid_to ? new Date(c.valid_to).toISOString() : null, emisor: c.issuer?.O ?? c.issuer?.CN ?? null, error: s.authorized ? null : String(s.authorizationError) });
      s.end();
    });
    s.on('error', (e) => resolve({ error: e.code ?? e.message }));
    s.on('timeout', () => { s.destroy(); resolve({ error: 'timeout' }); });
  });
}

async function rdap(dominio) {
  const r = await fetch(`https://rdap.org/domain/${dominio}`, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/rdap+json', 'user-agent': 'NetworkAlert-Vigia/1.0 (revision propia; +https://networkalert.dev)' } });
  if (!r.ok) return { error: `RDAP ${r.status}` };
  const j = await r.json();
  const ev = (n) => j.events?.find((e) => e.eventAction === n)?.eventDate ?? null;
  return { vence: ev('expiration'), registrador: j.entities?.find((e) => e.roles?.includes('registrar'))?.vcardArray?.[1]?.find((v) => v[0] === 'fn')?.[3] ?? null, bloqueado: (j.status ?? []).some((s) => /transfer prohibited/i.test(s)), dnssec: j.secureDNS?.delegationSigned ?? null };
}

async function web(dominio) {
  const r = await fetch(`https://${dominio}/`, { redirect: 'follow', signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'NetworkAlert-Vigia/1.0 (revisión propia)' } });
  const h = r.headers;
  return { status: r.status, final: r.url, servidor: h.get('server'), hsts: h.get('strict-transport-security'), csp: !!h.get('content-security-policy'), nosniff: h.get('x-content-type-options') === 'nosniff', marco: !!h.get('x-frame-options') || /frame-ancestors/.test(h.get('content-security-policy') ?? ''), referrer: !!h.get('referrer-policy') };
}

async function revisar(dominio) {
  const [w, c, r, txt, dmarc, mx, caa, sec] = await Promise.all([
    intenta(() => web(dominio)), certificado(dominio), intenta(() => rdap(dominio)),
    intenta(() => dns.resolveTxt(dominio)), intenta(() => dns.resolveTxt(`_dmarc.${dominio}`)), intenta(() => dns.resolveMx(dominio)), intenta(() => dns.resolveCaa(dominio)),
    intenta(async () => { const x = await fetch(`https://${dominio}/.well-known/security.txt`, { signal: AbortSignal.timeout(8000) }); return x.ok && /contact:/i.test(await x.text()); }),
  ]);
  const spf = Array.isArray(txt) ? txt.map((t) => t.join('')).find((t) => /^v=spf1/i.test(t)) ?? null : null;
  const dm = Array.isArray(dmarc) ? dmarc.map((t) => t.join('')).find((t) => /^v=DMARC1/i.test(t)) ?? null : null;
  const politica = dm?.match(/\bp=(\w+)/i)?.[1]?.toLowerCase() ?? null;
  const tieneCorreo = Array.isArray(mx) && mx.some((m) => m.exchange && m.exchange !== '.');

  // Hallazgos: [nivel, texto]. urgente = puede tumbar o comprometer pronto; atender = cerrar en días; mejora = cuando haya tiempo.
  const h = [];
  if (w.error) h.push(['urgente', `No responde por HTTPS (${w.error}).`]);
  else if (w.status >= 500) h.push(['urgente', `Responde con error ${w.status}.`]);
  else if (w.status >= 400) h.push(['atender', `La portada responde ${w.status}.`]);
  if (c.error && !w.error) h.push(['urgente', `Certificado TLS con problema: ${c.error}.`]);
  else if (c.vence) { const d = dias(c.vence); if (d < 7) h.push(['urgente', `El certificado vence en ${d} días.`]); else if (d < 21) h.push(['atender', `El certificado vence en ${d} días; confirma que la renovación automática funcione.`]); }
  if (r.vence) { const d = dias(r.vence); if (d < 30) h.push(['urgente', `El dominio vence en ${d} días.`]); else if (d < 75) h.push(['atender', `El dominio vence en ${d} días; confirma renovación automática y tarjeta vigente.`]); }
  if (r.bloqueado === false) h.push(['atender', 'Sin bloqueo de transferencia en el registrador (registrar lock).']);
  if (!dm) h.push(['atender', 'Sin DMARC: cualquiera puede enviar correo que parece venir de este dominio.']);
  else if (politica === 'none') h.push(['mejora', 'DMARC en p=none: observa pero no bloquea la suplantación. Sube a quarantine cuando los reportes salgan limpios.']);
  if (!spf) h.push([tieneCorreo ? 'atender' : 'mejora', tieneCorreo ? 'Sin SPF aunque el dominio recibe correo.' : 'Sin SPF. Si no envía correo, publica «v=spf1 -all».']);
  else if (/\+all/.test(spf)) h.push(['urgente', 'SPF con +all: autoriza a todo Internet a enviar a tu nombre.']);
  if (!w.error) {
    if (!w.hsts) h.push(['mejora', 'Sin Strict-Transport-Security (forzar HTTPS).']);
    if (!w.csp) h.push(['mejora', 'Sin Content-Security-Policy.']);
    if (!w.nosniff) h.push(['mejora', 'Sin X-Content-Type-Options: nosniff.']);
    if (!w.marco) h.push(['mejora', 'Puede incrustarse en otros sitios (falta X-Frame-Options o frame-ancestors).']);
  }
  if (r.dnssec === false) h.push(['mejora', 'DNSSEC no activado.']);
  if (Array.isArray(caa) && caa.length === 0 || caa?.error === 'ENODATA') h.push(['mejora', 'Sin registros CAA (limitar qué autoridades emiten certificados).']);
  if (r.error) h.push(['mejora', `No se pudo consultar el vencimiento del dominio (${r.error}); revísalo en tu registrador.`]);
  if (sec !== true) h.push(['mejora', 'Sin /.well-known/security.txt.']);
  return { dominio, web: w, certificado: c, registro: r, correo: { mx: tieneCorreo, spf, dmarc: dm, politica }, hallazgos: h };
}

const lista = (await readFile(new URL('dominios.txt', RAIZ), 'utf8')).split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#'));
const resultados = [];
for (let i = 0; i < lista.length; i += 6) resultados.push(...(await Promise.all(lista.slice(i, i + 6).map(revisar))));

const N = { urgente: 0, atender: 1, mejora: 2 };
const peor = (r) => Math.min(3, ...r.hallazgos.map(([n]) => N[n]));
resultados.sort((a, b) => peor(a) - peor(b) || a.dominio.localeCompare(b.dominio));
const cuenta = (n) => resultados.reduce((s, r) => s + r.hallazgos.filter(([x]) => x === n).length, 0);
const f = (d) => (d == null ? '–' : `${d} d`);

let md = `# Vigía · ${new Date().toLocaleString('es-MX', { dateStyle: 'long', timeStyle: 'short' })}\n\n${resultados.length} dominios · ${cuenta('urgente')} urgentes · ${cuenta('atender')} por atender · ${cuenta('mejora')} mejoras\n\n`;
md += `| Dominio | HTTP | Cert. vence | Dominio vence | DMARC | Urgente | Atender |\n|---|---|---|---|---|---|---|\n`;
for (const r of resultados) md += `| ${r.dominio} | ${r.web.status ?? r.web.error} | ${f(r.certificado.vence && dias(r.certificado.vence))} | ${f(r.registro.vence && dias(r.registro.vence))} | ${r.correo.politica ?? 'no'} | ${r.hallazgos.filter(([n]) => n === 'urgente').length} | ${r.hallazgos.filter(([n]) => n === 'atender').length} |\n`;
for (const r of resultados) { if (!r.hallazgos.length) continue; md += `\n## ${r.dominio}\n`; for (const [n, t] of [...r.hallazgos].sort((a, b) => N[a[0]] - N[b[0]])) md += `- **${n}** · ${t}\n`; }

await mkdir(new URL('vigia/', RAIZ), { recursive: true });
await writeFile(new URL('vigia/reporte.md', RAIZ), md);
await writeFile(new URL('vigia/reporte.json', RAIZ), JSON.stringify({ generado: new Date().toISOString(), resultados }, null, 1));
console.log(md);
