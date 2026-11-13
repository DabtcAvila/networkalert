// Movimiento común a todo el sitio: aparición al entrar en pantalla y pestañas con avance automático.
// Sin esta hoja el contenido se ve igual (nada queda oculto si el script no carga).

const reducido = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// 1) Aparición: los .rev empiezan apenas desplazados y entran con un fundido de 0.5 s al cruzar el borde.
const revs = document.querySelectorAll<HTMLElement>('.rev');
if (revs.length && !reducido && 'IntersectionObserver' in window) {
  document.documentElement.classList.add('rev-listo');
  const io = new IntersectionObserver((entradas) => {
    for (const e of entradas) if (e.isIntersecting) { (e.target as HTMLElement).classList.add('is-in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
  revs.forEach((el) => {
    // Escalonado: los hermanos .rev de una misma fila entran uno tras otro.
    const i = el.parentElement ? [...el.parentElement.children].filter((x) => x.classList.contains('rev')).indexOf(el) : 0;
    el.style.setProperty('--rev-i', String(Math.min(i, 6)));
    io.observe(el);
  });
}

// 2) Pestañas con barra de progreso: avanzan solas cada 7 s hasta que la persona elige una o pasa el puntero.
document.querySelectorAll<HTMLElement>('[data-pestanas]').forEach((raiz) => {
  const tabs = [...raiz.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const paneles = tabs.map((t) => document.getElementById(t.getAttribute('aria-controls') ?? ''));
  if (!tabs.length) return;
  let actual = 0, reloj = 0, auto = !reducido && raiz.dataset.auto !== 'no', encima = false, visible = false;
  const activa = (i: number, foco = false) => {
    actual = (i + tabs.length) % tabs.length;
    tabs.forEach((t, k) => { t.setAttribute('aria-selected', String(k === actual)); t.tabIndex = k === actual ? 0 : -1; t.classList.remove('corre'); });
    paneles.forEach((p, k) => { if (p) p.hidden = k !== actual; });
    if (foco) tabs[actual].focus();
    programa();
  };
  const programa = () => {
    clearTimeout(reloj);
    if (!auto || encima || !visible) return;
    void tabs[actual].offsetWidth; tabs[actual].classList.add('corre'); // reinicia la barra
    reloj = window.setTimeout(() => activa(actual + 1), 7000);
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => { auto = false; activa(i); });
    t.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); auto = false; activa(actual + (e.key === 'ArrowRight' ? 1 : -1), true); }
    });
  });
  raiz.addEventListener('pointerenter', () => { encima = true; clearTimeout(reloj); tabs[actual].classList.remove('corre'); });
  raiz.addEventListener('pointerleave', () => { encima = false; programa(); });
  new IntersectionObserver((e) => { visible = e[0].isIntersecting; if (visible) programa(); else clearTimeout(reloj); }).observe(raiz);
  activa(0);
});

// 3) Barra de lectura bajo la cabecera y sombra de la cabecera al bajar.
const barra = document.querySelector<HTMLElement>('.lectura > i'), cabecera = document.querySelector<HTMLElement>('.site-header');
let pendiente = false;
const alBajar = () => {
  pendiente = false;
  const max = document.documentElement.scrollHeight - innerHeight;
  if (barra) barra.style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 0})`;
  cabecera?.classList.toggle('site-header--baja', scrollY > 8);
};
addEventListener('scroll', () => { if (!pendiente) { pendiente = true; requestAnimationFrame(alBajar); } }, { passive: true });
alBajar();

// 4) Botones «Copiar»: copian el texto del elemento que indica data-copiar y lo confirman un momento.
document.querySelectorAll<HTMLButtonElement>('[data-copiar]').forEach((b) => b.addEventListener('click', async () => {
  const texto = document.querySelector(b.dataset.copiar!)?.textContent ?? '';
  const antes = b.textContent;
  try { await navigator.clipboard.writeText(texto); b.textContent = 'Copiado'; b.classList.add('ok'); } catch { b.textContent = 'No se pudo copiar'; }
  setTimeout(() => { b.textContent = antes; b.classList.remove('ok'); }, 1600);
}));

// 5) Índice lateral con seguimiento: resalta el punto que se está leyendo.
document.querySelectorAll<HTMLElement>('[data-indice]').forEach((nav) => {
  const enlaces = [...nav.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')];
  const blancos = enlaces.map((a) => document.getElementById(a.hash.slice(1))).filter((x): x is HTMLElement => !!x);
  const io = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) enlaces.forEach((a) => { const on = a.hash === `#${e.target.id}`; a.classList.toggle('activo', on); if (on) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); });
  }, { rootMargin: '-30% 0px -60% 0px' });
  blancos.forEach((b) => io.observe(b));
});

