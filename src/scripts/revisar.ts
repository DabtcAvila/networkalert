// «Revisa tu dominio»: pide la revisión a /api/v1/check y pinta los hallazgos. El enlace ?d=dominio repite la revisión.
type Nivel = 'urgent' | 'fix' | 'improve' | 'ok';
type Resultado = { domain: string; checked_at: string; verdict: Nivel; summary: Record<Nivel, number>; findings: { level: Nivel; key: string; title: string; action?: string }[] };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const form = $<HTMLFormElement>('revisar-form'), campo = $<HTMLInputElement>('revisar-dominio'), boton = $<HTMLButtonElement>('revisar-boton');
const ETIQUETA: Record<Nivel, string> = { urgent: 'Urgente', fix: 'Por atender', improve: 'Mejora', ok: 'Bien' };
// Reutiliza los colores de severidad de las alertas.
const SEV: Record<Nivel, string> = { urgent: 'critical', fix: 'high', improve: 'low', ok: 'ok' };
const VEREDICTO: Record<Nivel, string> = {
  urgent: 'Hay algo urgente que atender',
  fix: 'Hay cosas por atender',
  improve: 'Está bien; se puede mejorar',
  ok: 'Todo en orden',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, clase: string, texto?: string) {
  const e = document.createElement(tag); e.className = clase; if (texto != null) e.textContent = texto; return e;
}

function pinta(r: Resultado) {
  $('revisar-cab')!.dataset.nivel = r.verdict;
  $('revisar-nombre')!.textContent = r.domain;
  $('revisar-veredicto')!.textContent = VEREDICTO[r.verdict];
  for (const n of ['urgent', 'fix', 'improve', 'ok'] as Nivel[]) $(`n-${n}`)!.textContent = String(r.summary[n]);
  $('revisar-lista')!.replaceChildren(...r.findings.map((f) => {
    const li = el('li', 'alerta'); li.dataset.sev = SEV[f.level];
    const cab = el('p', 'alerta__cab'); cab.append(el('span', 'sev', ETIQUETA[f.level]));
    li.append(cab, el('h3', 'alerta__titulo', f.title));
    if (f.action) li.append(el('p', 'alerta__resumen', f.action));
    return li;
  }));
  $<HTMLAnchorElement>('revisar-json')!.href = `/api/v1/check?domain=${encodeURIComponent(r.domain)}`;
  $('revisar-pie')!.textContent = `Revisado el ${new Date(r.checked_at).toLocaleString('es-MX', { dateStyle: 'long', timeStyle: 'short' })}. Es una orientación con datos públicos, no una auditoría.`;
  $('revisar-resultado')!.hidden = false;
  $('revisar-veredicto')!.focus({ preventScroll: true });
  $('revisar-resultado')!.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

async function revisa(dominio: string) {
  const espera = $('revisar-espera')!, error = $('revisar-error')!;
  error.hidden = true; $('revisar-resultado')!.hidden = true;
  $('revisar-espera-dominio')!.textContent = dominio;
  espera.hidden = false; boton!.disabled = true;
  try {
    const r = await fetch(`/api/v1/check?domain=${encodeURIComponent(dominio)}`);
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      const d = j?.detail;
      throw new Error(r.status === 422 ? 'Eso no parece un dominio. Escríbelo así: tudominio.com' : typeof d === 'string' ? d : 'No se pudo revisar. Intenta de nuevo en un momento.');
    }
    const res = j as Resultado;
    history.replaceState(null, '', `?d=${encodeURIComponent(res.domain)}`);
    campo!.value = res.domain;
    pinta(res);
  } catch (e) {
    error.textContent = e instanceof TypeError ? 'No se pudo conectar. Revisa tu conexión e intenta de nuevo.' : (e as Error).message;
    error.hidden = false;
  } finally { espera.hidden = true; boton!.disabled = false; }
}

if (form && campo && boton) {
  form.addEventListener('submit', (e) => { e.preventDefault(); const d = campo.value.trim(); if (d) void revisa(d); else campo.focus(); });
  $('revisar-copiar')?.addEventListener('click', async (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    try { await navigator.clipboard.writeText(location.href); b.textContent = 'Enlace copiado'; } catch { b.textContent = 'No se pudo copiar'; }
    setTimeout(() => (b.textContent = 'Copiar enlace a este resultado'), 2200);
  });
  const inicial = new URLSearchParams(location.search).get('d');
  if (inicial) { campo.value = inicial; void revisa(inicial); }
}

export {};
