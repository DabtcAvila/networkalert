/**
 * Avisos por correo de «Mi lista».
 *
 * Una persona deja su correo, sus dominios y lo que usa. Nada se activa hasta que confirma desde su correo.
 * Después recibe correo solo cuando hay algo que atender:
 *   - en sus dominios: se revisan una vez al día y se avisa de lo nuevo (o de lo que empeoró);
 *   - en lo que usa: alertas altas o críticas que coincidan con su lista.
 * Cada correo trae el enlace para cambiar la lista y para darse de baja. La baja borra todo.
 *
 * Se guarda en D1 (ver esquema.sql). Sin los enlaces `DB` y `EMAIL` la función queda apagada.
 */
import { coincide, limpia, tieneAlgo, type AlertaMin, type Lista } from '../src/lib/lista';
import { normaliza, revisar, type Hallazgo, type Nivel } from './revisar';

export interface Correo {
  send(m: { to: string; from: { email: string; name: string }; replyTo?: string; subject: string; html: string; text: string; headers?: Record<string, string> }): Promise<unknown>;
}
export interface EnvAvisos { DB?: D1Database; EMAIL?: Correo; ORIGEN?: string }
type Alerta = AlertaMin & { id: string; severity: string; url: string; first_seen: string; status: string; stale?: boolean; summary?: string; summary_es?: string; action?: string; escalated_at?: string };
type Fila = { id: string; correo: string; config: string; pendiente: string | null; confirmada: number; ultimo_correo: string | null; avisado_hasta: string | null; dia: string | null; correos_dia: number };
export type Salida = { status: number; cuerpo: unknown };

const DE = { email: 'avisos@networkalert.dev', name: 'Network Alert' };
const RESPONDER_A = 'contacto@networkalert.dev';
const DIA = 86_400_000;
const DOMINIOS_POR_VUELTA = 2;      // cada revisión hace ~14 consultas hacia fuera; el plan gratuito permite 50 por ejecución
const CORREOS_ALERTA_POR_VUELTA = 8;
const CORREOS_ALERTA_POR_DIA = 6;   // tope por persona, para que un mal día no llene su bandeja
const ESPERA_CONFIRMACION = 10 * 60_000;

export const listo = (env: EnvAvisos): env is EnvAvisos & { DB: D1Database; EMAIL: Correo } => !!env.DB && !!env.EMAIL;
const origen = (env: EnvAvisos) => (env.ORIGEN ?? 'https://networkalert.dev').replace(/\/$/, '');
const ok = (cuerpo: unknown): Salida => ({ status: 200, cuerpo });
const error = (status: number, detail: string): Salida => ({ status, cuerpo: { detail } });
const ahora = () => new Date().toISOString();
const esc = (s: unknown) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]!);
const oculta = (correo: string) => correo.replace(/^(.).*(@.*)$/, '$1•••$2');
const llaveValida = (t: unknown): t is string => typeof t === 'string' && /^[a-f0-9]{48}$/.test(t);
const nuevaLlave = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
const config = (texto: string | null): Lista => limpia(texto ? JSON.parse(texto) : {}, normaliza);

// ---------------------------------------------------------------------------
// Correos: texto plano y HTML sencillo, sin imágenes ni rastreo.
// ---------------------------------------------------------------------------
type Punto = { marca?: string; titulo: string; detalle?: string; url?: string };
type Mensaje = { asunto: string; titulo: string; intro?: string; puntos?: Punto[]; boton?: { texto: string; url: string }; nota?: string };