// 6) Cifras que cuentan desde cero al entrar en pantalla (data-contar con un entero).
document.querySelectorAll<HTMLElement>('[data-contar]').forEach((el) => {
  const fin = Number(el.textContent); if (!Number.isFinite(fin) || reducido) return;
  el.textContent = '0';
  const io = new IntersectionObserver((e) => {
    if (!e[0].isIntersecting) return; io.disconnect();
    const t0 = performance.now();
    const paso = (t: number) => { const k = Math.min(1, (t - t0) / 1000); el.textContent = String(Math.round(fin * (1 - (1 - k) ** 3))); if (k < 1) requestAnimationFrame(paso); };
    requestAnimationFrame(paso);
  }, { threshold: 0.6 });
  io.observe(el);
});

// 7) Brillo que sigue al puntero en las tarjetas (solo con ratón).
if (matchMedia('(hover: hover)').matches && !reducido) {
  document.addEventListener('pointermove', (e) => {
    const t = (e.target as HTMLElement).closest?.<HTMLElement>('.rasgo, .fuente, .ruta, .card, .paso, .vigilar > li, .alerta, .plataforma, .ayuda');
    if (!t) return;
    const r = t.getBoundingClientRect();
    t.style.setProperty('--mx', `${e.clientX - r.left}px`); t.style.setProperty('--my', `${e.clientY - r.top}px`);
  }, { passive: true });
}

// 8) Tira superior: nivel del día en vivo (una petición ligera a /api/v1/status).
const tira = document.getElementById('tira');
if (tira) {
  const NOMBRE: Record<string, string> = { normal: 'Normal', elevated: 'Elevado', high: 'Alto' };
  fetch('/api/v1/status').then((r) => (r.ok ? r.json() : null)).then((j: { status?: { level: string }; generated_at?: string } | null) => {
    if (!j?.status) return;
    tira.dataset.nivel = j.status.level;
    const n = document.getElementById('tira-nivel'), h = document.getElementById('tira-hace');
    if (n) n.textContent = NOMBRE[j.status.level] ?? 'Sin dato';
    if (h && j.generated_at) { const m = Math.max(0, Math.round((Date.now() - Date.parse(j.generated_at)) / 60000)); h.textContent = m < 1 ? '· hace un momento' : m < 60 ? `· hace ${m} min` : `· hace ${Math.round(m / 60)} h`; }
  }).catch(() => {});
}

// 9) Carrusel horizontal con flechas (el desplazamiento nativo con scroll-snap hace el resto).
document.querySelectorAll<HTMLElement>('[data-carrusel]').forEach((raiz) => {
  const pista = raiz.querySelector<HTMLElement>('.carrusel'); if (!pista) return;
  const botones = [...raiz.querySelectorAll<HTMLButtonElement>('[data-mover]')];
  const estado = () => botones.forEach((b) => { b.disabled = Number(b.dataset.mover) < 0 ? pista.scrollLeft < 8 : pista.scrollLeft > pista.scrollWidth - pista.clientWidth - 8; });
  botones.forEach((b) => b.addEventListener('click', () => { const paso = (pista.firstElementChild as HTMLElement)?.offsetWidth ?? 300; pista.scrollBy({ left: Number(b.dataset.mover) * (paso + 16) * 2, behavior: reducido ? 'auto' : 'smooth' }); }));
  pista.addEventListener('scroll', estado, { passive: true });
  new ResizeObserver(estado).observe(pista);
  estado();
});

export {};
