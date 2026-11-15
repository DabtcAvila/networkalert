#!/usr/bin/env node
// Prueba de «Revisa tu dominio» contra una lista fija de dominios cuyo estado se conoce.
// Se corre antes de publicar cualquier cambio del revisor: primero contra el preview y, ya publicado, contra producción.
//
//   npm run prueba:revisor                      → preview
//   npm run prueba:revisor -- https://networkalert.dev
//
// Cada caso dice lo que el revisor DEBE decir (`es`), lo que NO puede decir (`no`), los temas de los que no debe
// opinar porque no pudo leerlos (`sin`) y de qué dominio sale la regla DMARC (`de`).
// Ojo: el revisor guarda cada resultado 10 minutos. Después de publicar un cambio, espera ese tiempo o la prueba leerá
// respuestas viejas (se nota en `checked_at`).
// Los casos nacen de errores reales: al encontrar uno nuevo, se agrega aquí antes de corregirlo.

const BASE = (process.argv[2] ?? process.env.NA_ORIGEN ?? 'https://networkalert-preview.davidfernando.workers.dev').replace(/\/$/, '');

const CASOS = [
  // Sitio sano y completo.
  { d: 'cloudflare.com', es: { web: 'ok', cert: 'ok', http: 'ok', dmarc: 'ok', spf: 'ok', dnssec: 'ok' }, de: 'cloudflare.com' },
  { d: 'github.com', es: { web: 'ok', cert: 'ok', http: 'ok', www: 'ok', dmarc: 'ok', spf: 'ok', dnssec: 'improve' }, de: 'github.com' },
  { d: 'networkalert.dev', es: { web: 'ok', cert: 'ok', dmarc: 'ok', spf: 'ok', security_txt: 'ok' }, de: 'networkalert.dev' },
  // Sirve la página sin candado y no redirige: el aviso de http es cierto.
  { d: 'example.com', es: { web: 'ok', http: 'fix', dmarc: 'ok', spf: 'ok', dnssec: 'ok' }, de: 'example.com' },
  // Subdominio sin regla DMARC propia: vale la del dominio de arriba (error del 14 de noviembre de 2026).
  // Además manda a la versión segura en el segundo salto, no en el primero: cuenta la cadena completa.
  { d: 'mail.google.com', es: { dmarc: 'ok' }, no: { web: ['urgent', 'fix'], http: ['fix'] }, de: 'google.com' },
  { d: 'servicios.itam.mx', no: { dmarc: ['fix', 'urgent'] }, de: 'itam.mx' },
  // De verdad no tiene DMARC ni SPF.
  { d: 'badssl.com', es: { web: 'ok', dmarc: 'fix' }, de: null },
  // Sitio sano que suele bloquear las lecturas automáticas: no se puede acusar de falla.
  // (Su aviso de http sí es cierto: http://google.com termina en http://www.google.com, sin candado.)
  { d: 'google.com', es: { dmarc: 'ok', spf: 'ok' }, no: { web: ['urgent', 'fix'], www: ['improve'] }, de: 'google.com' },
  // Candado vencido, autofirmado o de otro dominio: urgente, y sin opinar de lo que no se pudo leer.
  { d: 'expired.badssl.com', es: { web: 'urgent', cert: 'urgent' }, sin: ['headers', 'security_txt', 'www', 'http'], titulo: { web: /candado/i } },
  { d: 'self-signed.badssl.com', es: { web: 'urgent' }, sin: ['headers', 'security_txt', 'www', 'http'], titulo: { web: /candado/i } },
  { d: 'wrong.host.badssl.com', es: { web: 'urgent' }, sin: ['headers', 'security_txt', 'www', 'http'], titulo: { web: /candado/i } },
  // No tiene https.
  { d: 'neverssl.com', es: { web: 'urgent' }, sin: ['headers', 'security_txt', 'www', 'http', 'cert'], titulo: { web: /no abre/i } },
  // No existe.
  { d: 'no-existe-networkalert-prueba.com', estado: 404 },
];

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function pide(d) {
  for (let intento = 0; intento < 4; intento++) {
    const r = await fetch(`${BASE}/api/v1/check?domain=${d}`, { signal: AbortSignal.timeout(90_000) });
    if (r.status !== 429) return { estado: r.status, cuerpo: await r.json().catch(() => null) };
    process.stdout.write('   (límite de revisiones por minuto: espero 61 s)\n');
    await espera(61_000);
  }
  throw new Error('límite de revisiones: no se pudo consultar');
}

let fallas = 0;
console.log(`Revisor en ${BASE}\n`);
for (const c of CASOS) {
  const errores = [];
  let resumen = '';
  try {
    const { estado, cuerpo } = await pide(c.d);
    if (c.estado) { if (estado !== c.estado) errores.push(`respondió ${estado}, se esperaba ${c.estado}`); }
    else if (estado !== 200 || !cuerpo?.findings) errores.push(`respondió ${estado} sin hallazgos`);
    else {
      const h = Object.fromEntries(cuerpo.findings.map((f) => [f.key, f]));
      resumen = cuerpo.findings.map((f) => `${f.key}=${f.level}`).join(' ');
      for (const [k, nivel] of Object.entries(c.es ?? {})) if (h[k]?.level !== nivel) errores.push(`${k}: dice «${h[k]?.level ?? 'nada'}», debe decir «${nivel}»`);
      for (const [k, niveles] of Object.entries(c.no ?? {})) if (h[k] && niveles.includes(h[k].level)) errores.push(`${k}: dice «${h[k].level}» y no puede (${h[k].title})`);
      for (const k of c.sin ?? []) if (h[k]) errores.push(`${k}: opina («${h[k].title}») de algo que no pudo leer`);
      for (const [k, re] of Object.entries(c.titulo ?? {})) if (h[k] && !re.test(h[k].title)) errores.push(`${k}: el texto «${h[k].title}» no explica la causa`);
      if ('de' in c && (cuerpo.details?.email?.dmarc_from ?? null) !== c.de) errores.push(`DMARC: dice que sale de «${cuerpo.details?.email?.dmarc_from ?? null}», debe ser «${c.de}»`);
    }
  } catch (e) { errores.push(String(e?.message ?? e)); }
  fallas += errores.length ? 1 : 0;
  console.log(`${errores.length ? '✗' : '✓'} ${c.d}${errores.length ? '' : ''}`);
  for (const e of errores) console.log(`    ${e}`);
  if (errores.length && resumen) console.log(`    (${resumen})`);
}
console.log(`\n${CASOS.length - fallas} de ${CASOS.length} casos bien.`);
process.exit(fallas ? 1 : 0);
