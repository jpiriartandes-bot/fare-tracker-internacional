// google_flights.js
// Parte 2 del brief de frecuencias: cuántos vuelos hay programados por día
// en EZE<->CCS, de TODAS las aerolíneas juntas (incluida Copa, bloqueada en
// su propio sitio por DataDome — acá no hay ese problema).
//
// ESTRATEGIA: Google Flights no expone una API JSON plana — usa RPCs
// internas ofuscadas tipo protobuf ("batchexecute"). En vez de pelear con
// eso, se aprovecha que la URL de resultados (`/travel/flights/search?tfs=
// <base64>`) es un protobuf simple donde el origen/destino/fecha están en
// texto plano dentro de los bytes. Se armó UNA plantilla por ruta (vía la
// UI real, una sola vez) y de ahí en adelante:
//   1. Se reemplaza la fecha (10 caracteres "YYYY-MM-DD", largo fijo) en el
//      string base64 decodificado — no hace falta recalcular ningún largo
//      de protobuf porque la fecha siempre mide lo mismo.
//   2. Se navega directo a la URL resultante — sin tocar el formulario,
//      sin calendario, sin clicks.
// Esto es sustancialmente más simple y rápido que Avianca/Gol (que sí
// necesitan completar el buscador real). Confirmado con headless:true real
// — a diferencia de Avianca/Gol, Google Flights NO bloquea headless, así
// que este scraper no necesita xvfb-run.
//
// Los resultados vienen todos en ARS (moneda del punto de venta detectado
// por geolocalización/idioma) — no se intentó forzar otra moneda. Esto es
// solo para frecuencias y referencia cruzada, NO para reemplazar las
// tarifas oficiales de Avianca/Gol (pueden tener markup).

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { google } = require("googleapis");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const SPREADSHEET_ID = "1JZOm3HFYzDAcCQ4GMV3sF77ZOq-GzpB_OPrtVBhxfbE";
const SHEET_NAME = "Frecuencias_Futuras";
const CREDS_FILE = path.join(__dirname, "credenciales-google.json");
const OUTPUT_DIR = path.join(__dirname, "output");

// Plantillas capturadas una vez vía la UI real (ver nota arriba). La fecha
// "2026-09-26" dentro de cada una es el placeholder que se reemplaza.
const TEMPLATES = {
  "EZE-CCS": "CBwQAhojEgoyMDI2LTA5LTI2agcIARIDRVpFcgwIAxIIL20vMGZjeWpAAUgBcAGCAQsI____________AZgBAg",
  "CCS-EZE": "CBwQAhojEgoyMDI2LTA5LTI2agwIAxIIL20vMGZjeWpyBwgBEgNFWkVAAUgBcAGCAQsI____________AZgBAg",
};
const TEMPLATE_DATE = "2026-09-26";

// Ventanas de anticipación: mismas 31 fechas que el scraper de tarifas.
const VENTANAS = [...Array.from({ length: 30 }, (_, i) => i + 1), 60];

