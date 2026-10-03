// scrapers/gol.js
//
// Scraper de tarifa más económica para un tramo/fecha en Gol Linhas Aéreas.
//
// ESTADO (2026-09-09): funcional para precio. Sin bloqueos de bot-detection
// (a diferencia de Copa) — el sitio (voegol.com.br) es una SPA con Web
// Components (`tgr-*`) pero no tiene WAF/captcha en el flujo de búsqueda.
//
// ESTRATEGIA — API de calendario de precios (`bff-flight.voegol.com.br/
// flightcalendar`), similar en espíritu a la de Avianca:
//   POST con body {baseSelect:{origin,destination}, calendar:{month,quantity,year},
//   currencyCode, pax:{...}} → { calendar: [{data, hasFlight, value}, ...] }
//   para una ventana de `quantity` meses arrancando en el mes pedido.
//
//   A diferencia de Avianca, esta API exige un header `x-aat` (token
//   anti-fraude) generado por JS de la página en cada request — no se
//   pudo replicar ese token con un fetch aislado (ver intento fallido en
//   el historial de commits), así que en vez de pelear con eso se deja
//   que la propia página arme la request real completando el buscador
//   (origen/destino/"Só ida"), y se INTERCEPTA esa request con
//   `page.route()` para reescribir `calendar.month`/`calendar.year` al mes
//   de la fecha que nos interesa — así no hace falta clickear "mes
//   siguiente" en el calendario visual para llegar a noviembre (+60d).
//
//   `currencyCode` se reescribe a "USD" en la misma intercepción que ya se
//   usa para el mes (ver más abajo) — la API lo respeta igual que
//   origin/destination, no hace falta tocar ningún selector de moneda en
//   la UI. Confirmado: pedir USD da valores ~5x menores que BRL,
//   consistentes con el tipo de cambio real (ej. 2070 BRL ≈ 407 USD).
//
// GOTCHA — igual que Avianca: headless:true real es bloqueado (probado:
// con headless:true ni siquiera se pudo interactuar con el formulario;
// con headless:false anda perfecto). Se fuerza headless:false siempre —
// en CI necesita `xvfb-run` (ya configurado en el workflow).
//
// IMPORTANTE — la ruta EZE↔CCS en Gol es ESPARCIDA, no diaria:
//   - EZE→CCS: muy poca frecuencia (2 de 61 días relevados tenían vuelo)
//   - CCS→EZE: más frecuente pero tampoco diaria (~20 de 61 días)
//   Esto es un dato real del sitio, no un error del scraper. Cuando
//   `hasFlight` es false para la fecha pedida, el resultado es ok:true con
//   tarifa:null (se determinó correctamente que ese día no hay vuelo, no
//   es una falla de scraping).
//
// PENDIENTE (no investigado, no bloqueado): hora de salida. No se llegó a
// probar el envío real del formulario (submit + resultados) para ver si
// expone la hora — a diferencia de Avianca/Copa, acá no hay evidencia de
// que esa parte esté bloqueada, así que vale la pena retomarlo si hace
// falta ese dato.

const { chromium } = require("playwright");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Mapeo mínimo código IATA -> fragmento de texto que usa el autocomplete de
// Gol para esa sugerencia (ver header arriba). Ampliar acá si se suman rutas.
const SUGERENCIA_POR_CODIGO = {
  EZE: "Ezeiza - EZE",
  CCS: "Caracas - CCS",
};

async function seleccionarSugerencia(page, inputSelector, codigo) {
  await page.click(inputSelector);
  await page.type(inputSelector, codigo, { delay: 120 });
  await page.waitForTimeout(1800);
  const fragmento = SUGERENCIA_POR_CODIGO[codigo] || codigo;
  const sugerencia = page.locator(`text=${fragmento}`).first();
  if ((await sugerencia.count()) === 0) {
    throw new Error(`No apareció sugerencia para "${codigo}" (buscando texto "${fragmento}")`);
  }
  await sugerencia.click();
  await page.waitForTimeout(1000);
}

