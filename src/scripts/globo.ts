// Globo 3D de cortes de Internet: proyección ortográfica dibujada en canvas 2D (d3-geo), sin WebGL ni teselas.
// Se ve como una cúpula: el canvas solo muestra la parte alta de la esfera. Gira solo, se arrastra con el
// puntero o con las flechas, se detiene fuera de pantalla y con «reducir movimiento».
//
// Dos capas sobre la tierra:
//   · Red (ilustrativa): grandes nodos de interconexión de Internet y arcos entre ellos, con pulsos que viajan.
//     No es un dato medido; da contexto de por dónde corre la red. La nota bajo el globo lo dice.
//   · Señales (dato real): países con corte o degradación, que llegan del panel por data-paises + «na:paises».
import { geoOrthographic, geoPath, geoGraticule10, geoDistance, geoCircle, geoInterpolate } from 'd3-geo';
import { feature } from 'topojson-client';
import land110 from 'world-atlas/land-110m.json';

type Marca = { lon: number; lat: number; sev: string; nombre: string };
type Arco = { pts: [number, number][]; alt: number; fase: number; vel: number };
const COLOR: Record<string, string> = { critical: '#d12b1f', high: '#d9620b', medium: '#a87900', low: '#1e6fb8', info: '#6b6a80' };
const MX: [number, number] = [-102, 23.6];

// Ciudades con grandes puntos de intercambio o centros de datos (lon, lat).
const NODOS: [number, number][] = [
  [-74, 40.7], [-77.5, 39], [-80.2, 25.8], [-84.4, 33.7], [-87.6, 41.9], [-96.8, 32.8], [-105, 39.7], [-118.2, 34], [-121.9, 37.3], [-122.3, 47.6],
  [-79.4, 43.7], [-73.6, 45.5], [-123.1, 49.3], [-99.1, 19.4], [-100.4, 20.6], [-103.3, 20.7], [-100.3, 25.7], [-89.6, 21], [-74.1, 4.7], [-77, -12],
  [-70.7, -33.4], [-58.4, -34.6], [-46.6, -23.5], [-43.2, -22.9], [-38.5, -3.7], [-79.5, 9], [-66.9, 10.5], [-0.1, 51.5], [-6.3, 53.3], [-9.1, 38.7],
  [-3.7, 40.4], [2.3, 48.9], [4.9, 52.4], [8.7, 50.1], [5.4, 43.3], [9.2, 45.5], [8.5, 47.4], [18.1, 59.3], [12.6, 55.7], [21, 52.2],
  [16.4, 48.2], [29, 41], [37.6, 55.8], [31.2, 30], [3.4, 6.5], [-0.2, 5.6], [36.8, -1.3], [28, -26.2], [18.4, -33.9], [55.3, 25.2],
  [46.7, 24.7], [72.9, 19.1], [80.3, 13.1], [77.2, 28.6], [103.8, 1.35], [106.8, -6.2], [100.5, 13.8], [114.2, 22.3], [121.5, 25], [127, 37.6],
  [139.7, 35.7], [135.5, 34.7], [121, 14.6], [151.2, -33.9], [145, -37.8], [174.8, -36.8], [-157.9, 21.3], [-21.9, 64.1], [-17.4, 14.7], [44.8, 41.7],
];
// Rutas largas (índices de NODOS): cables transoceánicos y troncales conocidos, a grandes rasgos.
const LARGAS: [number, number][] = [[0, 27], [1, 32], [2, 22], [2, 25], [7, 60], [8, 60], [13, 5], [13, 2], [13, 7], [29, 24], [34, 51], [34, 43], [54, 63], [54, 57], [27, 47], [22, 48], [51, 49], [9, 60], [66, 7], [66, 60], [67, 27], [67, 0], [44, 29], [63, 65], [60, 59], [49, 27], [25, 18], [19, 20], [24, 68]];

const caja = document.querySelector<HTMLElement>('.globo');
const lienzo = caja?.querySelector<HTMLCanvasElement>('canvas');
const ctx = lienzo?.getContext('2d');