function b64urlDecode(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function b64urlEncode(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function urlParaFecha(ruta, fechaISO) {
  const buf = b64urlDecode(TEMPLATES[ruta]);
  const idx = buf.toString("latin1").indexOf(TEMPLATE_DATE);
  if (idx === -1) throw new Error(`No se encontró la fecha placeholder en la plantilla de ${ruta}`);
  const nuevoBuf = Buffer.from(buf);
  nuevoBuf.write(fechaISO, idx, "latin1");
  const tfs = b64urlEncode(nuevoBuf);
  return `https://www.google.com/travel/flights/search?tfs=${tfs}&hl=es`;
}

function fechaDesdeHoy(dias) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

async function extraerVuelos(page, { ruta, fechaVuelo, fechaBusqueda }) {
  const raw = await page.$$eval("li.pIav2d", (els) =>
    els
      .filter((el) => el.offsetParent !== null)
      .map((el) => {
        const horaSalida = el.querySelector(".wtdjmc")?.textContent?.trim() || null;
        const horaLlegadaEl = el.querySelector(".XWcVob");
        const horaLlegada = horaLlegadaEl ? horaLlegadaEl.childNodes[0]?.textContent?.trim() : null;
        const escalasTexto = el.querySelector(".VG3hNb")?.textContent?.trim() || "";
        // .JMc5Xc es el primer div de la fila y siempre tiene un aria-label
        // completo (aerolínea, horarios, escalas, precio o "no disponible").
        // Usarlo como fuente única evita perder la aerolínea cuando el
        // precio no está disponible (ver nota en extraerVuelos).
        const masterLabel = el.querySelector(".JMc5Xc")?.getAttribute("aria-label") || "";
        return { horaSalida, horaLlegada, escalasTexto, masterLabel };
      })
  );

  return raw.map((r) => {
    // "Precio total no disponible" es un caso real (sin fare bookeable para
    // esa combinación) — precio_gf queda null a propósito, no es una falla
    // de extracción. La aerolínea sí está siempre presente en el patrón
    // "Vuelo con N escala(s) de X." independientemente del precio.
    const precioMatch = r.masterLabel.match(/A partir de (\d+) pesos argentinos/);
    const precio_gf = precioMatch ? parseInt(precioMatch[1], 10) : null;
    const aerolineaMatch = r.masterLabel.match(/Vuelo con [^.]*?\s+de\s+([^.]+)\./);
    const aerolinea = aerolineaMatch ? aerolineaMatch[1].trim() : null;
    const escalas = /directo|sin escalas/i.test(r.escalasTexto) ? 0 : parseInt(r.escalasTexto, 10) || 0;

    return {
      fecha_busqueda: fechaBusqueda,
      ruta,
      fecha_vuelo: fechaVuelo,
      aerolinea,
      hora_salida: r.horaSalida,
      hora_llegada: r.horaLlegada,
      escalas,
      precio_gf,
      moneda: "ARS",
      fuente: "Google Flights",
    };
  });
}

async function scrapeRutaFecha(browser, ruta, fechaVuelo, fechaBusqueda) {
  const url = urlParaFecha(ruta, fechaVuelo);
  const page = await browser.newPage({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(6_000);
    const vuelos = await extraerVuelos(page, { ruta, fechaVuelo, fechaBusqueda });
    return { ok: true, vuelos };
  } catch (err) {
    return { ok: false, error: err.message, vuelos: [] };
  } finally {
    await page.close();
  }
}

async function uploadToSheets(rows) {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS_FILE,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const tabExists = meta.data.sheets.some((s) => s.properties.title === SHEET_NAME);
  if (!tabExists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET_NAME } } }] },
    });
    console.log(`Pestaña "${SHEET_NAME}" creada.`);
  }

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:Z`,
  });

  const header = ["fecha_busqueda", "ruta", "fecha_vuelo", "aerolinea", "hora_salida", "hora_llegada", "escalas", "precio_gf", "moneda", "fuente"];
  const values = [
    header,
    ...rows.map((r) => [
      r.fecha_busqueda,
      r.ruta,
      r.fecha_vuelo,
      r.aerolinea ?? "",
      r.hora_salida ?? "",
      r.hora_llegada ?? "",
      r.escalas,
      r.precio_gf ?? "",
      r.moneda,
      r.fuente,
    ]),
  ];

  const updateRes = await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });

  console.log(`Sheets API confirmó: ${updateRes.data.updatedCells} celdas escritas (${updateRes.data.updatedRows} filas).`);
  return rows.length;
}

async function main() {
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "false" });
  const fechaBusqueda = new Date().toISOString().slice(0, 10);
  const todasLasFilas = [];
  let fallas = 0;

  try {
    for (const ruta of Object.keys(TEMPLATES)) {
      for (const dias of VENTANAS) {
        const fechaVuelo = fechaDesdeHoy(dias);
        console.log(`Relevando ${ruta} — ${fechaVuelo} (+${dias}d)...`);
        const res = await scrapeRutaFecha(browser, ruta, fechaVuelo, fechaBusqueda);
        if (res.ok) {
          console.log(`  OK: ${res.vuelos.length} vuelo(s) encontrados.`);
          todasLasFilas.push(...res.vuelos);
        } else {
          fallas++;
          console.log(`  FALLÓ: ${res.error}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\nTotal filas (vuelos individuales): ${todasLasFilas.length}. Búsquedas fallidas: ${fallas}.`);

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const jsonPath = path.join(OUTPUT_DIR, `google_flights_${Date.now()}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(todasLasFilas, null, 2));
  console.log(`JSON local: ${jsonPath}`);

  console.log(`\nSubiendo a Google Sheets (pestaña "${SHEET_NAME}")...`);
  const subidas = await uploadToSheets(todasLasFilas);
  console.log(`EXITO: ${subidas} fila(s) escritas en "${SHEET_NAME}".`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