async function _scrapeGolOnce({ origen, destino, fechaVuelo, tramoId }) {
  // headless:true falla determinísticamente (ver GOTCHA arriba) — se
  // ignora cualquier opción/env y se fuerza siempre headless:false.
  const browser = await chromium.launch({ headless: false });
  const timestamp = new Date().toISOString();
  const base = {
    aerolinea: "gol",
    tramo: tramoId,
    fecha: fechaVuelo,
    dias_anticipacion: null,
    tarifa: null,
    moneda: null,
    hora_salida: null, // ver "PENDIENTE" arriba — no investigado, no bloqueado
    timestamp,
    ok: false,
  };

  const [y, m] = fechaVuelo.split("-").map(Number);

  try {
    const page = await browser.newPage({ userAgent: UA, viewport: { width: 1280, height: 900 } });

    // Reescribir el POST a flightcalendar para pedir directo el mes de la
    // fecha objetivo (sin depender de qué mes abre el calendario por
    // defecto) y la moneda en USD (por defecto la página pide BRL).
    await page.route("**/flightcalendar", async (route) => {
      const body = JSON.parse(route.request().postData());
      body.calendar.month = m;
      body.calendar.year = y;
      body.currencyCode = "USD";
      await route.continue({ postData: JSON.stringify(body) });
    });

    let calendarData = null;
    page.on("response", async (res) => {
      if (res.url().includes("flightcalendar")) {
        try {
          calendarData = await res.json();
        } catch (_) {}
      }
    });

    await page.goto("https://www.voegol.com.br/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(7_000);

    try {
      const cookieBtn = page.locator('button:has-text("Aceptar todas")').first();
      if ((await cookieBtn.count()) > 0) {
        await cookieBtn.click();
        await page.waitForTimeout(800);
      }
    } catch (_) {}

    await page.locator("text=Ida e volta").first().click({ timeout: 15_000 });
    await page.waitForTimeout(500);
    await page.locator("#opt_oneWay_emission").click();
    await page.waitForTimeout(800);

    await seleccionarSugerencia(page, "#input-saindo-de", origen);
    await seleccionarSugerencia(page, "#input-indo-para", destino);

    await page.click("#departureDate");
    await page.waitForTimeout(3_000);

    if (!calendarData || !Array.isArray(calendarData.calendar)) {
      throw new Error("No se recibió respuesta válida de flightcalendar");
    }

    const entry = calendarData.calendar.find((d) => d.data === fechaVuelo);
    if (!entry) {
      // Dentro del rango del calendario pero sin entrada: sin vuelo ese día.
      const fechas = calendarData.calendar.map((d) => d.data).sort();
      if (fechas.length && fechaVuelo > fechas[0] && fechaVuelo < fechas[fechas.length - 1]) {
        return { ...base, moneda: "USD", ok: true, nota: "sin vuelo para la fecha en el calendario de Gol" };
      }
      throw new Error(
        `Fecha ${fechaVuelo} no está en la ventana que devolvió el calendario (${calendarData.calendar.length} días recibidos)`
      );
    }

    if (!entry.hasFlight) {
      // No es una falla: Gol no opera esta ruta todos los días, se
      // determinó correctamente que no hay vuelo en esta fecha.
      return { ...base, tarifa: null, moneda: "USD", ok: true };
    }

    return { ...base, tarifa: entry.value, moneda: "USD", ok: true };
  } catch (err) {
    return { ...base, error: err.message };
  } finally {
    await browser.close();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Reintentos con backoff: la SPA de Gol (más pesada en Web Components que
// la de Avianca) mostró fallas transitorias de timing en la corrida de
// prueba de 62 combinaciones (3/62 — timeout esperando una sugerencia, o
// la respuesta de flightcalendar no llegó a tiempo). Mismo patrón que
// Aerolíneas Argentinas en el fare-tracker doméstico.
async function scrapeGol(params, _opts = {}) {
  const backoffs = [0, 20_000, 40_000];
  let lastResult;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      console.warn(`[gol] Reintento ${attempt}/2 en ${backoffs[attempt] / 1000}s...`);
      await sleep(backoffs[attempt]);
    }
    lastResult = await _scrapeGolOnce(params);
    if (lastResult.ok) return lastResult;
  }

  return lastResult;
}

module.exports = { scrapeGol };
