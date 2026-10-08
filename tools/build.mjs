#!/usr/bin/env node
// Uso:  node tools/build.mjs "<carpeta con las marcas>" [site]
// Recorre MARCA / (categorías...) / "(N) Nombre del producto.png", optimiza las
// fotos a webp y escribe site/data/products.json. Se puede correr las veces que
// quieras: lo que ya está procesado se saltea.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const src = process.argv[2];
const out = path.resolve(process.argv[3] || 'site');
if (!src) {
  console.error('Falta la carpeta de origen.\n  node tools/build.mjs "./Catalogo"');
  process.exit(1);
}

const EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const THUMB = { w: 600, q: 76 };
const FULL = { w: 1400, q: 82 };
const CONCURRENCY = 6;

const slug = (s) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' y ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// "RO Shoes (36-46)" -> "RO Shoes",  "Tops (DEPENDE PROVEEDOR)" -> "Tops"
const cleanFolder = (s) => s.replace(/\s*\([^)]*\)/g, '').trim();

// ---------- tipos (Remeras, Shorts, ...) ----------
const norm = (s) => slug(s).replace(/-/g, ' ');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tiposCfg = JSON.parse(await fs.readFile(new URL('./tipos.json', import.meta.url), 'utf8'));
const rules = tiposCfg.reglas.map((r) => ({
  nombre: r.nombre,
  res: r.palabras.map((w) => new RegExp(`(?: )${escRe(norm(w))}(?:s|es)?(?: )`)),
}));
function classify(category, name) {
  for (const text of [` ${norm(category)} `, ` ${norm(name)} `])
    for (const r of rules) if (r.res.some((re) => re.test(text))) return r.nombre;
  return 'Otros';
}

async function walk(dir, acc = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, acc);
    else if (EXT.has(path.extname(e.name).toLowerCase())) acc.push(p);
  }
  return acc;
}

