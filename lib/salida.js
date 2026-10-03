// lib/salida.js
// Salida de los estudios: columnas comunes, CSV propio de cada estudio y
// escritura en Google Sheets (una hoja por estudio) a medida que avanza.
//
// "Historico" está CONGELADA: nada de acá la toca. Tampoco se toca
// "Frecuencias" (frecuencias.js); "Frecuencias_Futuras" la reescribe
// subirFrecuencias() solo cuando el estudio EZE-CCS lo pide.

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const SPREADSHEET_ID = "1JZOm3HFYzDAcCQ4GMV3sF77ZOq-GzpB_OPrtVBhxfbE";
const CREDS_FILE = path.join(__dirname, "..", "credenciales-google.json");

// Mismas columnas, mismo orden, en las 3 hojas y en los 3 CSV.
const COLUMNAS = [
  "fecha_busqueda",
  "ruta",
  "fecha_vuelo",
  "dias_anticipacion",
  "aerolinea",
  "tarifa", // nombre de la familia; vacío si no aplica
  "precio",
  "moneda",
  "incluye_tasas", // si / no (vacío: no verificado)
  "total_con_tasas",
  "disponible", // si / no (vacío: la fuente falló, ver nota)
  "hora_salida",
  "hora_llegada",
  "escalas",
  "aeropuertos_escala",
  "duracion_total_min",
  "conexion_min",
  "horas_vuelo_min", // duracion_total_min - conexion_min
  "operador",
  "numero_vuelo",
  "fuente", // sitio_aerolinea | google_flights
  "nota",
];

// Fila completa con todas las columnas (las que no vienen quedan vacías).
function fila(campos) {
  const f = {};
  for (const c of COLUMNAS) f[c] = campos[c] ?? "";
  return f;
}

const aValores = (f) => COLUMNAS.map((c) => f[c]);

// ── CSV ────────────────────────────────────────────────────────────────────

const csvCampo = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function appendCsv(csvPath, filas) {
  if (!filas.length) return;
  const existe = fs.existsSync(csvPath);
  const lineas = filas.map((f) => aValores(f).map(csvCampo).join(",")).join("\n");
  fs.appendFileSync(csvPath, (existe ? "" : COLUMNAS.join(",") + "\n") + lineas + "\n");
}

// ── Google Sheets ──────────────────────────────────────────────────────────

function clienteSheets() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS_FILE,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reintenta ante cuota (429) y errores 5xx de la API.
async function conReintentos(fn) {
  for (let intento = 1; ; intento++) {
    try {
      return await fn();
    } catch (err) {
      const code = err.code ?? err.response?.status;
      const reintentable = code === 429 || (code >= 500 && code < 600);
      if (!reintentable || intento >= 4) throw err;
      await sleep(intento * 15_000);
    }
  }
}

// Crea la hoja si no existe y deja el encabezado correcto en la fila 1.
async function prepararHoja(hoja) {
  const sheets = clienteSheets();
  const meta = await conReintentos(() => sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID }));
  if (!meta.data.sheets.some((s) => s.properties.title === hoja)) {
    await conReintentos(() =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: hoja } } }] },
      })
    );
    console.log(`Google Sheets: hoja "${hoja}" creada.`);
  }
  const res = await conReintentos(() =>
    sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${hoja}'!A1:Z1` })
  );
  const existente = (res.data.values?.[0] ?? []).map((v) => String(v).trim());
  if (existente.length !== COLUMNAS.length || COLUMNAS.some((c, i) => c !== existente[i])) {
    await conReintentos(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${hoja}'!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [COLUMNAS] },
      })
    );
    console.log(`Google Sheets: encabezado de "${hoja}" actualizado.`);
  }
}

async function appendHoja(hoja, filas) {
  const sheets = clienteSheets();
  const r = await conReintentos(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${hoja}'!A1`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: filas.map(aValores) },
    })
  );
  return r.data.updates?.updatedRows ?? filas.length;
}

// Frecuencias_Futuras: overwrite completo (la corrida entera, de una vez:
// escribirla por partes la dejaría a medias si el job se corta).
const HOJA_FRECUENCIAS = "Frecuencias_Futuras";
async function subirFrecuencias(rows) {
  const sheets = clienteSheets();
  const meta = await conReintentos(() => sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID }));
  if (!meta.data.sheets.some((s) => s.properties.title === HOJA_FRECUENCIAS)) {
    await conReintentos(() =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: HOJA_FRECUENCIAS } } }] },
      })
    );
  }
  await conReintentos(() =>
    sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `${HOJA_FRECUENCIAS}!A:Z` })
  );
  const header = ["fecha_busqueda", "ruta", "fecha_vuelo", "aerolinea", "hora_salida", "hora_llegada", "escalas", "precio_gf", "moneda", "fuente"];
  const values = [
    header,
    ...rows.map((r) => [
      r.fecha_busqueda, r.ruta, r.fecha_vuelo, r.aerolinea ?? "", r.hora_salida ?? "", r.hora_llegada ?? "",
      r.escalas, r.precio_gf ?? "", r.moneda, r.fuente,
    ]),
  ];
  const res = await conReintentos(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${HOJA_FRECUENCIAS}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    })
  );
  console.log(`Sheets API confirmó: ${res.data.updatedCells} celdas escritas (${res.data.updatedRows} filas).`);
  return rows.length;
}

module.exports = { COLUMNAS, fila, appendCsv, prepararHoja, appendHoja, subirFrecuencias };
