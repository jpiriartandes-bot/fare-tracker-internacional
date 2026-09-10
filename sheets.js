const { google } = require("googleapis");
const path = require("path");

const SPREADSHEET_ID = "1JZOm3HFYzDAcCQ4GMV3sF77ZOq-GzpB_OPrtVBhxfbE";
const SHEET_NAME = "Historico";
const CREDS_FILE = path.join(__dirname, "credenciales-google.json");

// Campos del resultado del scraper -> orden de columnas en el Sheet.
const COL_ORDER = [
  "timestamp",
  "tramo",
  "aerolinea",
  "fecha",
  "dias_anticipacion",
  "tarifa",
  "hora_salida",
  "ok",
];

const HEADER_ROW = [
  "fecha_busqueda",
  "ruta",
  "aerolinea",
  "fecha_vuelo",
  "dias_anticipacion",
  "precio",
  "hora_salida",
  "ok",
];

async function getAuth() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS_FILE,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return auth;
}

// Lee la fila 1 y escribe el encabezado correcto si falta o quedó desactualizado.
async function ensureHeader() {
  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1:Z1`,
  });

  const existing = (res.data.values?.[0] ?? []).map((v) => v.trim());
  const needsUpdate =
    existing.length !== HEADER_ROW.length ||
    HEADER_ROW.some((h, i) => h !== existing[i]);

  if (needsUpdate) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER_ROW] },
    });
    console.log("Google Sheets: encabezado actualizado.");
  }
}

async function appendToSheet(resultados) {
  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const rows = resultados.map((r) =>
    COL_ORDER.map((col) => {
      const v = r[col];
      if (v === null || v === undefined) return "";
      return v;
    })
  );

  const response = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });

  return response.data.updates?.updatedRows ?? rows.length;
}

module.exports = { ensureHeader, appendToSheet };
