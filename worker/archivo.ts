/**
 * Archivo de alertas (D1, tabla `alertas`). Cada alerta se guarda la primera vez que se ve y queda aunque
 * la fuente la retire: es lo que permite una página propia por alerta y los resúmenes por mes.
 *
 * Pensado para la cuota gratuita de D1: por lectura se hace una sola consulta de las alertas abiertas y solo
 * se escribe lo que cambió (alerta nueva, texto o severidad distinta, o alerta que dejó de aparecer).
 */
export type Alerta = { id: string; source: string; category: string; severity: string; title: string; title_es?: string; summary?: string; summary_es?: string; action?: string; escalated_at?: string; url: string; page?: string; published: string; updated?: string; first_seen: string; status: string; countries: string[]; tags: string[]; stale?: boolean; extra?: Record<string, unknown> };
export type Fuente = { id: string; name: string; url: string; license: string; ok: boolean | null };
/** Lo que se guarda en `datos`: la alerta como se vio la última vez, con el nombre y la licencia de su fuente. */
export type Guardada = Alerta & { source_name?: string; source_url?: string; source_license?: string };
export type Fila = { id: string; slug: string; fuente: string; sev: number; sev_max: number; primera: string; actualizada: string; cerrada: string | null; titulo: string; datos: string };

export const ORDEN: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
/** Desde «media» una alerta tiene página indexable y entra al sitemap; las bajas e informativas se guardan pero no se anuncian. */
export const SEV_INDEXABLE = 2;
const MAX_ESCRITURAS = 400;

// Fuentes que reutilizan el mismo identificador en cada episodio (un país con cortes, Stripe degradado):
// en el archivo cada episodio lleva el día en que empezó, para que uno nuevo no pise al anterior.
const RECURRENTES = new Set(['ioda', 'status-stripe']);
export const idArchivo = (a: Pick<Alerta, 'id' | 'source' | 'first_seen'>) => (RECURRENTES.has(a.source) ? `${a.id}:${String(a.first_seen).slice(0, 10)}` : a.id);
/** Parte final de la dirección de la página: /alerta/<slug>. */
export const slugDe = (a: Pick<Alerta, 'id' | 'source' | 'first_seen'>) =>
  idArchivo(a).toLowerCase().replace(/^ghsa:ghsa-/, 'ghsa-').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
export const SLUG_VALIDO = /^[a-z0-9][a-z0-9-]{1,119}$/;

// Huella del contenido que se muestra: si no cambia, no se escribe. No incluye `published` ni `stale`, que varían solos.
function huella(a: Alerta): string {
  const t = JSON.stringify([a.severity, a.status, a.title, a.title_es, a.summary, a.summary_es, a.action, a.url, a.updated, a.countries, a.tags, a.escalated_at, a.extra]);
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${(h >>> 0).toString(36)}.${t.length.toString(36)}`;
}

/** Guarda lo nuevo y lo que cambió, y marca como cerradas las alertas que ya no vienen. Devuelve cuántas filas escribió. */
export async function archiva(db: D1Database, s: { generated_at: string; alerts: Alerta[]; sources: Fuente[] }): Promise<{ guardadas: number; cerradas: number }> {
  const abiertas = new Map(((await db.prepare('SELECT id, huella FROM alertas WHERE cerrada IS NULL').all<{ id: string; huella: string }>()).results ?? []).map((f) => [f.id, f.huella]));
  const fuentes = new Map(s.sources.map((f) => [f.id, f]));
  const guarda = db.prepare(`INSERT INTO alertas (id, slug, fuente, categoria, sev, sev_max, paises, publicada, primera, actualizada, titulo, huella, datos)
    VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
    ON CONFLICT (id) DO UPDATE SET sev = excluded.sev, sev_max = MIN(alertas.sev_max, excluded.sev), paises = excluded.paises, publicada = excluded.publicada,
      actualizada = excluded.actualizada, titulo = excluded.titulo, huella = excluded.huella, datos = excluded.datos, cerrada = NULL`);
  const cierra = db.prepare('UPDATE alertas SET cerrada = ?1 WHERE id = ?2 AND cerrada IS NULL');
  const vivas = new Set<string>(), ops: D1PreparedStatement[] = [];
  let guardadas = 0;
  for (const a of s.alerts) {
    const id = idArchivo(a);
    vivas.add(id);
    if (a.stale) continue; // la fuente falló: se deja lo último que se guardó
    const h = huella(a);
    if (abiertas.get(id) === h || ops.length >= MAX_ESCRITURAS) continue;
    const f = fuentes.get(a.source);
    const datos: Guardada = { ...a, source_name: f?.name, source_url: f?.url, source_license: f?.license };
    ops.push(guarda.bind(id, slugDe(a), a.source, a.category, ORDEN[a.severity] ?? 4, a.countries.length ? `,${a.countries.join(',')},` : '', a.published, a.first_seen, s.generated_at, (a.title_es ?? a.title).slice(0, 300), h, JSON.stringify(datos)));
    guardadas++;
  }
  let cerradas = 0;
  for (const id of abiertas.keys()) if (!vivas.has(id) && ops.length < MAX_ESCRITURAS) { ops.push(cierra.bind(s.generated_at, id)); cerradas++; }
  for (let i = 0; i < ops.length; i += 40) await db.batch(ops.slice(i, i + 40));
  return { guardadas, cerradas };
}

const COLUMNAS = 'id, slug, fuente, sev, sev_max, primera, actualizada, cerrada, titulo, datos';
export async function porSlug(db: D1Database, slug: string): Promise<Fila | null> {
  return db.prepare(`SELECT ${COLUMNAS} FROM alertas WHERE slug = ?1 ORDER BY primera DESC LIMIT 1`).bind(slug).first<Fila>();
}

export type Renglon = Pick<Fila, 'slug' | 'fuente' | 'sev_max' | 'primera' | 'cerrada' | 'titulo'>;
/** Alertas vistas por primera vez en un mes (AAAA-MM, UTC), de la más reciente a la más antigua. */
export async function delMes(db: D1Database, mes: string): Promise<Renglon[]> {
  const [a, m] = mes.split('-').map(Number);
  const fin = `${m === 12 ? a + 1 : a}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`;
  return (await db.prepare('SELECT slug, fuente, sev_max, primera, cerrada, titulo FROM alertas WHERE primera >= ?1 AND primera < ?2 AND sev_max <= ?3 ORDER BY primera DESC LIMIT 1500')
    .bind(mes, fin, SEV_INDEXABLE).all<Renglon>()).results ?? [];
}

export async function paraSitemap(db: D1Database): Promise<{ slug: string; actualizada: string }[]> {
  return (await db.prepare('SELECT slug, actualizada FROM alertas WHERE sev_max <= ?1 ORDER BY primera DESC LIMIT 40000').bind(SEV_INDEXABLE).all<{ slug: string; actualizada: string }>()).results ?? [];
}
