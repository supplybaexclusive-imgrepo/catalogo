# Catálogo Supply BA

Sitio estático (sin servidor ni base de datos). Se arma solo a partir de tu carpeta de Drive.

## Qué trae
- Inicio con categorías (Remeras, Buzos, Camperas, Pantalones, Shorts, Zapatillas, Gorras, Accesorios...), botones cuadrados de marcas y la sección "Cómo funciona el encargue".
- Catálogo con filtro por tipo y por marca, buscador y ficha de producto con botón de WhatsApp, Instagram y compartir link.
- Cada producto tiene su propio link (para mandárselo a un cliente).

## 1. Configurar (una vez)
Editá `site/config.json`:
- `whatsapp`: tu número con código de país, sin + ni espacios ni 0 ni 15 (ej. `5491122334455`)
- `instagram`: usuario sin @
- `mostrarPrecios`: `true` si querés precios (ver paso 4)
- `mensaje`: texto que le llega a WhatsApp. Variables: `{producto}`, `{codigo}`, `{marca}`
- `logoFondo`: color de fondo de los botones de marcas

## 2. Armar el catálogo
1. Bajá la carpeta de Drive y descomprimila (si Drive la partió en varios zips, juntalos). Tiene que quedar `Catalogo/MARCA/Categoría/(N) Nombre.png`.
2. Instalá Node.js (nodejs.org, versión LTS).
3. Abrí una terminal DENTRO de la carpeta del proyecto (en el Explorador, clic en la barra de dirección, escribí `cmd` y Enter) y corré:
   ```
   npm install
   node tools/build.mjs "./Catalogo"
   ```
4. Al final el script te muestra cuántos productos hay por tipo, los que quedaron en "Otros" y los logos de marca que faltan. Si agregás fotos nuevas, corrés el mismo comando y solo procesa lo nuevo.
5. Probar local: `npx serve site`.

## 3. Sumar productos con un Excel (CSV)

En vez de renombrar fotos a mano, hacés una planilla (la guardás como CSV) y las fotos van todas juntas en una carpeta:

1. Creá la carpeta `tanda_imagenes/` en el proyecto y poné ahí todas las fotos nuevas.
2. Hacé un archivo `tanda.csv` (abrilo con Excel) con encabezado y una fila por producto:

   ```
   marca,numero,nombre,foto,tipo,talles,precio
   Supreme,45,Box Logo Hoodie Black,supreme-45.png,Buzos,M-3XL,75000
   Supreme,46,Box Logo Tee White,supreme-46.png,Remeras,M-2XL,45000
   ```

   - `foto`: nombre exacto del archivo en `tanda_imagenes/` (puede tener o no extensión).
   - `tipo`: opcional; si lo dejás vacío se asigna solo por el nombre (Remeras, Buzos, Zapatillas…).
   - `talles`: opcional, ej. `M-3XL`, `36-46` o `DEPENDE PROVEEDOR`.
   - `precio`: opcional, en pesos.
   Las columnas pueden ir en cualquier orden y faltar (`marca` y `nombre` son obligatorias).
3. Corré:
   ```
   node tools/import.mjs tanda.csv tanda_imagenes
   ```
   Copia cada foto a `Catalogo/MARCA/tipo/(numero) nombre.ext` y guarda tipo/talles/precio para el build.
4. Actualizá el catálogo: `node tools/build.mjs ./Catalogo`.

## 4. Tipos y logos
- **Tipos:** se asignan solos por palabras del nombre de la carpeta y del producto. Para corregir o sumar palabras, editá `tools/tipos.json` y volvé a correr el build.
- **Logos de marcas:** ya vienen cargados los 13 en `site/logos/`. Para sumar o cambiar uno, guardalo ahí con el nombre de la marca en minúsculas y con guiones (ej. `rick-owens`) (`.webp`, `.png` o `.svg`, cuadrado y con su fondo). No hace falta correr el build. Si una marca muestra el nombre en texto en vez del logo, el nombre del archivo no coincide con el de la carpeta: el build te muestra el nombre exacto.

## 5. Precios (opcional)

**Sistema USD → pesos:** pasame la lista en USD y el sitio la muestra en pesos, con la cotización del día y redondeada.

1. Exportá tu Excel a `precios-usd.csv` (misma carpeta) con encabezado `marca,numero,usd`:
   ```
   marca,numero,usd
   Rick Owens,79,33
   Nike,12,96
   ```
   El número es el del paréntesis del nombre de la foto, ej. `(79) Nombre.png`. El build también acepta `precios.csv` con precio final en pesos (`marca,numero,precio`).
2. Corré el build: `node tools/build.mjs ./Catalogo`.
3. En `site/config.json`:
   ```json
   "precios": { "mostrar": true, "usdCotizacion": 0, "redondeo": 1000 }
   ```
   - `mostrar`: `true` para ver precios.
   - `usdCotizacion`: cotización fija de respaldo. Si dejás `0`, el sitio busca sola la del dólar tarjeta (como la de Lemon) en cada visita y la cachea 6 hs en el navegador.
   - `redondeo`: unidad a la que se redondea para arriba. Con 1000: 33 usd × 1640 = 54120 → $55.000.

El precio aparece en las tarjetas, en la ficha (pesos con su equivalencia US$) y se suma en el carrito como *Total estimado*. Al enviar por WhatsApp va incluido renglón por renglón.

## 6. Talles
Los talles se guardan por producto y la ficha muestra chips seleccionables que se mandan junto al pedido (`M`, `L`, `36`, `46`, etc.). Si traen `DEPENDE PROVEEDOR` se muestra "A confirmar por chat".
- Al importarlas por Excel se cargan en la columna `talles` (ver paso 3).
- Si ya están cargados no tenés que hacer nada: el build los conserva.

## 7. Medición y compartir
La web emite eventos en `window.dataLayer` (`select_item`, `add_to_cart`, `begin_checkout`, `share`, `ver_stock`). Para medir conectá Google Tag Manager / GA4 usando esos nombres. Los links a la tienda llevan parámetros `utm_source`/`utm_medium`/`utm_campaign`.

## 8. Textos del encargue
Están en `site/index.html`, dentro de `<section id="encargue">`. Se editan como texto normal.

## 9. Publicar gratis
Netlify: arrastrá la carpeta `site` en app.netlify.com/drop. Cloudflare Pages: Workers & Pages → Create → Pages → Upload assets → carpeta `site`. Para actualizar, volvés a subirla.
