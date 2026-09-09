// scrapers/avianca.js
//
// Scraper de tarifa más económica para un tramo/fecha en Avianca.
//
// ESTADO (2026-09-09): reconocimiento parcial hecho con headless:false contra
// el sitio real (avianca.com). Lo que sigue está CONFIRMADO funcionando:
//
//   1. Home: https://www.avianca.com/ar/es/ (redirige a /es/ofertas/ofertas-vuelos)
//   2. Cookies: botón `button:has-text("Aceptar")`
//   3. "Solo ida": `text=Solo ida` (click force, si no el buscador arma ida y vuelta)
//   4. Origen: input `#origin-desktop`, escribir el código IATA, aparecen
//      sugerencias como <li class="routes-list-item"> con texto
//      "Buenos Aires Ezeiza (Argentina) EZE" — click en la primera.
//   5. Destino: mismo patrón, el input parece tomar foco solo tras elegir
//      origen (probar `#destination-desktop` como selector, si no existe
//      buscar el input focuseado).
//
// HALLAZGO CLAVE — API interna de calendario de precios:
//   GET https://www.avianca.com/airmkt/api/pricing/calendar
//       ?tenantId=Avianca&tripType=OW&origin=EZE&destination=CCS
//       &month=MM&year=YYYY&currencyCode=USD
//   → { dayPrices: [{ date: "2026-09-09", price: 1778.7, ... }, ...] }
//   Devuelve precio por día para una ventana de ~40 días hacia adelante
//   desde la fecha de la llamada (parece ignorar bastante el parámetro
//   month/year real, priorizando "hoy + N días"). Esto podría cubrir buena
//   parte de las 31 fechas que necesitamos con muchas menos llamadas que
//   una búsqueda por fecha.
//
//   GOTCHA IMPORTANTE: Avianca usa Akamai Bot Manager. Pegarle a esta API
//   con un cliente HTTP directo (curl, o `page.request` de Playwright) da
//   ECONNRESET aunque se manden las cookies de sesión reales — Akamai
//   fingerprinta el motor/JS real del browser, que esos clientes no
//   replican. La ÚNICA forma que funcionó fue ejecutar `fetch()` DESDE
//   ADENTRO de una página ya navegada, vía `page.evaluate()`. Cualquier
//   implementación tiene que mantener una page real de Playwright viva,
//   no puede ser un cliente HTTP liviano.
//
// TODO — lo que falta para tener esto productivo:
//   - Completar el click en el día del calendario visual (el date-picker
//     de "Ida" no respondió a clicks por texto plano en las pruebas; es un
//     widget custom, hay que inspeccionarlo más — capaz conviene manejar
//     la fecha vía la API de calendario en vez del date-picker visual, y
//     armar la URL de resultados directamente si el sitio lo permite).
//   - Confirmar el endpoint real de resultados de búsqueda (no el
//     calendario) para sacar la tarifa Y la hora de salida — el calendario
//     solo da precio, no hora.
//   - Decidir: ¿nos alcanza con el precio de la API de calendario (sin
//     hora de salida) o vale la pena el costo extra de tiempo de llegar
//     hasta los resultados reales para tener la hora? (evaluar costo en
//     tiempo de corrida, como pide el brief).

const { chromium } = require("playwright");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function dismissCookies(page) {
  try {
    const el = page.locator('button:has-text("Aceptar")').first();
    if ((await el.count()) > 0 && (await el.isVisible())) {
      await el.click();
      await page.waitForTimeout(500);
    }
  } catch (_) {}
}

async function scrapeAvianca({ origen, destino, fechaVuelo, tramoId }, opts = {}) {
  const headless = opts.headless ?? (process.env.HEADLESS !== "false");
  const browser = await chromium.launch({ headless, args: ["--disable-blink-features=AutomationControlled"] });
  const timestamp = new Date().toISOString();
  const base = {
    aerolinea: "avianca",
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

    await page.goto("https://www.avianca.com/ar/es/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(6_000);
    await dismissCookies(page);

    await page.locator("text=Solo ida").click({ force: true });
    await page.waitForTimeout(500);

    await page.click("#origin-desktop");
    await page.fill("#origin-desktop", "");
    await page.type("#origin-desktop", origen, { delay: 100 });
    await page.waitForTimeout(1500);
    await page.locator(".routes-list-item").first().click();
    await page.waitForTimeout(800);

    // TODO: destino + fecha + submit + extracción de tarifa/hora. Ver notas
    // arriba — este es el punto exacto donde quedó el reconocimiento.
    throw new Error(
      "Scraper de Avianca incompleto: falta destino/fecha/submit/extracción. " +
        "Ver TODOs en scrapers/avianca.js — correr con headless:false para continuar."
    );
  } catch (err) {
    return { ...base, error: err.message };
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeAvianca };
