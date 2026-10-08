#!/usr/bin/env node
// Genera precios.csv (marca,numero,precio) con la lógica costo→retail derivada de BAPE.
// Uso:  node tools/pricing.mjs
//
// Lógica: precio = costo_USD × 1644 × factor(tipo), redondeado a $5.000.
// Los factores de los tipos que BAPE cubre salen de las filas BAPE con RETAIL+COSTO
// (mediana de retail/(costo×1644)); el resto usan el factor observado más cercano.
// BAPE ya está curado a mano -> su RETAIL se respeta tal cual.
// Productos sin costo en la planilla -> quedan sin precio ("Precio a convenir").

import fs from 'node:fs';
import readline from 'node:readline';
import { createRequire } from 'node:module';

const PROD = 'site/data/products.json';
const DIR = 'C:/Users/Indi/Downloads/Sheet con Proovedores y precios';
const OUT_CSV = 'precios.csv';

const IM = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const round5k = (n) => Math.max(5000, Math.round(n / 5000) * 5000);
const slug = (s) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' y ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const norm = (s) => slug(s).replace(/-/g, ' ');
const numFrom = (v) => {
  if (!v) return NaN;
  const s = String(v).replace(/[^0-9.,]/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
};

// Factores derivados de BAPE (mediana retail/(costoUSD*1644)); ver reporte de analyze2.
// Tipos sin dato BAPE → factor razonable (banda de la regla BAPE / mediana observada).
const FACTORES = {
  Remeras: 3.31,
  Buzos: 3.17,
  Shorts: 3.32,
  Zapatillas: 2.21,
  Camperas: 1.78,
  Gorras: 2.07,
  Medias: 1.71,
  Mochilas: 1.99,
  'Riñoneras/Bandoleras': 1.82,
  Pantalones: 2.6,
  Conjuntos: 2.6,
  Faldas: 2.6,
  Accesorios: 2.46,
  Beanies: 1.93,
  Bolsos: 1.89,
  'Ropa interior': 2.0,
  Otros: 2.0,
};

function parseCSV(text) {
  const rows = [];
  let cur = '', field = [], q = false;
  const push = () => { field.push(cur); rows.push(field.map((f) => f.trim())); field = []; cur = ''; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { field.push(cur); cur = ''; }
    else if (c === '\n') { push(); }
    else cur += c;
  }
  if (cur.length || field.length) push();
  return rows.filter((r) => r.some((x) => x));
}

const fileBrand = {
  'adidas': 'adidas', 'balenciaga': 'balenciaga', 'bape': 'bape', 'chrome hearts': 'chrome-hearts',
  'corteiz': 'corteiz', 'der schutze': 'der-schutze', 'hellstar': 'hellstar', 'mm6': 'mm6',
  'nike & jordan': 'nike-y-jordan', 'rick owens': 'rick-owens', 'sp5der': 'sp5der',
  'stussy': 'stussy', 'supreme': 'supreme', 'valley dreams': 'valley-dreams',
};

// 1. Leer planillas y construir filas únicas (slug + nombre normalizado → costo)
const files = fs.readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.csv'));
const rows = [];
for (const f of files) {
  const brandKey = Object.keys(fileBrand).find((k) => f.toLowerCase().includes(k));
  const slugB = fileBrand[brandKey] || f.replace(/^Lista proveedores y productos - /i, '').replace(/ \(\d+\)\.csv$/i, '').toLowerCase();
  const data = parseCSV(fs.readFileSync(`${DIR}/${f}`, 'utf8'));
  for (const r of data.slice(1)) {
    const name = r[0];
    if (!name || !/[A-Za-zÁÉÍÓÚÑáéíóúñÀ-ÿ]/.test(name)) continue;
    rows.push({
      slug: slugB,
      n: norm(name),
      cost: numFrom(r[5]),
      ret: numFrom(r[7]),
      hasCost: !!String(r[5]).trim() && !/VALUE/i.test(String(r[5])),
      hasRet: !!String(r[7]).trim() && !/VALUE/i.test(String(r[7])),
    });
  }
}
const seen = new Set();
const unique = rows.filter((r) => { const k = `${r.slug}|${r.n}`; if (seen.has(k)) return false; seen.add(k); return true; });
const filas = new Map(unique.map((r) => [`${r.slug}|${r.n}`, r]));

// 2. Para cada producto del catálogo, resolver precio
const prods = JSON.parse(fs.readFileSync(PROD, 'utf8')).products;
const lines = [['marca', 'numero', 'precio']];
const resumen = new Map(); // tipo -> {total, estimados, bape, convenir}
let estimados = 0, convenir = 0, conRetail = 0, bapePreservados = 0, sinTipo = 0;

for (const p of prods) {
  const key = `${p.brandSlug}|${norm(p.name)}`;
  const r = filas.get(key);
  const tipo = p.tipo || 'Otros';
  if (!resumen.has(tipo)) resumen.set(tipo, { total: 0, estimados: 0, bape: 0, retail: 0, convenir: 0 });
  const s = resumen.get(tipo);
  s.total++;

  // BAPE cuenta con retail ya curado a mano - preservar
  if (p.brandSlug === 'bape' && r && r.hasRet) {
    s.bape++; conRetail++; bapePreservados++;
    lines.push([p.brandSlug, p.num, r.ret]);
    continue;
  }

  if (!r || !r.hasCost || !isFinite(r.cost) || r.cost <= 0) {
    s.convenir++; convenir++;           // sin costo → "Precio a convenir"
    continue;
  }

  const factor = FACTORES[tipo] ?? 2.0;
  const precio = round5k(r.cost * 1644 * factor);
  s.estimados++; estimados++;
  if (r.hasRet) { s.retail++; conRetail++; }
  lines.push([p.brandSlug, p.num, precio]);
}

// 3. Escribir precios.csv
const csv = lines.map((l) => l.join(',')).join('\n') + '\n';
fs.writeFileSync(OUT_CSV, csv, 'utf8');

console.log(`Productos: ${prods.length}`);
console.log(`  ✓ estimados (costo→BAPE): ${estimados}`);
console.log(`  ✓ con retail (BAPE curado preservado + otros): ${conRetail} (de los cuales BAPE curados: ${bapePreservados})`);
console.log(`  ✗ sin costo → Precio a convenir: ${convenir}`);
console.log(`\nFactores aplicados:`);
for (const [t, f] of Object.entries(FACTORES)) console.log(`  ${t.padEnd(22)} ×${f.toFixed(2)}`);
console.log('\nResumen por tipo (total / estimados / retail / convenir):');
for (const [t, s] of [...resumen.entries()].sort((a, b) => b[1].total - a[1].total))
  console.log(`  ${t.padEnd(22)} total=${String(s.total).padStart(4)} est=${String(s.estimados).padStart(4)} retail=${String(s.retail).padStart(4)} convenir=${String(s.convenir).padStart(4)}`);

console.log(`\nEscribí precios.csv con ${lines.length - 1} filas.`);