// /quien: pinta el historial de funcionamiento (GET /api/v1/history). Un cuadro por día.
type Dia = { date: string; readings: number; checks: number; checks_late: number; on_time_pct: number | null };
type Historial = { since: string | null; days_recorded: number; totals: { readings: number; checks: number; on_time_pct: number | null }; days: Dia[] };

const resumen = document.getElementById('hist-resumen'), lista = document.getElementById('hist-dias');
const lecturas = (n: number) => `${n.toLocaleString('es-MX')} ${n === 1 ? 'lectura publicada' : 'lecturas publicadas'}`;
const fecha = (d: string) => new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));

if (resumen && lista) {
  fetch('/api/v1/history', { headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then((h: Historial) => {
    if (!h.since || !h.days.length) { resumen.textContent = 'El registro empezó hace muy poco. Vuelve en unos días.'; return; }
    const n = h.days_recorded, pct = h.totals.on_time_pct;
    resumen.textContent = pct === null
      ? `Registro desde el ${fecha(h.since)}: ${lecturas(h.totals.readings)}.`
      : `Desde el ${fecha(h.since)} (${n} ${n === 1 ? 'día' : 'días'}): al día el ${pct.toLocaleString('es-MX')} % del tiempo, con ${lecturas(h.totals.readings)}.`;
    lista.replaceChildren(...[...h.days].reverse().map((d) => {
      const li = document.createElement('li');
      const p = d.on_time_pct;
      li.dataset.estado = p === null ? 'sin' : p >= 99.5 ? 'ok' : p >= 95 ? 'poco' : 'mal';
      li.title = `${fecha(d.date)}: ${p === null ? `${d.readings} lecturas` : `al día el ${p.toLocaleString('es-MX')} % · ${d.readings} lecturas`}`;
      li.setAttribute('aria-label', li.title);
      return li;
    }));
  }).catch(() => { resumen.textContent = 'No se pudo cargar el historial. Intenta más tarde.'; });
}

export {};
