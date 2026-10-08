#!/usr/bin/env node
// Uso:  node tools/import.mjs "tanda.csv" "carpeta de fotos"
// Lee un CSV (exportado desde Excel, con o sin BOM, ; o ,) con columnas:
//   marca, numero, nombre, foto, tipo, talles, precio   (foto y tipo/talles/precio opcionales)
// Copia cada foto a Catalogo/<Marca>/<Tipo o General>/(numero) nombre.ext y guarda
// tipo/talles/precio en tools/curaduria.json para que el build los aplique.
// Después corré:  node tools/build.mjs ./Catalogo

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const DEST = process.env.IMPORT_DEST ? path.resolve(process.env.IMPORT_DEST) : path.resolve(ROOT, 'Catalogo');
const CSV = path.resolve(process.argv[2] || 'tanda.csv');
const FOTOS = process.argv[3] ? path.resolve(process.argv[3]) : null;
const CURA = path.join(here, 'curaduria.json');

const slug = (s) =>
  (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' y ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// parser CSV robusto (comillas, saltos de línea dentro del campo, ; o , según encabezado)
function parseCsv(text) {
  const rows = [];
  let cur = [], field = '', inQ = false;
  let sep = null;
  // detectar separador en la primera línea lógica
  const first = text.split(/\r?\n/)[0];
  if (first.includes(';') && !first.includes(',')) sep = ';'; else sep = ',';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === sep) { cur.push(field); field = ''; }
    else if (ch === '\n') { cur.push(field); field = ''; rows.push(cur); cur = []; }
    else if (ch !== '\r') field += ch;
  }
  if (cur.length) { cur.push(field); rows.push(cur); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function cleanFolder(s) { return (s || '').replace(/\s*\([^)]*\)/g, '').trim(); }

async function main() {
  const text = await fs.readFile(CSV, 'utf8');
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  const header = rows[0].map((h) => slug(h.trim()));
  const idx = {};
  ['marca', 'brand', 'numero', 'num', 'codigo', 'nombre', 'name', 'producto',
    'foto', 'imagen', 'imagenes', 'tipo', 'talles', 'tallas', 'precio', 'price', 'retail']
    .forEach((k) => { const i = header.indexOf(k); if (i >= 0) idx[k] = i; });
  if (idx.marca === undefined || idx.nombre === undefined) {
    console.error('El CSV necesita columnas "marca" y "nombre". Encabezados encontrados: ' + header.join(', '));
    process.exit(1);
  }

  // carpetas de marca existentes -> para no duplicar "Nike" vs "Nike & Jordan"
  let brandDirs = new Map();
  try { brandDirs = new Map((await fs.readdir(DEST)).filter((n) => n[0] !== '.').map((n) => [slug(n), n])); } catch {}

  // curaduría previa (idempotente)
  let cura = { entries: {} };
  try { cura = JSON.parse(await fs.readFile(CURA, 'utf8')); } catch {}
  const entries = cura.entries || (cura.entries = {});

  const lines = rows.slice(1);
  const photos = [];
  if (FOTOS) {
    const walk = async (d) => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else photos.push(p);
      }
    };
    await walk(FOTOS);
  }
  let added = 0, nofoto = 0, warning = [];
  for (const r of lines) {
    const get = (k) => (idx[k] !== undefined ? (r[idx[k]] || '').trim() : '');
    const marca = get('marca');
    const nombre = get('nombre');
    if (!marca || !nombre) continue;
    const num = get('numero');
    const foto = get('foto');
    const tipo = get('tipo');
    const talles = get('talles');
    const precioRaw = get('precio');

    const dirName = brandDirs.get(slug(marca)) || marca;
    brandDirs.set(slug(marca), dirName);
    await fs.mkdir(path.join(DEST, dirName), { recursive: true });

    let src = null, ext = '';
    if (foto) {
      const target = path.basename(foto, path.extname(foto)).toLowerCase();
      const found = photos.filter((p) => {
        const b = path.basename(p, path.extname(p)).toLowerCase();
        return b === target;
      });
      if (found.length === 1) { src = found[0]; ext = path.extname(found[0]); }
      else if (found.length > 1) warning.push(`Foto "${foto}" ambigua (${found.length} archivos) → se omite`);
      else warning.push(`No se encontró la foto "${foto}" en ${FOTOS || '(sin carpeta de fotos)'} → se omite`);
    } else nofoto++; // igual se registra sin foto?

    const nombreFile = nombre.replace(/\s+/g, ' ').trim();
    const catDir = tipo ? cleanFolder(tipo) : 'General';
    const finalName = `${num ? `(${num}) ` : ''}${nombreFile}${src ? ext : ''}`;

    if (src) {
      const destDir = path.join(DEST, dirName, catDir);
      await fs.mkdir(destDir, { recursive: true });
      try {
        await fs.copyFile(src, path.join(destDir, finalName));
      } catch (e) { warning.push(`No se pudo copiar ${src}: ${e.message}`); }
    }

    if (num || tipo || talles || precioRaw) {
      const key = `${slug(dirName)}:${num || 'x'}`;
      const e = entries[key] || (entries[key] = {});
      if (tipo && tipo !== 'General') e.tipo = tipo;
      if (talles) e.talles = talles;
      if (precioRaw) e.precio = Number(String(precioRaw).replace(/[^\d.]/g, ''));
    }
    added++;
  }
  if (nofoto) console.log(`Filas sin columna "foto": ${nofoto} (se registraron talles/tipo/precio igual)`);
  console.log(`Filas procesadas: ${added}`);
  if (warning.length) { console.log('\nAdvertencias:'); warning.slice(0, 20).forEach((w) => console.log('  ⚠ ' + w + (warning.length > 20 ? '' : ''))); if (warning.length > 20) console.log(`  … y ${warning.length - 20} más`); }

  await fs.writeFile(CURA, JSON.stringify(cura, null, 2));
  console.log('\nListo. Ahora corré:  node tools/build.mjs ./Catalogo');
  console.log('(Las fotos que no encontraste, revisálas y volvé a correr este script.)');
}

main().catch((e) => { console.error(e); process.exit(1); });