if (caja && lienzo && ctx) {
  const tierra = feature(land110 as never, (land110 as never as { objects: { land: never } }).objects.land) as never;
  const reticula = geoGraticule10();
  const anilloMx = geoCircle().center(MX).radius(7)();
  const reducido = window.matchMedia('(prefers-reduced-motion: reduce)');
  const proj = geoOrthographic().clipAngle(90).precision(0.4);
  const trazo = geoPath(proj, ctx);

  // Arcos: cada nodo con sus dos vecinos más cercanos + las rutas largas. Se precalculan los puntos del círculo máximo.
  const pares = new Map<string, [number, number]>();
  const agrega = (a: number, b: number) => { if (a !== b) pares.set(a < b ? `${a}-${b}` : `${b}-${a}`, [a, b]); };
  NODOS.forEach((n, i) => NODOS.map((m, j) => [j, geoDistance(n, m)] as [number, number]).filter(([j]) => j !== i).sort((x, y) => x[1] - y[1]).slice(0, 2).forEach(([j]) => agrega(i, j)));
  LARGAS.forEach(([a, b]) => agrega(a, b));
  const arcos: Arco[] = [...pares.values()].map(([a, b], k) => {
    const d = geoDistance(NODOS[a], NODOS[b]), inter = geoInterpolate(NODOS[a], NODOS[b]), n = Math.max(8, Math.round(d * 28));
    return { pts: Array.from({ length: n + 1 }, (_, i) => inter(i / n) as [number, number]), alt: 0.015 + d * 0.11, fase: (k * 0.37) % 1, vel: 0.00009 + ((k * 7) % 5) * 0.000022 };
  });

  let w = 0, h = 0, R = 0, cx = 0, cy = 0;
  let lon = 96, lat = 8; // rotación inicial: México a media cúpula
  let marcas: Marca[] = [];
  let visible = false, arrastrando = false, tocado = 0, raf = 0, previo = 0;

  const leer = () => { try { marcas = JSON.parse(caja.dataset.paises ?? '[]') as Marca[]; } catch { marcas = []; } };
  const medir = () => {
    const r = lienzo.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    w = r.width; h = r.height;
    lienzo.width = Math.round(w * dpr); lienzo.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    R = Math.min(w * 0.5 - 2, 620); cx = w / 2; cy = R + 6;
    proj.scale(R).translate([cx, cy]);
  };

  const dibuja = (t: number) => {
    proj.rotate([lon, lat]);
    const centro: [number, number] = [-lon, -lat];
    const seVe = (p: [number, number]) => geoDistance(p, centro) < Math.PI / 2 - 0.02;
    ctx.clearRect(0, 0, w, h);

    // Esfera: disco con degradado suave y borde fino
    const fondo = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.55, R * 0.1, cx, cy, R);
    fondo.addColorStop(0, '#ffffff'); fondo.addColorStop(1, '#efecff');
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fillStyle = fondo; ctx.fill();
    ctx.beginPath(); trazo(reticula); ctx.strokeStyle = 'rgba(91,61,245,0.09)'; ctx.lineWidth = 1; ctx.stroke();

    // Tierra con degradado del acento (más intensa hacia abajo)
    const suelo = ctx.createLinearGradient(0, cy - R, 0, cy + R * 0.2);
    suelo.addColorStop(0, '#b3a6ff'); suelo.addColorStop(1, '#6a4df7');
    ctx.beginPath(); trazo(tierra); ctx.fillStyle = suelo; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 0.6; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(91,61,245,0.35)'; ctx.lineWidth = 1.2; ctx.stroke();

    // Red: arcos elevados (en ortográfica, subir un punto es alejarlo del centro del disco)
    const sube = (p: [number, number], a: number): [number, number] => [cx + (p[0] - cx) * (1 + a), cy + (p[1] - cy) * (1 + a)];
    ctx.lineWidth = 1; ctx.lineCap = 'round';
    for (const a of arcos) {
      const n = a.pts.length - 1;
      let abierto = false;
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const g = a.pts[i];
        if (!seVe(g)) { abierto = false; continue; }
        const q = sube(proj(g) as [number, number], a.alt * Math.sin((Math.PI * i) / n));
        if (abierto) ctx.lineTo(q[0], q[1]); else { ctx.moveTo(q[0], q[1]); abierto = true; }
      }
      ctx.strokeStyle = 'rgba(40,24,140,0.36)'; ctx.stroke();
      // Pulso que viaja por el arco
      if (!reducido.matches) {
        const k = (a.fase + t * a.vel) % 1, i = Math.min(n - 1, Math.floor(k * n)), f = k * n - i;
        const g0 = a.pts[i], g1 = a.pts[i + 1];
        if (seVe(g0) && seVe(g1)) {
          const p0 = sube(proj(g0) as [number, number], a.alt * Math.sin((Math.PI * i) / n)), p1 = sube(proj(g1) as [number, number], a.alt * Math.sin((Math.PI * (i + 1)) / n));
          const x = p0[0] + (p1[0] - p0[0]) * f, y = p0[1] + (p1[1] - p0[1]) * f;
          const brillo = ctx.createRadialGradient(x, y, 0, x, y, 7);
          brillo.addColorStop(0, 'rgba(255,255,255,0.95)'); brillo.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = brillo; ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    // Red: nodos (punto oscuro con halo claro)
    const kn = Math.max(0.55, Math.min(1, R / 520)); // en pantallas chicas los nodos se encogen con la esfera
    for (const g of NODOS) {
      if (!seVe(g)) continue;
      const p = proj(g) as [number, number];
      ctx.beginPath(); ctx.arc(p[0], p[1], 7 * kn, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,0.42)'; ctx.fill();
      ctx.beginPath(); ctx.arc(p[0], p[1], 3.2 * kn, 0, Math.PI * 2); ctx.fillStyle = '#2a1f6b'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1; ctx.stroke();
    }

    // México: anillo punteado
    ctx.beginPath(); trazo(anilloMx); ctx.setLineDash([4, 4]); ctx.strokeStyle = '#14132b'; ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]);

    // Señales (dato real): núcleo de color + dos ondas que se abren
    for (const m of marcas) {
      if (!seVe([m.lon, m.lat])) continue;
      const p = proj([m.lon, m.lat]); if (!p) continue;
      const c = COLOR[m.sev] ?? COLOR.info, r = m.sev === 'info' ? 4 : m.sev === 'low' ? 5 : 6.5;
      if (m.sev !== 'info' && !reducido.matches) {
        for (const fase of [0, 0.5]) {
          const k = ((t / 2600 + fase) % 1);
          ctx.beginPath(); ctx.arc(p[0], p[1], r + k * r * 3.4, 0, Math.PI * 2);
          ctx.strokeStyle = c; ctx.globalAlpha = (1 - k) * 0.75; ctx.lineWidth = 1.6; ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    }
  };

  const cuadro = (t: number) => {
    const dt = Math.min(64, t - previo); previo = t;
    if (!arrastrando && t - tocado > 2600 && !reducido.matches) lon = (lon + dt * 0.0036) % 360;
    dibuja(t);
    raf = visible && !document.hidden && !reducido.matches ? requestAnimationFrame(cuadro) : 0;
  };
  const corre = () => { cancelAnimationFrame(raf); raf = 0; if (visible && !document.hidden && !reducido.matches) { previo = performance.now(); raf = requestAnimationFrame(cuadro); } else dibuja(0); };

  // Arrastre: horizontal gira, vertical inclina (con tope para no voltear el mundo)
  let x0 = 0, y0 = 0;
  lienzo.addEventListener('pointerdown', (e) => { arrastrando = true; x0 = e.clientX; y0 = e.clientY; lienzo.setPointerCapture(e.pointerId); caja.classList.add('globo--agarrado'); });
  lienzo.addEventListener('pointermove', (e) => {
    if (!arrastrando) return;
    const k = 90 / R;
    lon += (e.clientX - x0) * k; lat = Math.max(-70, Math.min(55, lat - (e.clientY - y0) * k));
    x0 = e.clientX; y0 = e.clientY;
    if (!raf) dibuja(performance.now());
  });
  const suelta = () => { if (!arrastrando) return; arrastrando = false; tocado = performance.now(); caja.classList.remove('globo--agarrado'); };
  lienzo.addEventListener('pointerup', suelta); lienzo.addEventListener('pointercancel', suelta);
  lienzo.addEventListener('keydown', (e) => {
    const paso: Record<string, [number, number]> = { ArrowLeft: [12, 0], ArrowRight: [-12, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] };
    const d = paso[e.key]; if (!d) return;
    e.preventDefault(); lon += d[0]; lat = Math.max(-70, Math.min(55, lat + d[1])); tocado = performance.now();
    if (!raf) dibuja(performance.now());
  });

  caja.addEventListener('na:paises', () => { leer(); if (!raf) dibuja(performance.now()); });
  new IntersectionObserver((e) => { visible = e[0].isIntersecting; corre(); }, { rootMargin: '120px' }).observe(caja);
  new ResizeObserver(() => { medir(); if (!raf) dibuja(performance.now()); }).observe(lienzo);
  document.addEventListener('visibilitychange', corre);
  reducido.addEventListener('change', corre);
  leer(); medir(); dibuja(0);
}
