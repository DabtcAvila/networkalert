// /apoyar: arma la donación y manda a la persona a la página de pago de Mercado Pago.
// El formulario solo aparece si el Worker confirma que el cobro está configurado (GET /api/donar/estado).
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const form = $<HTMLFormElement>('donar'), cerrado = $('don-cerrado'), error = $('don-error');
const otro = $<HTMLInputElement>('don-otro'), correo = $<HTMLInputElement>('don-correo'), cajaCorreo = $('don-correo-caja'), enviar = $<HTMLButtonElement>('don-enviar');

if (form && cerrado && error && otro && correo && cajaCorreo && enviar) {
  let monto = 100, frecuencia: 'unica' | 'mensual' = 'unica', min = 20, max = 20000;
  const montos = [...form.querySelectorAll<HTMLButtonElement>('[data-monto]')];
  const frecuencias = [...form.querySelectorAll<HTMLButtonElement>('[data-frecuencia]')];
  const falla = (t: string) => { error.textContent = t; error.hidden = !t; };
  const pinta = () => {
    for (const b of montos) b.setAttribute('aria-pressed', String(!otro.value && Number(b.dataset.monto) === monto));
    for (const b of frecuencias) b.setAttribute('aria-pressed', String(b.dataset.frecuencia === frecuencia));
    cajaCorreo.hidden = frecuencia !== 'mensual';
    const valido = Number.isInteger(monto) && monto >= min && monto <= max;
    enviar.disabled = !valido;
    const mensual = frecuencia === 'mensual';
    enviar.textContent = valido
      ? `${mensual ? 'Apoyar con' : 'Donar'} $${monto.toLocaleString('es-MX')}${mensual ? ' al mes' : ''} con Mercado Pago`
      : `Elige un monto entre $${min} y $${max.toLocaleString('es-MX')}`;
  };
  for (const b of montos) b.addEventListener('click', () => { otro.value = ''; monto = Number(b.dataset.monto); pinta(); });
  for (const b of frecuencias) b.addEventListener('click', () => { frecuencia = b.dataset.frecuencia === 'mensual' ? 'mensual' : 'unica'; pinta(); });
  otro.addEventListener('input', () => { monto = otro.value ? Number(otro.value) : 100; pinta(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault(); falla('');
    if (frecuencia === 'mensual' && (!correo.value.trim() || !correo.checkValidity())) { falla('Escribe el correo de tu cuenta de Mercado Pago.'); correo.focus(); return; }
    enviar.disabled = true; enviar.textContent = 'Abriendo Mercado Pago…';
    try {
      const r = await fetch('/api/donar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ monto, frecuencia, correo: correo.value.trim() }) });
      const j = (await r.json().catch(() => null)) as { url?: string; detail?: unknown } | null;
      if (r.ok && typeof j?.url === 'string' && j.url.startsWith('https://')) { location.assign(j.url); return; }
      const d = j?.detail as string | { msg?: string }[] | undefined;
      falla(typeof d === 'string' ? d : Array.isArray(d) && typeof d[0]?.msg === 'string' ? d[0].msg : 'No se pudo abrir el pago. Intenta de nuevo en un momento.');
    } catch { falla('No hay conexión con el servidor. Intenta de nuevo en un momento.'); }
    pinta();
  });

  if (new URLSearchParams(location.search).get('estado') === 'error') falla('El pago no se completó y no se hizo ningún cargo. Puedes intentarlo de nuevo.');
  fetch('/api/donar/estado').then((r) => r.json()).then((j: { abierto?: boolean; minimo_mxn?: number; maximo_mxn?: number }) => {
    if (!j?.abierto) return;
    min = j.minimo_mxn ?? min; max = j.maximo_mxn ?? max;
    cerrado.hidden = true; form.hidden = false; pinta();
  }).catch(() => { /* se queda el aviso de «todavía no» */ });
}

export {};
