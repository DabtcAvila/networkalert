-- Avisos por correo («Mi lista»). Se aplica con:
--   npx wrangler d1 execute <base> --remote --file worker/esquema.sql
-- Solo se guarda lo necesario para avisar: el correo, la lista y qué se avisó ya. Darse de baja borra todo.

CREATE TABLE IF NOT EXISTS suscripciones (
  id TEXT PRIMARY KEY,               -- llave aleatoria; va en los enlaces del correo
  correo TEXT NOT NULL UNIQUE,
  config TEXT NOT NULL,              -- JSON: { proveedores, palabras, dominios }
  pendiente TEXT,                    -- cambio pedido sin la llave, a la espera de confirmación por correo
  confirmada INTEGER NOT NULL DEFAULT 0,
  creada TEXT NOT NULL,
  ultimo_correo TEXT,                -- último correo de confirmación enviado (freno contra abuso)
  avisado_hasta TEXT,                -- las alertas vistas después de este momento aún no se avisan
  dia TEXT,
  correos_dia INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS vigilancias (
  sus TEXT NOT NULL,
  dominio TEXT NOT NULL,
  avisado TEXT NOT NULL DEFAULT '{}', -- JSON: hallazgos ya avisados { llave: nivel }
  primera INTEGER NOT NULL DEFAULT 1, -- 1 = aún no se envía el primer reporte
  PRIMARY KEY (sus, dominio)
);
CREATE INDEX IF NOT EXISTS vigilancias_dominio ON vigilancias (dominio);

CREATE TABLE IF NOT EXISTS dominios (
  dominio TEXT PRIMARY KEY,
  revisado TEXT,                      -- última revisión
  dudas INTEGER NOT NULL DEFAULT 0    -- revisiones seguidas en que el sitio no abrió (se avisa a la segunda)
);

-- Frenos contra abuso del cobro de donaciones: solo contadores (por huella del día y por hora), sin datos personales.
CREATE TABLE IF NOT EXISTS frenos (
  clave TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0,
  creado TEXT NOT NULL
);

-- Historial público de funcionamiento: por día, cuántas lecturas se publicaron y cuántas veces el dato estaba atrasado.
CREATE TABLE IF NOT EXISTS historial (
  dia TEXT PRIMARY KEY,                 -- AAAA-MM-DD (UTC)
  lecturas INTEGER NOT NULL DEFAULT 0,  -- instantáneas publicadas
  con_fallas INTEGER NOT NULL DEFAULT 0,-- de esas, cuántas con alguna fuente que no respondió
  revisiones INTEGER NOT NULL DEFAULT 0,-- veces que el reloj (cada 5 min) miró la edad del dato
  atrasadas INTEGER NOT NULL DEFAULT 0  -- de esas, cuántas con el dato de más de 30 minutos
);