async function envia(env: EnvAvisos & { EMAIL: Correo }, para: string, llave: string, m: Mensaje, conBaja = true): Promise<boolean> {
  const o = origen(env), gestionar = `${o}/mi-lista#t=${llave}`, baja = `${o}/mi-lista#baja=${llave}`;
  const pieTexto = conBaja ? `Recibes este correo porque pediste avisos en networkalert.dev.\nCambiar mi lista: ${gestionar}\nDarme de baja: ${baja}` : 'Si no lo pediste tú, ignora este correo: no se guardará nada.';
  const text = [m.titulo, m.intro, ...(m.puntos ?? []).map((p) => `- ${p.marca ? `[${p.marca}] ` : ''}${p.titulo}${p.detalle ? `\n  ${p.detalle}` : ''}${p.url ? `\n  ${p.url}` : ''}`), m.boton && `${m.boton.texto}: ${m.boton.url}`, m.nota, '—', pieTexto].filter(Boolean).join('\n\n');
  const pieHtml = conBaja
    ? `Recibes este correo porque pediste avisos en networkalert.dev.<br><a href="${esc(gestionar)}" style="color:#5b3df5">Cambiar mi lista</a> · <a href="${esc(baja)}" style="color:#5b3df5">Darme de baja</a>`
    : 'Si no lo pediste tú, ignora este correo: no se guardará nada.';
  const html = `<!doctype html><html lang="es"><body style="margin:0;padding:24px 16px;background:#f6f5fb;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#14132b;line-height:1.5">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e4e2f0;border-radius:12px;padding:28px 24px">
<p style="margin:0 0 16px;font-size:13px;font-weight:700;letter-spacing:.04em;color:#5b3df5">NETWORK ALERT</p>
<h1 style="margin:0 0 12px;font-size:21px;line-height:1.3">${esc(m.titulo)}</h1>
${m.intro ? `<p style="margin:0 0 16px;font-size:15px;color:#3d3b57">${esc(m.intro)}</p>` : ''}
${(m.puntos ?? []).map((p) => `<div style="margin:0 0 12px;padding:12px 14px;border:1px solid #e4e2f0;border-left:4px solid ${p.marca === 'Atender hoy' || p.marca === 'Crítica' ? '#c8372d' : p.marca === 'Bien' ? '#2f8f6b' : '#c98a12'};border-radius:8px">
${p.marca ? `<p style="margin:0 0 2px;font-size:12px;font-weight:700;color:#6b6985">${esc(p.marca.toUpperCase())}</p>` : ''}<p style="margin:0;font-size:15px;font-weight:600">${p.url ? `<a href="${esc(p.url)}" style="color:#14132b">${esc(p.titulo)}</a>` : esc(p.titulo)}</p>
${p.detalle ? `<p style="margin:4px 0 0;font-size:14px;color:#3d3b57">${esc(p.detalle)}</p>` : ''}</div>`).join('\n')}
${m.boton ? `<p style="margin:20px 0"><a href="${esc(m.boton.url)}" style="display:inline-block;padding:12px 22px;background:#5b3df5;color:#fff;font-weight:600;font-size:15px;text-decoration:none;border-radius:999px">${esc(m.boton.texto)}</a></p>` : ''}
${m.nota ? `<p style="margin:0 0 4px;font-size:13px;color:#6b6985">${esc(m.nota)}</p>` : ''}
</div>
<p style="max-width:560px;margin:16px auto 0;font-size:12px;color:#6b6985;text-align:center">${pieHtml}</p>
</body></html>`;
  try {
    await env.EMAIL.send({
      to: para, from: DE, replyTo: RESPONDER_A, subject: m.asunto.slice(0, 180), html, text,
      ...(conBaja ? { headers: { 'List-Unsubscribe': `<${o}/api/lista/baja?t=${llave}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}),
    });
    return true;
  } catch (e) {
    const x = e as { code?: string; message?: string };
    console.error('correo', x?.code ?? '', String(x?.message ?? e).slice(0, 200));
    return false;
  }
}

function resume(l: Lista): Punto[] {
  return [
    l.dominios.length ? { titulo: `Dominios: ${l.dominios.join(', ')}`, detalle: 'Los revisamos una vez al día y te escribimos si hay algo que atender.' } : null,
    l.proveedores.length || l.palabras.length ? { titulo: `Lo que usas: ${[...l.proveedores, ...l.palabras].join(', ')}`, detalle: 'Te escribimos cuando haya una alerta alta o crítica.' } : null,
  ].filter((p): p is NonNullable<typeof p> => !!p);
}

// ---------------------------------------------------------------------------
// Altas, cambios y bajas
// ---------------------------------------------------------------------------
/** Deja la lista como vigente y pone al día qué dominios se vigilan. */
async function aplica(db: D1Database, id: string, l: Lista): Promise<void> {
  const previos = ((await db.prepare('SELECT dominio FROM vigilancias WHERE sus = ?').bind(id).all<{ dominio: string }>()).results ?? []).map((r) => r.dominio);
  const pasos = [
    db.prepare("UPDATE suscripciones SET config = ?, pendiente = NULL, confirmada = 1, avisado_hasta = COALESCE(avisado_hasta, ?) WHERE id = ?").bind(JSON.stringify(l), ahora(), id),
    ...previos.filter((d) => !l.dominios.includes(d)).map((d) => db.prepare('DELETE FROM vigilancias WHERE sus = ? AND dominio = ?').bind(id, d)),
    ...l.dominios.filter((d) => !previos.includes(d)).flatMap((d) => [
      db.prepare('INSERT OR IGNORE INTO vigilancias (sus, dominio) VALUES (?, ?)').bind(id, d),
      db.prepare('INSERT OR IGNORE INTO dominios (dominio) VALUES (?)').bind(d),
      // Si el dominio ya lo vigilaba otra persona, se pone al frente de la fila: quien llega recibe su primera
      // revisión en la siguiente vuelta y no hasta la revisión diaria (podían pasar casi 24 horas).
      db.prepare('UPDATE dominios SET revisado = NULL WHERE dominio = ?').bind(d),
    ]),
    db.prepare('DELETE FROM dominios WHERE dominio NOT IN (SELECT dominio FROM vigilancias)'),
  ];
  await db.batch(pasos);
}

const vista = (f: Fila) => ({ ok: true, correo: oculta(f.correo), lista: config(f.config), cambio_pendiente: !!f.pendiente });

/** Alta o cambio. Sin llave siempre se pide confirmar por correo; con llave válida el cambio se guarda al momento. */
export async function solicita(env: EnvAvisos, cuerpo: unknown): Promise<Salida> {
  if (!listo(env)) return error(503, 'Los avisos por correo todavía no están disponibles.');
  const b = (cuerpo && typeof cuerpo === 'object' ? cuerpo : {}) as Record<string, unknown>;
  const l = limpia(b.lista, normaliza);
  if (!tieneAlgo(l)) return error(422, 'Agrega al menos un dominio, un proveedor o una herramienta.');

  if (b.t !== undefined) {
    if (!llaveValida(b.t)) return error(404, 'Ese enlace ya no es válido.');
    const f = await env.DB.prepare('SELECT * FROM suscripciones WHERE id = ? AND confirmada = 1').bind(b.t).first<Fila>();
    if (!f) return error(404, 'Ese enlace ya no es válido.');
    await aplica(env.DB, f.id, l);
    return ok({ ok: true, guardado: true, correo: oculta(f.correo), lista: l });
  }

  const correo = typeof b.correo === 'string' ? b.correo.trim().toLowerCase() : '';
  if (correo.length > 254 || !/^[^\s@<>"',;]{1,64}@[a-z0-9]([a-z0-9.-]{0,180})\.[a-z]{2,24}$/.test(correo)) return error(422, 'Ese correo no parece válido.');

  const previa = await env.DB.prepare('SELECT * FROM suscripciones WHERE correo = ?').bind(correo).first<Fila>();
  // Freno: a un mismo correo no se le manda más de una confirmación cada diez minutos. La respuesta es la misma para no revelar nada.
  if (previa?.ultimo_correo && Date.now() - Date.parse(previa.ultimo_correo) < ESPERA_CONFIRMACION) return ok({ ok: true, correo_enviado: true });

  const id = previa?.id ?? nuevaLlave();
  if (!previa) await env.DB.prepare('INSERT INTO suscripciones (id, correo, config, creada, ultimo_correo) VALUES (?, ?, ?, ?, ?)').bind(id, correo, JSON.stringify(l), ahora(), ahora()).run();
  else if (previa.confirmada) await env.DB.prepare('UPDATE suscripciones SET pendiente = ?, ultimo_correo = ? WHERE id = ?').bind(JSON.stringify(l), ahora(), id).run();
  else await env.DB.prepare('UPDATE suscripciones SET config = ?, ultimo_correo = ? WHERE id = ?').bind(JSON.stringify(l), ahora(), id).run();

  const enviado = await envia(env, correo, id, {
    asunto: previa?.confirmada ? 'Confirma el cambio en tus avisos de Network Alert' : 'Confirma tus avisos de Network Alert',
    titulo: previa?.confirmada ? 'Confirma el cambio en tu lista' : 'Confirma tus avisos',
    intro: 'Alguien, esperamos que tú, pidió avisos de Network Alert para este correo. Esto es lo que vigilaremos:',
    puntos: resume(l),
    boton: { texto: 'Confirmar', url: `${origen(env)}/mi-lista#confirmar=${id}` },
    nota: 'El enlace sirve 48 horas. Nada se activa hasta que confirmes.',
  }, false);
  if (!enviado) {
    if (!previa) await env.DB.prepare('DELETE FROM suscripciones WHERE id = ?').bind(id).run();
    return error(502, 'No pudimos enviar el correo de confirmación. Intenta de nuevo en un momento.');
  }
  return ok({ ok: true, correo_enviado: true });
}

export async function confirma(env: EnvAvisos, t: unknown): Promise<Salida> {
  if (!listo(env)) return error(503, 'Los avisos por correo todavía no están disponibles.');
  if (!llaveValida(t)) return error(404, 'Ese enlace ya no es válido. Pide los avisos de nuevo.');
  const f = await env.DB.prepare('SELECT * FROM suscripciones WHERE id = ?').bind(t).first<Fila>();
  if (!f) return error(404, 'Ese enlace ya no es válido. Pide los avisos de nuevo.');
  const l = config(f.confirmada ? (f.pendiente ?? f.config) : f.config);
  if (!f.confirmada || f.pendiente) await aplica(env.DB, f.id, l);
  return ok({ ok: true, correo: oculta(f.correo), lista: l, cambio_pendiente: false });
}

export async function ver(env: EnvAvisos, t: unknown): Promise<Salida> {
  if (!listo(env)) return error(503, 'Los avisos por correo todavía no están disponibles.');
  if (!llaveValida(t)) return error(404, 'Ese enlace ya no es válido.');
  const f = await env.DB.prepare('SELECT * FROM suscripciones WHERE id = ? AND confirmada = 1').bind(t).first<Fila>();
  return f ? ok(vista(f)) : error(404, 'Ese enlace ya no es válido.');
}

/** Baja: borra el correo, la lista y lo que se vigilaba. Responde igual exista o no la llave. */
export async function baja(env: EnvAvisos, t: unknown): Promise<Salida> {
  if (!listo(env)) return error(503, 'Los avisos por correo todavía no están disponibles.');
  if (llaveValida(t)) await env.DB.batch([
    env.DB.prepare('DELETE FROM vigilancias WHERE sus = ?').bind(t),
    env.DB.prepare('DELETE FROM suscripciones WHERE id = ?').bind(t),
    env.DB.prepare('DELETE FROM dominios WHERE dominio NOT IN (SELECT dominio FROM vigilancias)'),
  ]);
  return ok({ ok: true, borrado: true });
}

// ---------------------------------------------------------------------------
// Vuelta del reloj: revisa dominios pendientes y avisa de alertas nuevas.
// ---------------------------------------------------------------------------
// En el correo no se usa la palabra «Urgente»: un aviso de seguridad con esa palabra y un botón se parece a un fraude,
// y los filtros de correo lo tratan así (pasó el 14 de noviembre de 2026 en un buzón de Microsoft 365).
const ETIQUETA: Record<Nivel, string> = { urgent: 'Atender hoy', fix: 'Por atender', improve: 'Mejora', ok: 'Bien' };
const SEV: Record<string, string> = { critical: 'Crítica', high: 'Alta' };

async function vueltaDominios(env: EnvAvisos & { DB: D1Database; EMAIL: Correo }, propio: (dominio: string) => ((url: string) => Promise<Response>) | undefined) {
  const limite = new Date(Date.now() - DIA).toISOString();
  const toca = (await env.DB.prepare('SELECT dominio, dudas FROM dominios WHERE revisado IS NULL OR revisado < ? ORDER BY revisado IS NOT NULL, revisado LIMIT ?').bind(limite, DOMINIOS_POR_VUELTA).all<{ dominio: string; dudas: number }>()).results ?? [];
  let correos = 0;
  for (const d of toca) {
    let hallazgos: Hallazgo[];
    try {
      const r = await revisar(d.dominio, propio(d.dominio));
      hallazgos = r ? r.findings : [{ level: 'urgent', key: 'dns', title: 'El dominio ya no existe o dejó de tener DNS.', action: 'Revisa que no haya vencido y que sus servidores de nombres sigan configurados.' }];
    } catch (e) {
      console.error('vigilar', d.dominio, String(e));
      await env.DB.prepare('UPDATE dominios SET revisado = ? WHERE dominio = ?').bind(ahora(), d.dominio).run();
      continue;
    }
    // Un sitio que no abre una sola vez puede ser un tropiezo de red: se vuelve a mirar en diez minutos y se avisa solo si sigue igual.
    const caido = hallazgos.some((h) => h.level === 'urgent' && (h.key === 'web' || h.key === 'dns'));
    if (caido && d.dudas === 0) {
      await env.DB.prepare('UPDATE dominios SET dudas = 1, revisado = ? WHERE dominio = ?').bind(new Date(Date.now() - DIA + 10 * 60_000).toISOString(), d.dominio).run();
      continue;
    }
    const serios = hallazgos.filter((h) => h.level === 'urgent' || h.level === 'fix');
    const actual = Object.fromEntries(serios.map((h) => [h.key, h.level]));
    const quienes = (await env.DB.prepare('SELECT v.sus, v.avisado, v.primera, s.correo FROM vigilancias v JOIN suscripciones s ON s.id = v.sus WHERE v.dominio = ? AND s.confirmada = 1').bind(d.dominio).all<{ sus: string; avisado: string; primera: number; correo: string }>()).results ?? [];
    for (const q of quienes) {
      const previo = JSON.parse(q.avisado || '{}') as Record<string, Nivel>;
      const nuevos = serios.filter((h) => !(h.key in previo) || (h.level === 'urgent' && previo[h.key] === 'fix'));
      if (q.primera || nuevos.length) {
        const lista = q.primera ? serios : nuevos;
        const enlace = `${origen(env)}/revisar?d=${encodeURIComponent(d.dominio)}`;
        const enviado = await envia(env, q.correo, q.sus, {
          asunto: q.primera
            ? `${d.dominio}: primera revisión, ${serios.length ? `${serios.length} ${serios.length === 1 ? 'cosa' : 'cosas'} por atender` : 'todo en orden'}`
            : `${d.dominio}: ${nuevos[0].title}${nuevos.length > 1 ? ` (y ${nuevos.length - 1} más)` : ''}`,
          titulo: q.primera ? `Primera revisión de ${d.dominio}` : `${d.dominio} necesita atención`,
          intro: lista.length ? (q.primera ? `Pediste que vigiláramos ${d.dominio}. Esto es lo que conviene atender. Te volveremos a escribir solo si aparece algo nuevo o algo empeora.` : `Vigilamos ${d.dominio} porque lo pediste. Esto cambió desde la última revisión:`) : `Pediste que vigiláramos ${d.dominio}. No encontramos nada que atender. Lo revisaremos cada día y te escribiremos solo si algo cambia.`,
          puntos: lista.map((h) => ({ marca: ETIQUETA[h.level], titulo: h.title, detalle: h.action })),
          boton: { texto: 'Ver la revisión completa', url: enlace },
          nota: 'Revisión hecha desde fuera, con datos públicos. Es una orientación, no una auditoría.',
        });
        if (!enviado) continue; // se reintenta en la siguiente revisión
        correos++;
      }
      await env.DB.prepare('UPDATE vigilancias SET avisado = ?, primera = 0 WHERE sus = ? AND dominio = ?').bind(JSON.stringify(actual), q.sus, d.dominio).run();
    }
    await env.DB.prepare('UPDATE dominios SET revisado = ?, dudas = ? WHERE dominio = ?').bind(ahora(), caido ? d.dudas + 1 : 0, d.dominio).run();
  }
  return { dominios: toca.length, correos };
}

async function vueltaAlertas(env: EnvAvisos & { DB: D1Database; EMAIL: Correo }, alertas: Alerta[]) {
  const serias = alertas.filter((a) => a.severity in SEV && !a.stale && a.status === 'active');
  if (!serias.length) return { correos: 0 };
  const hoy = ahora().slice(0, 10);
  const filas = (await env.DB.prepare('SELECT * FROM suscripciones WHERE confirmada = 1').all<Fila>()).results ?? [];
  let correos = 0;
  for (const f of filas) {
    if (correos >= CORREOS_ALERTA_POR_VUELTA) break;
    const l = config(f.config);
    if (!l.proveedores.length && !l.palabras.length) continue;
    const enviadosHoy = f.dia === hoy ? f.correos_dia : 0;
    if (enviadosHoy >= CORREOS_ALERTA_POR_DIA) continue;
    const desde = Date.parse(f.avisado_hasta ?? '') || Date.now();
    // Cuenta como nueva la que apareció después del último aviso y también la que ya existía y subió a alta o crítica.
    const subio = (a: Alerta) => !!a.escalated_at && Date.parse(a.escalated_at) > desde && Date.parse(a.first_seen) <= desde;
    const nuevas = serias.filter((a) => (Date.parse(a.first_seen) > desde || subio(a)) && coincide(a, l));
    if (!nuevas.length) continue;
    const titulo = (a: Alerta) => a.title_es ?? a.title;
    const enviado = await envia(env, f.correo, f.id, {
      asunto: `${titulo(nuevas[0])}${nuevas.length > 1 ? ` (y ${nuevas.length - 1} más)` : ''}`,
      titulo: nuevas.length === 1 ? 'Una alerta toca algo que usas' : `${nuevas.length} alertas tocan algo que usas`,
      puntos: nuevas.slice(0, 8).map((a) => ({ marca: subio(a) ? `Subió a ${SEV[a.severity].toLowerCase()}` : SEV[a.severity], titulo: titulo(a), detalle: [(a.summary_es ?? a.summary)?.slice(0, 240), a.action && `Qué hacer: ${a.action}`].filter(Boolean).join(' ') || undefined, url: /^https:\/\//.test(a.url) ? a.url : undefined })),
      boton: { texto: 'Ver mis alertas', url: `${origen(env)}/alertas?f=lista` },
      nota: 'Cada alerta enlaza a su fuente. Verifica ahí antes de actuar.',
    });
    if (!enviado) continue;
    correos++;
    await env.DB.prepare('UPDATE suscripciones SET avisado_hasta = ?, dia = ?, correos_dia = ? WHERE id = ?').bind(ahora(), hoy, enviadosHoy + 1, f.id).run();
  }
  return { correos };
}

/** Una vuelta completa. La llama el reloj de Cloudflare cada 5 minutos. */
export async function vuelta(env: EnvAvisos, alertas: Alerta[], propio: (dominio: string) => ((url: string) => Promise<Response>) | undefined) {
  if (!listo(env)) return { activo: false };
  // Las altas que nadie confirmó en 48 horas se borran.
  await env.DB.prepare('DELETE FROM suscripciones WHERE confirmada = 0 AND creada < ?').bind(new Date(Date.now() - 2 * DIA).toISOString()).run();
  const dominios = await vueltaDominios(env, propio);
  const avisos = await vueltaAlertas(env, alertas);
  return { activo: true, dominios_revisados: dominios.dominios, correos_dominio: dominios.correos, correos_alerta: avisos.correos };
}
