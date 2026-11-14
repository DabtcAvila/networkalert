export const SITE = {
  name: 'Network Alert',
  url: 'https://networkalert.dev',
  lema: 'Lo que hoy puede tumbar tu sitio, en una sola página.',
  descripcion: 'Recurso público y gratuito: vulnerabilidades explotadas, caídas de plataformas y cortes de Internet en el mundo y en México, con fuente enlazada y actualizado cada 10 minutos.',
  contacto: 'contacto@networkalert.dev',
  seguridad: 'seguridad@networkalert.dev',
  repo: 'https://github.com/DabtcAvila/networkalert',
};

// Donaciones: montos sugeridos en pesos. El cobro lo crea el Worker en Mercado Pago (POST /api/donar).
export const DONAR = { montos: [50, 100, 200, 500], minimo: 20, maximo: 20_000 };

export const NAV = [
  { href: '/alertas', label: 'Alertas' },
  { href: '/mexico', label: 'México' },
  { href: '/revisar', label: 'Revisa tu dominio' },
  { href: '/mi-lista', label: 'Mi lista' },
  { href: '/guia', label: 'Qué vigilar' },
  { href: '/fuentes', label: 'Fuentes' },
  { href: '/api', label: 'API' },
];
