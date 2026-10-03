// scrapers/avianca.js
//
// Scraper de tarifa más económica para un tramo/fecha en Avianca.
//
// ESTADO (2026-09-09): funcional para PRECIO. Hora de salida NO disponible
// por ahora — ver "Bloqueo de hora de salida" abajo.
//
// ESTRATEGIA — API de calendario de precios (no hace falta ni tocar el
// formulario de búsqueda):
//   GET https://www.avianca.com/airmkt/api/pricing/calendar
//       ?tenantId=Avianca&tripType=OW&origin=EZE&destination=CCS
//       &month=MM&year=YYYY&currencyCode=USD
//   → { dayPrices: [{ date: "2026-09-09", price: 1778.7, ... }, ...] }
//   Devuelve precio por día para una ventana de ~40-44 días hacia adelante
//   (arranca en "hoy" si month=mes actual, o en el día 1 del mes pedido si
//   es un mes futuro). Un solo llamado cubre de sobra cualquier fecha
//   dentro de esa ventana — no hace falta iterar el date-picker visual.
//
//   GOTCHA — Akamai Bot Manager: pegarle a esta API con un cliente HTTP
//   directo (curl, o `page.request` de Playwright) da ECONNRESET aunque se
//   manden cookies de sesión reales — Akamai fingerprinta el motor/JS real
//   del browser. La ÚNICA forma que funcionó fue ejecutar `fetch()` DESDE
//   ADENTRO de una página ya navegada (`page.evaluate`), después de dejar
//   unos segundos para que el sensor de Akamai se inicialice. No hace
//   falta interactuar con el formulario (origen/destino/fecha) para esto,
//   simplemente cargar la home alcanza.
//
// BLOQUEO DE HORA DE SALIDA — Imperva WAF en booking.avianca.com:
//   Completar el buscador (origen/destino/"Solo ida"/fecha en el
//   date-picker — selectores: `#origin-desktop`, `#destination-desktop`,
//   `.routes-list-item`, `.month-title` + `.day:not(.disabled) .day-value`
//   dentro de `.calendar-picker-wrapper`, avanzar de mes con
//   `.nav-button.right`) y hacer click en "Buscar" (`.searchbar-bottom-button`)
//   SÍ arma correctamente la URL de resultados:
//     https://booking.avianca.com/av/booking/avail?departureDate=...&from=EZE&to=CCS&...
//   pero navegar ahí da "Acceso denegado (código de error 15)" — un WAF
//   Imperva/Incapsula DISTINTO del Akamai de la home, y más agresivo.
//   Probado sin éxito: spoofear `navigator.webdriver`, sacar el flag
//   `--disable-blink-features=AutomationControlled`, e ir más lento entre
//   acciones. Bloqueó las 3 veces con el mismo código de error. No vale la
//   pena seguir insistiendo con evasión — para conseguir hora_salida hace
//   falta otra estrategia (¿API interna del motor de reservas en vez del
//   WAF de la página?, ¿otro punto de entrada?) a evaluar más adelante.
//   Por ahora `hora_salida` queda siempre `null` para Avianca.
//
// GOTCHA #2 — Akamai bloquea headless:true con 403 (determinístico, no
// intermitente): igual que se encontró en el fare-tracker doméstico con
// Aerolíneas Argentinas, Chromium en modo headless real ("new headless")
// expone "HeadlessChrome" en los Client Hints (Sec-CH-UA) sin importar el
// User-Agent que se mande — y acá Akamai lo usa para bloquear directo con
// 403 en vez de dejar pasar la request. Probado: con headless:false anda
// al toque, con headless:true falla siempre. Por eso este scraper FUERZA
// headless:false sin importar la opción que le pasen. En GitHub Actions
// (sin display) esto necesita correr bajo un framebuffer virtual — ver
// `xvfb-run` en el workflow.

const { chromium } = require("playwright");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function scrapeAvianca({ origen, destino, fechaVuelo, tramoId }, _opts = {}) {
  // headless:true da 403 determinístico contra Akamai (ver GOTCHA #2 arriba)
  // — se ignora cualquier opción/env y se fuerza siempre headless:false.
  const browser = await chromium.launch({ headless: false });
  const timestamp = new Date().toISOString();
  const base = {
    aerolinea: "avianca",
    tramo: tramoId,
    fecha: fechaVuelo,
    dias_anticipacion: null,
    tarifa: null,
    moneda: null,
    hora_salida: null, // ver "Bloqueo de hora de salida" arriba
    timestamp,
    ok: false,
  };

  try {
    const page = await browser.newPage({ userAgent: UA, viewport: { width: 1280, height: 900 } });

    await page.goto("https://www.avianca.com/ar/es/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(6_000); // dejar que el sensor de Akamai se inicialice

    const [y, m] = fechaVuelo.split("-");
    const url =
      `https://www.avianca.com/airmkt/api/pricing/calendar?tenantId=Avianca&tripType=OW` +
      `&origin=${origen}&destination=${destino}&month=${m}&year=${y}&currencyCode=USD`;

    const result = await page.evaluate(async (u) => {
      try {
        const r = await fetch(u, { credentials: "include" });
        return { status: r.status, text: await r.text() };
      } catch (e) {
        return { status: null, text: `FETCH ERROR: ${e.message}` };
      }
    }, url);

    if (result.status !== 200) {
      throw new Error(`API de calendario respondió ${result.status}: ${result.text.slice(0, 200)}`);
    }

    const json = JSON.parse(result.text);
    const entry = (json.dayPrices || []).find((dp) => dp.date === fechaVuelo);
    if (!entry) {
      // Fecha dentro del rango del calendario pero sin entrada: no hay
      // vuelo/precio ese día (2026-10-03: EZE->CCS 14/10 con 325 días
      // recibidos). No es una falla.
      const fechas = (json.dayPrices || []).map((dp) => dp.date).sort();
      if (fechas.length && fechaVuelo > fechas[0] && fechaVuelo < fechas[fechas.length - 1]) {
        return { ...base, moneda: "USD", ok: true, nota: "sin precio para la fecha en el calendario de Avianca" };
      }
      throw new Error(
        `Fecha ${fechaVuelo} no está en la ventana que devolvió el calendario (${(json.dayPrices || []).length} días recibidos)`
      );
    }

    return { ...base, tarifa: entry.price, moneda: "USD", hora_salida: null, ok: true };
  } catch (err) {
    return { ...base, error: err.message };
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeAvianca };
