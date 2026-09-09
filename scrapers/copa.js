// scrapers/copa.js
//
// Scraper de tarifa más económica para un tramo/fecha en Copa Airlines.
//
// ESTADO (2026-09-09): sin reconocimiento en vivo todavía. Lo único
// relevado fue el inventario inicial de la home (copaair.com/es-ar/), que
// es una SPA pesada con Material UI:
//   - Origen: input#origin (MUI Autocomplete)
//   - Destino: input#destination (MUI Autocomplete)
//   - Fecha: input#datecalendar-input-big-id, placeholder "Ingresa fechas"
//   - Trip type: botón "Ida y vuelta" (hay que cambiar a solo ida)
//   - Buscar: button#btn-search
//
// TODO — todo lo demás:
//   - Primero revisar si expone un endpoint interno tipo API (buscar en el
//     tráfico de red al hacer una búsqueda real) antes de ir a selectores
//     DOM, mismo criterio que se usó con Aerolíneas Argentinas y Avianca.
//   - Completar el flujo real: origen → destino → solo ida → fecha →
//     buscar → extraer tarifa + hora de salida.
//   - Ojo con el mismo tipo de protección anti-bot que se encontró en
//     Avianca (Akamai) — probar primero si un cliente HTTP directo
//     funciona o si hace falta manejarlo todo desde una página real.

const { chromium } = require("playwright");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function scrapeCopa({ origen, destino, fechaVuelo, tramoId }, opts = {}) {
  const headless = opts.headless ?? (process.env.HEADLESS !== "false");
  const browser = await chromium.launch({ headless, args: ["--disable-blink-features=AutomationControlled"] });
  const timestamp = new Date().toISOString();
  const base = {
    aerolinea: "copa",
    tramo: tramoId,
    fecha: fechaVuelo,
    dias_anticipacion: null,
    tarifa: null,
    moneda: null,
    hora_salida: null,
    timestamp,
    ok: false,
  };

  try {
    const page = await browser.newPage({ userAgent: UA, viewport: { width: 1366, height: 900 } });
    await page.goto("https://www.copaair.com/es-ar/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(8_000);

    throw new Error(
      "Scraper de Copa sin implementar todavía: falta reconocimiento en vivo del flujo de búsqueda. " +
        "Ver TODOs en scrapers/copa.js — correr con headless:false para empezar."
    );
  } catch (err) {
    return { ...base, error: err.message };
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeCopa };
