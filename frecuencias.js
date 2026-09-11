// frecuencias.js
// Descarga el microdato de "Conectividad Aérea" de ANAC/SIAC (misma fuente
// que pasajeros.js del fare-tracker doméstico), filtra la ruta EZE<->CCS y
// sube (overwrite completo) el histórico de vuelos/pasajeros/asientos por
// aerolínea a la pestaña "Frecuencias" del Sheet "Fare Tracker
// Internacional". Mismo patrón que pasajeros.js: reescribe todo cada
// corrida porque ANAC puede revisar datos de meses pasados.
//
// OJO — hallazgo relevante para interpretar los resultados: en este
// dataset NO hay vuelos NONSTOP registrados para EZE<->CCS desde
// 2023-05-04 (último operado por Aerolíneas Argentinas; antes de eso,
// Conviasa era el operador principal). Ni Avianca ni Gol aparecen nunca en
// esta ruta directa en el histórico completo — consistente con que sus
// itinerarios "EZE→CCS" que vende el scraper de tarifas son en realidad
// vuelos con escala (Avianca vía Bogotá, Gol vía algún hub brasileño), no
// tramos directos. ANAC registra por TRAMO operado, no por itinerario
// vendido, así que esos vuelos con escala no aparecen acá como EZE-CCS
// directo. Por eso hace falta la Parte 2 (Google Flights) para capturar
// la frecuencia real de los itinerarios que efectivamente se venden hoy.

const fs = require("fs");
const https = require("https");
const readline = require("readline");
const { google } = require("googleapis");
const path = require("path");

const ANAC_URL =
  "https://datos.yvera.gob.ar/dataset/c0e7bc3d-553c-405c-8b32-79282b28ffd5" +
  "/resource/aab49234-28c9-48ab-a978-a83485139290/download/base_microdatos.csv";

const CACHE_FILE = path.join(__dirname, "output", "_anac_full.csv");

const SPREADSHEET_ID = "1JZOm3HFYzDAcCQ4GMV3sF77ZOq-GzpB_OPrtVBhxfbE";
const SHEET_NAME = "Frecuencias";
const CREDS_FILE = path.join(__dirname, "credenciales-google.json");

// Códigos OACI: EZE = SAEZ (Ezeiza), CCS = SVMI (Maiquetía/Simón Bolívar).
const ROUTE_MAP = {
  "SAEZ-SVMI": "EZE-CCS",
  "SVMI-SAEZ": "CCS-EZE",
};

// Mismo arranque que el análisis de pasajeros del doméstico.
const FECHA_DESDE = "2025-08-01";

// ── 1. Fuente de datos: cache local o descarga ────────────────────────────────

function openStream() {
  if (fs.existsSync(CACHE_FILE)) {
    const stat = fs.statSync(CACHE_FILE);
    const mb = (stat.size / 1024 / 1024).toFixed(1);
    console.log(`Usando CSV cacheado: ${CACHE_FILE} (${mb} MB, modificado ${stat.mtime.toISOString().slice(0, 10)})`);
    return Promise.resolve(fs.createReadStream(CACHE_FILE));
  }
  console.log("CSV cacheado no encontrado. Descargando base_microdatos.csv de ANAC...");
  return new Promise((resolve, reject) => {
    const req = https.get(ANAC_URL, (res) => {
      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode} al descargar ANAC CSV`));
      resolve(res);
    });
    req.on("error", reject);
  });
}

// ── 2. Parseo y agregación ────────────────────────────────────────────────────

// Columnas del CSV: [0]=indice_tiempo [3]=aerolinea [4]=origen_oaci
// [10]=destino_oaci [16]=pasajeros [17]=asientos [18]=vuelos

function aggregate(stream) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    // key: "YYYY-MM-DD|ruta|aerolinea" → { vuelos, pasajeros, asientos }
    const agg = {};
    let isHeader = true;
    let totalLeidas = 0;

    rl.on("line", (line) => {
      if (isHeader) { isHeader = false; return; }
      if (!line.trim()) return;

      const cols = line.split(",");
      const fecha = cols[0]?.slice(0, 10); // "YYYY-MM-DD"
      if (!fecha || fecha < FECHA_DESDE) return;

      const ruta = ROUTE_MAP[`${cols[4]}-${cols[10]}`];
      if (!ruta) return;

      const aerolinea = cols[3]?.trim();
      if (!aerolinea) return;

      const vuelos = parseInt(cols[18], 10);
      const pasajeros = parseInt(cols[16], 10);
      const asientos = parseInt(cols[17], 10);
      if (isNaN(vuelos) || vuelos <= 0) return;
      if (isNaN(pasajeros) || pasajeros < 0) return;
      if (isNaN(asientos) || asientos <= 0) return;

      const key = `${fecha}|${ruta}|${aerolinea}`;
      if (!agg[key]) agg[key] = { vuelos: 0, pasajeros: 0, asientos: 0 };
      agg[key].vuelos += vuelos;
      agg[key].pasajeros += pasajeros;
      agg[key].asientos += asientos;
      totalLeidas++;
    });

    rl.on("close", () => {
      console.log(`Registros filtrados: ${totalLeidas}`);
      const rows = Object.entries(agg)
        .map(([key, { vuelos, pasajeros, asientos }]) => {
          const [fecha, ruta, aerolinea] = key.split("|");
          const factor_ocupacion =
            asientos > 0 ? Math.round((pasajeros / asientos) * 1000) / 10 : null;
          return { fecha, ruta, aerolinea, vuelos, pasajeros, asientos, factor_ocupacion };
        })
        .sort((a, b) =>
          a.fecha.localeCompare(b.fecha) ||
          a.ruta.localeCompare(b.ruta) ||
          a.aerolinea.localeCompare(b.aerolinea)
        );
      resolve(rows);
    });

    rl.on("error", reject);
  });
}

// ── 3. Sube a Sheets (overwrite completo) ────────────────────────────────────

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

  const header = ["fecha", "ruta", "aerolinea", "vuelos", "pasajeros", "asientos", "factor_ocupacion"];
  const values = [
    header,
    ...rows.map((r) => [
      r.fecha,
      r.ruta,
      r.aerolinea,
      r.vuelos,
      r.pasajeros,
      r.asientos,
      r.factor_ocupacion ?? "",
    ]),
  ];

  const updateRes = await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });

  const celdasActualizadas = updateRes.data.updatedCells;
  console.log(`Sheets API confirmó: ${celdasActualizadas} celdas escritas (${updateRes.data.updatedRows} filas).`);
  return rows.length;
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  try {
    const stream = await openStream();
    const rows = await aggregate(stream);

    if (rows.length === 0) {
      console.warn(
        "No se encontraron vuelos NONSTOP para EZE<->CCS en el período indicado " +
          "(esperable: no hay datos de esta ruta directa desde 2023-05 — ver nota " +
          "al inicio del archivo). La pestaña Frecuencias va a quedar con solo el encabezado."
      );
    }

    const aerolineas = [...new Set(rows.map((r) => r.aerolinea))].sort();
    console.log(`\nAerolíneas distintas encontradas (${aerolineas.length}):`);
    aerolineas.forEach((a) => console.log(`  - ${a}`));
    console.log(`\nTotal filas: ${rows.length}`);

    if (rows.length > 0) {
      console.log("\nMuestra (primeras 3):");
      rows.slice(0, 3).forEach((r) =>
        console.log(`  ${r.fecha} | ${r.ruta} | ${r.aerolinea} | vuelos=${r.vuelos} pax=${r.pasajeros} asientos=${r.asientos} ocupacion=${r.factor_ocupacion}%`)
      );
      console.log("Muestra (últimas 3):");
      rows.slice(-3).forEach((r) =>
        console.log(`  ${r.fecha} | ${r.ruta} | ${r.aerolinea} | vuelos=${r.vuelos} pax=${r.pasajeros} asientos=${r.asientos} ocupacion=${r.factor_ocupacion}%`)
      );
    }

    console.log(`\nSubiendo a Google Sheets (pestaña "${SHEET_NAME}")...`);
    const subidas = await uploadToSheets(rows);
    console.log(`\nEXITO: ${subidas} fila(s) de datos + encabezado escritas en "${SHEET_NAME}".`);
  } catch (err) {
    console.error("Error:", err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
})();
