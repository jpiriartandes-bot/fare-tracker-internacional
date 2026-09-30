// scrapers/latam.js
//
// Scraper de tarifa más económica para un tramo/fecha en LATAM (BUE<->MIA).
//
// ESTADO (2026-09-29): PAUSADO — Akamai Bot Manager bloquea la búsqueda
// con 403 "Access Denied", aunque la página de resultados carga bien.
//
// Punto de entrada previsto (sin formulario, precios en USD):
//   https://www.latamairlines.com/us/en/flight-offers
//     ?origin=BUE&outbound=YYYY-MM-DD&destination=MIA&adt=1&cabin=Economy&trip=OW
//   BUE es el código de ciudad: devuelve vuelos desde EZE y AEP. Todos los
//   vuelos BUE-MIA son con escala en Lima, operados por LATAM Airlines Perú.
//   La página es Next.js SSR y los vuelos se cargan client-side: cards con
//   data-testid="wrapper-card-flight-N" y textos para lector de pantalla
//   con hora, precio, operador y paradas.
//
// Reconocimiento con Playwright (Chromium, headless:false, como Avianca/Gol):
//
//   1. Deep-link directo a flight-offers (BUE->MIA y MIA->BUE, +15 días):
//      el documento responde 200, pero el XHR que trae los vuelos,
//        GET /bff/air-offers/v2/offers/search?...
//      responde 403 con la página "Access Denied" de Akamai. La app muestra
//      "The search is taking longer than usual" y nunca aparecen las cards.
//
//   2. Cargar primero la home (latamairlines.com/us/en), esperar 10s a que
//      se inicialice el sensor de Akamai y recién ahí navegar al deep-link
//      (el truco que destrabó Avianca): mismo 403 en offers/search.
//
//   3. GET /bff/air-offers/v2/calendar?origin=BUE&destination=MIA&month=..
//      responde 200, pero sin precios (minimum/maximum null,
//      detailsCalendar vacío) — no sirve como fuente alternativa.
//
// NO SE INTENTÓ evadir el bloqueo (spoofing de fingerprint, stealth
// plugins, rotación de IP, etc.) — mismo criterio que con Copa y American.
//
// Decisión (2026-09-29): pausar LATAM. Las rutas EZE<->MIA no quedan
// listadas en config.js (igual que Copa/American) para no sumar 62 filas
// fallidas por corrida. Retomar solo con una idea concreta nueva.

async function scrapeLatam({ origen, destino, fechaVuelo, tramoId }, _opts = {}) {
  return {
    aerolinea: "latam",
    tramo: tramoId,
    fecha: fechaVuelo,
    dias_anticipacion: null,
    tarifa: null,
    moneda: null,
    hora_salida: null,
    timestamp: new Date().toISOString(),
    ok: false,
    error:
      "LATAM pausado: Akamai bloquea la búsqueda (403 Access Denied en /bff/air-offers/v2/offers/search). " +
      "Ver scrapers/latam.js — no se intentó evadir el bloqueo.",
  };
}

module.exports = { scrapeLatam };