// Precios opcionales: precios.csv con "marca,numero,precio" (una fila por producto, precio final)
// y precios-usd.csv con "marca,numero,usd" (USD); el precio en pesos se calcula en el sitio
// con la cotización del día y el redondeo de site/config.json.
async function loadPrices() {
  const prices = new Map();
  const usd = new Map();
  const readCsv = async (file, col) => {
    try {
      const txt = await fs.readFile(file, 'utf8');
      for (const line of txt.split(/\r?\n/).slice(1)) {
        const cells = line.split(/[;,]/).map((x) => x?.trim());
        if (!cells[0] || !cells[1] || !cells[col]) continue;
        prices.set(`${slug(cells[0])}:${cells[1]}`, Number(cells[col].replace(/[^\d.]/g, '')));
        usd.set(`${slug(cells[0])}:${cells[1]}`, Number(cells[col].replace(/[^\d.]/g, '')));
      }
    } catch {}
  };
  try {
    const txt = await fs.readFile('precios.csv', 'utf8');
    for (const line of txt.split(/\r?\n/).slice(1)) {
      const [brand, num, price] = line.split(/[;,]/).map((x) => x?.trim());
      if (brand && num && price) prices.set(`${slug(brand)}:${num}`, Number(price.replace(/[^\d.]/g, '')));
    }
  } catch {}
  try {
    const txt = await fs.readFile('precios-usd.csv', 'utf8');
    for (const line of txt.split(/\r?\n/).slice(1)) {
      const [brand, num, usdVal] = line.split(/[;,]/).map((x) => x?.trim());
      if (brand && num && usdVal) usd.set(`${slug(brand)}:${num}`, Number(usdVal.replace(/[^\d.]/g, '')));
    }
  } catch {}
  console.log(`Precios cargados: ${prices.size} (ARS) · ${usd.size} (USD)`);
  return { prices, usd };
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function main() {
  const root = path.resolve(src);
  const files = await walk(root);
  const { prices, usd } = await loadPrices();
  await fs.mkdir(path.join(out, 'img'), { recursive: true });
  await fs.mkdir(path.join(out, 'data'), { recursive: true });

  // Si ya existe products.json, conservamos la clasificación curada de cada producto
  // (id -> tipo). Solo los productos nuevos se clasifican con tools/tipos.json.
  const prevTipo = new Map();
  try {
    const ex = JSON.parse(await fs.readFile(path.join(out, 'data', 'products.json'), 'utf8'));
    for (const p of ex.products || []) if (p.id && p.tipo) prevTipo.set(p.id, p.tipo);
  } catch {}

  const products = [];
  let skipped = 0;

  const jobs = files.flatMap((file) => {
    const rel = path.relative(root, file).split(path.sep);
    const base = path.basename(file, path.extname(file)).trim();
    if (!/[\p{L}\p{N}]/u.test(base)) { skipped++; return []; } // ej. "!!!.png"
    const brandRaw = rel.length > 1 ? rel[0] : 'Varios';
    const catParts = rel.slice(1, -1).map(cleanFolder).filter(Boolean);
    const m = base.match(/^\((\d+)\)\s*(.*)$/);
    const num = m ? Number(m[1]) : null;
    const name = (m ? m[2] : base).replace(/\s+/g, ' ').trim() || base;
    return [{ file, rel: rel.join('/'), brandRaw, category: catParts.join(' / ') || 'General', num, name }];
  });

  let done = 0;
  async function run(job) {
    const stat = await fs.stat(job.file);
    const hash = crypto.createHash('sha1').update(job.rel + stat.size).digest('hex').slice(0, 8);
    const brandSlug = slug(job.brandRaw);
    const id = `${brandSlug}-${job.num ?? 'x'}-${hash}`;
    const thumbRel = `img/${id}-s.webp`;
    const fullRel = `img/${id}.webp`;
    if (!(await exists(path.join(out, thumbRel)))) {
      const img = sharp(job.file, { failOn: 'none' }).rotate();
      await img.clone().resize({ width: THUMB.w, withoutEnlargement: true }).webp({ quality: THUMB.q }).toFile(path.join(out, thumbRel));
      await img.clone().resize({ width: FULL.w, withoutEnlargement: true }).webp({ quality: FULL.q }).toFile(path.join(out, fullRel));
    }
    products.push({
      id, brand: job.brandRaw, brandSlug, category: job.category, tipo: prevTipo.get(id) || classify(job.category, job.name), num: job.num, name: job.name,
      thumb: thumbRel, img: fullRel,
      ...(prices.has(`${brandSlug}:${job.num}`) ? { price: prices.get(`${brandSlug}:${job.num}`) } : {}),
      ...(usd.has(`${brandSlug}:${job.num}`) ? { usd: usd.get(`${brandSlug}:${job.num}`) } : {}),
    });
    if (++done % 50 === 0) console.log(`  ${done}/${jobs.length}`);
  }

  const queue = [...jobs];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const job = queue.shift();
      try { await run(job); } catch (e) { console.warn(`  ✗ ${job.rel}: ${e.message}`); }
    }
  }));

  // orden: marca A-Z, dentro de cada marca los números más altos (más nuevos) primero
  products.sort((a, b) =>
    a.brand.localeCompare(b.brand, 'es') ||
    (b.num ?? -1) - (a.num ?? -1) ||
    a.name.localeCompare(b.name, 'es'));

  // marcas (+ logo si existe en site/logos/<slug>.png|svg|webp|jpg)
  const brandMap = new Map();
  for (const p of products) {
    const b = brandMap.get(p.brandSlug) || { name: p.brand, slug: p.brandSlug, count: 0 };
    b.count++; brandMap.set(p.brandSlug, b);
  }
  const missingLogos = [];
  for (const b of brandMap.values()) {
    for (const ext of ['svg', 'png', 'webp', 'jpg', 'jpeg']) {
      if (await exists(path.join(out, 'logos', `${b.slug}.${ext}`))) { b.logo = `logos/${b.slug}.${ext}`; break; }
    }
    if (!b.logo) missingLogos.push(b.slug);
  }

  // tipos, en el orden de tipos.json; la portada es el producto más nuevo de cada tipo
  const tipoMap = new Map();
  for (const p of products) {
    const t = tipoMap.get(p.tipo) || { name: p.tipo, slug: slug(p.tipo), count: 0, cover: p.thumb, _n: p.num ?? -1 };
    t.count++;
    if ((p.num ?? -1) > t._n) { t.cover = p.thumb; t._n = p.num ?? -1; }
    tipoMap.set(p.tipo, t);
  }
  const rank = (n) => { const i = tiposCfg.orden.indexOf(n); return i < 0 ? 999 : i; };
  const tipos = [...tipoMap.values()].sort((a, b) => rank(a.name) - rank(b.name)).map(({ _n, ...t }) => t);

  await fs.writeFile(
    path.join(out, 'data', 'products.json'),
    JSON.stringify({ generated: new Date().toISOString(), brands: [...brandMap.values()], tipos, products })
  );

  // limpia imágenes huérfanas (productos que ya no están en la carpeta)
  const keep = new Set(products.flatMap((p) => [path.basename(p.thumb), path.basename(p.img)]));
  for (const f of await fs.readdir(path.join(out, 'img'))) {
    if (!keep.has(f)) await fs.rm(path.join(out, 'img', f));
  }

  console.log(`\nListo: ${products.length} productos en ${brandMap.size} marcas${skipped ? ` (${skipped} archivos ignorados)` : ''}.`);
  console.log('\nPor tipo: ' + tipos.map((t) => `${t.name} ${t.count}`).join(' · '));
  const otros = products.filter((p) => p.tipo === 'Otros');
  if (otros.length) {
    console.log(`\n${otros.length} productos quedaron en "Otros". Agregá palabras en tools/tipos.json para clasificarlos. Algunos:`);
    otros.slice(0, 15).forEach((p) => console.log(`  - ${p.brand} / ${p.category} / ${p.name}`));
  }
  if (missingLogos.length) {
    console.log(`\nFaltan logos (guardalos en site/logos/ con estos nombres, .png o .svg):`);
    console.log('  ' + missingLogos.map((x) => x + '.png').join('\n  '));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
