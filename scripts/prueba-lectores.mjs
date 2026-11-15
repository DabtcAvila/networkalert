#!/usr/bin/env node
// Prueba de las reglas que deciden si un evento de PayPal sigue abierto (ingest/fuentes.mjs → abiertosPaypal).
// PayPal publica un registro por evento con su último estado en el título; aquí van los casos conocidos.
//   npm run prueba:lectores
import { abiertosPaypal } from '../ingest/fuentes.mjs';
const h = (n) => new Date(Date.now() - n * 3600e3).toUTCString();
const casos = [
  ['Detected Resolved: Impact to Online Checkout (PP-LIVE-1)', h(2), 'Our engineers have resolved the issue', 0],
  ['Resolved: Impact to PayPal Checkout (PP-LIVE-2)', h(2), 'x', 0],
  ['Initial Notification: PayPal Live Site Maintenance (PP-LIVE-3)', h(2), 'x', 0],
  ['Initial Notification: Impact to Online Checkout (PP-LIVE-4)', h(2), 'We are experiencing an outage affecting Online Checkout.', 1],
  ['Update: Impact to Braintree (PP-LIVE-5)', h(5), 'Engineers are investigating.', 1],
  ['Initial Notification: Impact to Payouts (PP-LIVE-6)', h(30), 'viejo', 0],
  ['Initial Notification: Initial Notification: Impact to X (PP-LIVE-7)', h(1), 'investigating', 1],
  ['Completed: Hyperwallet (PP-LIVE-8)', h(1), 'x', 0],
];
let mal = 0;
for (const [titulo, fecha, resumen, esp] of casos) { const r = abiertosPaypal([{ titulo, fecha, resumen, id: 'x', url: '' }]); if (r.length !== esp) { mal++; console.log('MAL', titulo, r); } else console.log('ok ', esp ? 'abierto' : 'cerrado', '|', titulo, r[0] ? `→ «${r[0].nombre}»` : ''); }
process.exit(mal ? 1 : 0);
