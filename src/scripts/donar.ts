// /apoyar: la donación se paga aquí mismo, sin salir del sitio.
// La tarjeta se escribe en campos cifrados del procesador de pagos (iframes): nunca toca nuestro código ni nuestro servidor.
// Al Worker solo llega un token de un uso (POST /api/donar). El formulario aparece si el cobro está configurado (GET /api/donar/estado).
declare global {
  interface Window {
    MercadoPago?: new (llave: string, o?: Record<string, unknown>) => Pasarela;
    MP_DEVICE_SESSION_ID?: string;
  }
}
interface Campo { mount(id: string): void; on(evento: string, cb: (d: { bin?: string }) => void): void }
interface Pasarela {
  fields: { create(tipo: string, o: Record<string, unknown>): Campo; createCardToken(o: { cardholderName: string }): Promise<{ id?: string }> };
  getPaymentMethods(o: { bin: string }): Promise<{ results?: { id: string; issuer?: { id?: string | number } }[] }>;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const form = $<HTMLFormElement>('donar'), cerrado = $('don-cerrado'), error = $('don-error'), gracias = $('don-gracias');
const otro = $<HTMLInputElement>('don-otro'), correo = $<HTMLInputElement>('don-correo'), titular = $<HTMLInputElement>('don-titular'), hp = $<HTMLInputElement>('don-hp');
const enviar = $<HTMLButtonElement>('don-enviar'), pagoAviso = $('don-pago-aviso'), pago = $('don-pago'), nota = $('don-nota');

const guion = (src: string, attrs: Record<string, string> = {}) => new Promise<boolean>((res) => {
  const s = document.createElement('script');
  s.src = src; s.async = true;
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  s.onload = () => res(true); s.onerror = () => res(false);
  document.head.append(s);
});

if (form && cerrado && error && gracias && otro && correo && titular && hp && enviar && pagoAviso && pago && nota) {
  let monto = 100, frecuencia: 'unica' | 'mensual' = 'unica', min = 20, max = 20000;
  let pasarela: Pasarela | null = null, medio = { id: '', emisor: '' }, enviando = false;
  const montos = [...form.querySelectorAll<HTMLButtonElement>('[data-monto]')];
  const frecuencias = [...form.querySelectorAll<HTMLButtonElement>('[data-frecuencia]')];
  const falla = (t: string, foco = false) => { error.textContent = t; error.hidden = !t; if (t && foco) error.focus(); };
  const pesos = () => `$${monto.toLocaleString('es-MX')}`;
  const pinta = () => {
    for (const b of montos) b.setAttribute('aria-pressed', String(!otro.value && Number(b.dataset.monto) === monto));
    for (const b of frecuencias) b.setAttribute('aria-pressed', String(b.dataset.frecuencia === frecuencia));
    const valido = Number.isInteger(monto) && monto >= min && monto <= max, mensual = frecuencia === 'mensual';
    enviar.disabled = !valido || !pasarela || enviando;
    enviar.textContent = enviando ? 'Procesando…' : valido ? `${mensual ? 'Apoyar con' : 'Donar'} ${pesos()}${mensual ? ' al mes' : ''}` : `Elige un monto entre $${min} y $${max.toLocaleString('es-MX')}`;
    nota.textContent = `Tu tarjeta viaja cifrada y no se guarda. En tu estado de cuenta: «NETWORKALERT». ${mensual ? 'Cancelas cuando quieras escribiendo a contacto@networkalert.dev. ' : ''}No es deducible de impuestos.`;
  };
  for (const b of montos) b.addEventListener('click', () => { otro.value = ''; monto = Number(b.dataset.monto); pinta(); });
  for (const b of frecuencias) b.addEventListener('click', () => { frecuencia = b.dataset.frecuencia === 'mensual' ? 'mensual' : 'unica'; pinta(); });
  otro.addEventListener('input', () => { monto = otro.value ? Number(otro.value) : 100; pinta(); });

  // Campos de la tarjeta con el estilo del sitio.
  const monta = (p: Pasarela) => {
    const css = getComputedStyle(document.documentElement);
    const style = { fontFamily: 'Inter, system-ui, sans-serif', fontSize: '16px', color: css.getPropertyValue('--ink').trim() || '#17162b', placeholderColor: css.getPropertyValue('--muted').trim() || '#6b6a80' };
    const campos: [string, string, string][] = [['cardNumber', 'don-numero', '0000 0000 0000 0000'], ['expirationDate', 'don-vence', 'MM/AA'], ['securityCode', 'don-cvv', '123']];
    for (const [tipo, id, placeholder] of campos) {
      const c = p.fields.create(tipo, { placeholder, style });
      c.mount(id);
      const caja = $(id);
      c.on('focus', () => caja?.classList.add('es-foco'));
      c.on('blur', () => caja?.classList.remove('es-foco'));
      if (tipo === 'cardNumber') c.on('binChange', (d) => {
        medio = { id: '', emisor: '' };
        if (!d?.bin) return;
        p.getPaymentMethods({ bin: d.bin }).then((r) => { const m = r?.results?.[0]; if (m) medio = { id: m.id, emisor: m.issuer?.id != null ? String(m.issuer.id) : '' }; }, () => {});
      });
    }
  };

  const prepara = async (llave: string) => {
    const [sdk] = await Promise.all([guion('https://sdk.mercadopago.com/js/v2'), guion('https://www.mercadopago.com/v2/security.js', { view: 'checkout' })]);
    if (!sdk || !window.MercadoPago) { pagoAviso.textContent = 'El pago no está disponible en este momento. Intenta más tarde.'; return; }
    try {
      pasarela = new window.MercadoPago(llave, { locale: 'es-MX' });
      monta(pasarela);
      pagoAviso.hidden = true; pago.hidden = false;
    } catch { pasarela = null; pagoAviso.textContent = 'El pago no está disponible en este momento. Intenta más tarde.'; }
    pinta();
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (enviando || !pasarela) return;
    falla('');
    if (!correo.value.trim() || !correo.checkValidity()) { falla('Escribe un correo válido.'); correo.focus(); return; }
    if (titular.value.trim().length < 3) { falla('Escribe el nombre como aparece en la tarjeta.'); titular.focus(); return; }
    if (!medio.id) { falla('Revisa el número de tarjeta: no la reconocimos.', true); return; }
    enviando = true; pinta();
    let token: { id?: string } | null = null;
    try { token = await pasarela.fields.createCardToken({ cardholderName: titular.value.replace(/\s+/g, ' ').trim() }); } catch { token = null; }
    if (!token?.id) { enviando = false; pinta(); falla('Revisa los datos de tu tarjeta: número, vencimiento y CVV. No se hizo ningún cargo.', true); return; }
    try {
      const r = await fetch('/api/donar', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ monto, frecuencia, correo: correo.value.trim(), hp: hp.value, pago: { token: token.id, payment_method_id: medio.id, issuer_id: medio.emisor || null, device_id: typeof window.MP_DEVICE_SESSION_ID === 'string' ? window.MP_DEVICE_SESSION_ID : null } }),
      });
      const j = (await r.json().catch(() => null)) as { ok?: boolean; referencia?: string; detail?: unknown } | null;
      if (r.ok && j?.ok) {
        const texto = $('don-gracias-texto'), ref = $('don-gracias-ref');
        if (texto) texto.textContent = frecuencia === 'mensual' ? `Tu apoyo de ${pesos()} al mes quedó activo. El primer cargo puede tardar unos minutos.` : `Recibimos tu donación de ${pesos()}. Mantiene esto gratis para todos.`;
        if (ref) ref.textContent = `Referencia: ${j.referencia ?? ''} · En tu estado de cuenta: «NETWORKALERT».`;
        form.hidden = true; gracias.hidden = false; gracias.scrollIntoView({ block: 'center' }); gracias.focus();
        return;
      }
      const d = j?.detail as string | { msg?: string }[] | undefined;
      falla(typeof d === 'string' ? d : Array.isArray(d) && typeof d[0]?.msg === 'string' ? d[0].msg : 'No se pudo procesar el pago. Intenta de nuevo en un momento.', true);
    } catch { falla('No hay conexión con el servidor. Antes de reintentar, revisa que no aparezca el cargo en tu tarjeta.', true); }
    enviando = false; pinta();
  });

  fetch('/api/donar/estado').then((r) => r.json()).then((j: { abierto?: boolean; minimo_mxn?: number; maximo_mxn?: number; public_key?: string | null }) => {
    if (!j?.abierto || !j.public_key) return;
    min = j.minimo_mxn ?? min; max = j.maximo_mxn ?? max;
    cerrado.hidden = true; form.hidden = false; pinta();
    void prepara(j.public_key);
  }).catch(() => { /* se queda el aviso de «todavía no» */ });
}

export {};
