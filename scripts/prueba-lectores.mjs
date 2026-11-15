#!/usr/bin/env node
// Pruebas de reglas del recolector (ingest/fuentes.mjs): qué evento de PayPal sigue abierto, cómo se arma el título
// de una falla en ataque y qué riesgo se dice según el tipo de falla.
// PayPal publica un registro por evento con su último estado en el título; aquí van los casos conocidos.
//   npm run prueba:lectores
import { abiertosPaypal, nombreKev, riesgoKev } from '../ingest/fuentes.mjs';
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

// Títulos de fallas en ataque (CISA KEV): «Producto: tipo de falla».
const titulos = [
  [{ vendorProject: 'Google', product: 'Chromium', vulnerabilityName: 'Google Chromium Use-After-Free Vulnerability' }, 'Google Chromium: Use-After-Free'],
  [{ vendorProject: 'Apple', product: 'Multiple Products', vulnerabilityName: 'Apple Multiple Products Improper Authentication Vulnerability' }, 'Apple (varios productos): Improper Authentication'],
  [{ vendorProject: 'PHP Group', product: 'PHP', vulnerabilityName: 'PHP Group PHP Use-After-Free Vulnerability' }, 'PHP: Use-After-Free'],
  [{ vendorProject: 'WordPress', product: 'WordPress Core', vulnerabilityName: 'WordPress Core Time-of-check Time-of-use (TOCTOU) Race Condition Vulnerability' }, 'WordPress Core: Time-of-check Time-of-use (TOCTOU) Race Condition'],
  [{ vendorProject: 'Collabora', product: 'Collabora Online – Built-in CODE Server', vulnerabilityName: 'Collabora Online – Built-in CODE Server OS Command Injection Vulnerability' }, 'Collabora Online – Built-in CODE Server: OS Command Injection'],
  [{ vendorProject: 'Barracuda Networks', product: 'Barracuda Email Security Gateway (ESG)', vulnerabilityName: 'Barracuda Networks Email Security Gateway (ESG) Authentication Bypass Vulnerability' }, 'Barracuda Networks: Email Security Gateway (ESG) Authentication Bypass'],
  [{ vendorProject: 'Microsoft', product: 'Office', vulnerabilityName: 'Microsoft Office Outlook Missing User Interaction Vulnerability' }, 'Microsoft Office: Outlook Missing User Interaction'],
  [{ vendorProject: 'Adobe', product: 'Commerce and Magento', vulnerabilityName: 'Adobe Commerce and Magento Unrestricted Upload of File with Dangerous Type Vulnerability' }, 'Adobe Commerce y Magento: Unrestricted Upload of File with Dangerous Type'],
  [{ vendorProject: 'GPUStack', product: 'GPUStack', vulnerabilityName: 'GPUStack Improper Authentication Vulnerability' }, 'GPUStack: Improper Authentication'],
  [{ vendorProject: 'Broadcom', product: 'VMware ESX', vulnerabilityName: 'Broadcom VMWare ESX Insufficient Logging Vulnerability' }, 'Broadcom VMware ESX: Insufficient Logging'],
];
for (const [v, esp] of titulos) { const r = nombreKev(v); if (r !== esp) { mal++; console.log('MAL', v.vulnerabilityName, '→', r, '| se esperaba', esp); } else console.log('ok  título |', r); }

// Riesgo según el tipo de falla: lo claro se dice, lo ambiguo no.
const riesgos = [[['CWE-78'], /ejecutar sus propias órdenes en el equipo afectado/], [['CWE-427'], /en lugar del legítimo/], [['CWE-340'], /adivinar/], [['CWE-367'], null], [['CWE-20'], null], [[], null]];
for (const [cwes, esp] of riesgos) { const r = riesgoKev(cwes); if (esp ? !esp.test(r ?? '') : r !== null) { mal++; console.log('MAL riesgo', cwes, '→', r); } else console.log('ok  riesgo |', cwes.join(',') || '(sin tipo)', '→', r ?? 'no se dice nada'); }

process.exit(mal ? 1 : 0);
