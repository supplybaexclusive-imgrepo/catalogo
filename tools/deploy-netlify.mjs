import { createReadStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = process.cwd();
const SITE_DIR = join(ROOT, "site");
const ZIP = join(ROOT, "supplyba-site.zip");
const TOKEN = process.env.NETLIFY_TOKEN;
const SITE = process.env.NETLIFY_SITE || "supplybaencargos.netlify.app";

if (!TOKEN) {
  console.error("Falta NETLIFY_TOKEN (token de acceso personal de Netlify).");
  process.exit(1);
}

const api = (path) => `https://api.netlify.com/api/v1/sites/${encodeURIComponent(SITE)}${path}`;
const auth = { Authorization: `Bearer ${TOKEN}` };

console.log(`Creando ZIP desde ${SITE_DIR} ...`);
execFileSync(
  "tar",
  ["-a", "-c", "-f", ZIP, "-C", SITE_DIR, "index.html", "404.html", "factura.html", "config.json", "_headers", "manifest.webmanifest", "robots.txt", "sitemap.xml", "data", "img", "logos", "brand"],
  { stdio: "inherit" }
);

console.log(`Subiendo ZIP a ${SITE} ...`);
const res = await fetch(api("/deploys"), {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/zip" },
  body: createReadStream(ZIP),
  duplex: "half",
});

if (!res.ok) {
  console.error(`Error ${res.status}:`, await res.text());
  process.exit(1);
}

let deploy = await res.json();
console.log(`Deploy creado: ${deploy.id} (${deploy.state || "new"})`);

const depUrl = api(`/deploys/${deploy.id}`);
for (let i = 0; i < 80; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const r = await fetch(depUrl, { headers: auth });
  deploy = await r.json();
  console.log(`estado: ${deploy.state}`);
  if (deploy.state === "ready") {
    console.log("Promoviendo a producción ...");
    const rr = await fetch(`${depUrl}/restore`, { method: "POST", headers: auth });
    if (!rr.ok) {
      console.error(`No se pudo promover (${rr.status}):`, await rr.text());
      process.exit(1);
    }
    const pub = await rr.json();
    console.log(`LISTO -> ${pub.ssl_url || pub.url} (producción)`);
    process.exit(0);
  }
  if (deploy.state === "error" || deploy.state === "rejected") {
    console.error(`FALLO: ${deploy.error_message || deploy.state}`);
    process.exit(1);
  }
}

console.error("Timeout esperando el deploy.");
process.exit(1);
