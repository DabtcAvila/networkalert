// «Mi lista»: guarda en este navegador lo que la persona usa y, si deja su correo, pide los avisos al servidor.
// La llave que llega por correo viaja en el fragmento (#…) de la dirección: no se envía al servidor ni queda en registros.
import { MAX, VACIA, partePalabras, type Lista } from '../lib/lista';
import { leeLista, guardaLista, leeLlave, guardaLlave } from './lista-local';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const form = $<HTMLFormElement>('lista-form');
const cajaProv = $('lista-proveedores'), campoPal = $<HTMLInputElement>('lista-palabras'), campoDom = $<HTMLTextAreaElement>('lista-dominios'), campoCorreo = $<HTMLInputElement>('lista-correo');
const boton = $<HTMLButtonElement>('lista-guardar');

let lista: Lista = leeLista();
let llave = leeLlave();

function dice(texto: string, error = false) {
  const ok = $('lista-estado')!, mal = $('lista-error')!;
  ok.hidden = error || !texto; mal.hidden = !error || !texto;
  (error ? mal : ok).textContent = texto;
  if (texto) (error ? mal : ok).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function pide(ruta: string, cuerpo: unknown): Promise<{ ok: boolean; status: number; j: any }> {
  try {
    const r = await fetch(ruta, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
    return { ok: r.ok, status: r.status, j: await r.json().catch(() => null) };
  } catch { return { ok: false, status: 0, j: { detail: 'No se pudo conectar. Revisa tu conexión e intenta de nuevo.' } }; }
}
const detalle = (j: any, otro: string) => (typeof j?.detail === 'string' ? j.detail : otro);

// ---- Formulario ----
const palabrasDelCampo = () => [...new Set(partePalabras(campoPal?.value ?? '').map((p) => p.toLowerCase()))].slice(0, MAX.palabras);

function marcaSugeridas() {
  const p = palabrasDelCampo();
  document.querySelectorAll<HTMLButtonElement>('[data-palabra]').forEach((b) => b.setAttribute('aria-pressed', String(p.includes(b.dataset.palabra!))));
}

function alFormulario() {
  if (campoPal) campoPal.value = lista.palabras.join(', ');
  if (campoDom) campoDom.value = lista.dominios.join('\n');
  cajaProv?.querySelectorAll<HTMLButtonElement>('[data-proveedor]').forEach((b) => b.setAttribute('aria-pressed', String(lista.proveedores.includes(b.dataset.proveedor!))));
  marcaSugeridas();
}

function delFormulario(): Lista {
  return {
    proveedores: [...(cajaProv?.querySelectorAll<HTMLButtonElement>('[data-proveedor][aria-pressed="true"]') ?? [])].map((b) => b.dataset.proveedor!),
    palabras: palabrasDelCampo(),
    dominios: [...new Set((campoDom?.value ?? '').split(/[\s,]+/).map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')).filter(Boolean))].slice(0, MAX.dominios),
  };
}

function pintaSesion(correo?: string) {
  const activa = !!llave;
  $('lista-activa')!.hidden = !activa;
  if (correo) $('lista-correo-activo')!.textContent = correo;
  $('lista-correo-caja')!.hidden = activa;
  $('lista-baja')!.hidden = !activa;
  if (boton) boton.textContent = activa ? 'Guardar cambios' : 'Guardar mi lista';
}

async function cargaProveedores() {
  if (!cajaProv) return;
  try {
    const r = await fetch('/api/v1/platforms');
    const j = (await r.json()) as { platforms: { id: string; name: string }[] };
    cajaProv.replaceChildren(...[...j.platforms].sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip chip--chico'; b.dataset.proveedor = p.id; b.textContent = p.name;
      b.setAttribute('aria-pressed', String(lista.proveedores.includes(p.id)));
      b.addEventListener('click', () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')));
      return b;
    }));
  } catch { cajaProv.textContent = 'No se pudieron cargar los proveedores. Recarga la página.'; }
}

// ---- Acciones que llegan desde el correo: confirmar y darse de baja ----
function accion(titulo: string, texto: string, etiqueta: string, alPulsar: (b: HTMLButtonElement) => Promise<void>) {
  const caja = $('lista-accion')!, b = $<HTMLButtonElement>('lista-accion-boton')!;
  $('lista-accion-titulo')!.textContent = titulo; $('lista-accion-texto')!.textContent = texto; b.textContent = etiqueta;
  caja.hidden = false; form!.hidden = true;
  b.onclick = async () => { b.disabled = true; await alPulsar(b); b.disabled = false; };
  $('lista-accion-titulo')!.focus({ preventScroll: true });
}
function cierraAccion() { $('lista-accion')!.hidden = true; form!.hidden = false; }

function usa(j: { correo?: string; lista?: Lista }) {
  if (j.lista) { lista = j.lista; guardaLista(lista); alFormulario(); }
  pintaSesion(j.correo);
}

async function arranca() {
  if (!form) return;
  const frag = new URLSearchParams(location.hash.slice(1));
  const confirmar = frag.get('confirmar'), deBaja = frag.get('baja'), gestionar = frag.get('t');
  // La llave se quita de la barra de direcciones en cuanto se lee.
  if (confirmar || deBaja || gestionar) history.replaceState(null, '', location.pathname);

  const d = new URLSearchParams(location.search).get('d');
  if (d && !lista.dominios.includes(d.toLowerCase()) && lista.dominios.length < MAX.dominios) lista = { ...lista, dominios: [...lista.dominios, d.toLowerCase()] };

  await cargaProveedores();
  alFormulario(); pintaSesion();

  if (confirmar) {
    accion('Confirma tus avisos', 'Un clic y quedan activos. Te escribiremos solo cuando haya algo que atender.', 'Confirmar', async () => {
      const r = await pide('/api/lista/confirmar', { t: confirmar });
      if (!r.ok) { cierraAccion(); return dice(detalle(r.j, 'No se pudo confirmar. Intenta de nuevo.'), true); }
      llave = confirmar; guardaLlave(llave); usa(r.j); cierraAccion();
      dice(r.j.lista?.dominios?.length ? 'Listo: avisos activos. En unos minutos te llega la primera revisión de tus dominios. Si no la ves, revisa tu carpeta de spam.' : 'Listo: avisos activos. Te escribiremos cuando haya una alerta alta o crítica de lo que usas. Si el correo de confirmación cayó en spam, márcalo como «no es spam» para que los avisos te lleguen.');
    });
    return;
  }
  if (deBaja) {
    accion('¿Darte de baja?', 'Dejamos de escribirte y borramos tu correo y tu lista de nuestro servidor.', 'Sí, darme de baja', async () => {
      const r = await pide('/api/lista/baja', { t: deBaja });
      cierraAccion();
      if (!r.ok) return dice(detalle(r.j, 'No se pudo completar la baja. Intenta de nuevo.'), true);
      if (llave === deBaja || !llave) { llave = null; guardaLlave(null); }
      pintaSesion(); dice('Listo: ya no recibirás correos. Borramos tu correo y tu lista de nuestro servidor.');
    });
    return;
  }
  if (gestionar) { llave = gestionar; guardaLlave(llave); }
  if (llave) {
    const r = await pide('/api/lista/ver', { t: llave });
    if (r.ok) usa(r.j);
    else if (r.status === 404) { llave = null; guardaLlave(null); pintaSesion(); if (gestionar) dice('Ese enlace ya no es válido. Puedes pedir los avisos de nuevo.', true); }
  }
}

if (form) {
  campoPal?.addEventListener('input', marcaSugeridas);
  document.querySelectorAll<HTMLButtonElement>('[data-palabra]').forEach((b) => b.addEventListener('click', () => {
    const p = palabrasDelCampo(), w = b.dataset.palabra!;
    campoPal!.value = (p.includes(w) ? p.filter((x) => x !== w) : [...p, w]).join(', ');
    marcaSugeridas();
  }));

  form.addEventListener('submit', async (e) => {
    e.preventDefault(); dice('');
    lista = delFormulario(); guardaLista(lista);
    const correo = campoCorreo?.value.trim() ?? '';
    const vacia = lista.proveedores.length + lista.palabras.length + lista.dominios.length === 0;
    if (vacia) return dice('Marca al menos un proveedor, una herramienta o un dominio.', true);
    if (!llave && !correo) {
      return dice(lista.dominios.length ? 'Guardada en este navegador. Para vigilar tus dominios necesitamos tu correo: escríbelo en el paso 4.' : 'Guardada en este navegador. En Alertas ya tienes el filtro «Mi lista».');
    }
    boton!.disabled = true;
    const r = await pide('/api/lista', llave ? { t: llave, lista } : { correo, lista });
    boton!.disabled = false;
    if (!r.ok) {
      if (llave && r.status === 404) { llave = null; guardaLlave(null); pintaSesion(); }
      return dice(detalle(r.j, 'No se pudo guardar. Intenta de nuevo en un momento.'), true);
    }
    if (r.j.guardado) { usa(r.j); dice('Cambios guardados.'); }
    else dice(`Te enviamos un correo a ${correo}. Ábrelo y confirma para activar los avisos. Si no lo ves en unos minutos, revisa tu carpeta de spam y márcalo como «no es spam».`);
  });

  $('lista-baja')?.addEventListener('click', () => {
    const t = llave; if (!t) return;
    accion('¿Darte de baja?', 'Dejamos de escribirte y borramos tu correo y tu lista de nuestro servidor.', 'Sí, darme de baja', async () => {
      const r = await pide('/api/lista/baja', { t });
      cierraAccion();
      if (!r.ok) return dice(detalle(r.j, 'No se pudo completar la baja. Intenta de nuevo.'), true);
      llave = null; guardaLlave(null); pintaSesion();
      dice('Listo: ya no recibirás correos. Borramos tu correo y tu lista de nuestro servidor.');
    });
  });

  $('lista-vaciar')?.addEventListener('click', () => {
    lista = { ...VACIA }; guardaLista(null); alFormulario();
    dice(llave ? 'Lista borrada de este navegador. Tus avisos por correo siguen activos; para quitarlos usa «Darme de baja».' : 'Lista borrada de este navegador.');
  });

  void arranca();
}

export {};
