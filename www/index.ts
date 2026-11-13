// www.networkalert.dev → networkalert.dev (301, conserva ruta y parámetros). Worker aparte para que el sitio
// principal siga sirviendo sus páginas como archivos estáticos, sin pasar por código.
export default {
  fetch(request: Request): Response {
    const u = new URL(request.url);
    u.hostname = 'networkalert.dev'; u.protocol = 'https:'; u.port = '';
    return new Response(null, { status: 301, headers: { Location: u.toString(), 'Cache-Control': 'public, max-age=86400', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } });
  },
};
