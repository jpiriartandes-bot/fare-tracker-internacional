// scrapers/american.js
//
// Scraper de tarifa más económica para un tramo/fecha en American Airlines.
//
// ESTADO (2026-09-28): PAUSADO — Akamai Bot Manager bloquea la búsqueda
// con 403 "Access Denied", aunque la home carga bien.
//
// Reconocimiento hecho (rutas CCS<->MIA, más rutas de control):
//
//   1. Home (aa.com/homePage.do): carga normal con headless:false. Se ven
//      los POST del sensor de Akamai (/TTevg0.../...) respondiendo 200/201,
//      o sea que la sesión arranca sin captcha ni bloqueo visible.
//
//   2. Deep-link a resultados, navegando DESPUÉS de haber cargado la home:
//        https://www.aa.com/booking/search?locale=en_US&pax=1&adult=1
//          &type=OneWay&searchType=Revenue&carriers=ALL
//          &slices=[{"orig":"MIA","dest":"CCS","date":"2026-10-15",...}]
//      → 403, página "Access Denied" de Akamai (errors.edgesuite.net,
//      referencia #18.90394017.1790614083.5b579a68). Mismo bloqueo en el
//      documento, no un error de la app.
//
//   3. API interna, llamada con fetch() DESDE ADENTRO de la home ya cargada
//      (el mismo truco que destrabó Avianca, ver scrapers/avianca.js):
//      - POST /booking/api/search/itinerary → HTTP 200 pero con
//        { "error": "309", "slices": [] }. Probado con MIA->JFK y MIA->BOG
//        (rutas que AA opera seguro) además de MIA->CCS y CCS->MIA: el
//        error 309 aparece en TODAS. No es "no hay vuelos en la ruta": la
//        API rechaza la sesión (el flujo real pasa por la página de
//        resultados, que es justamente la que Akamai bloquea en el paso 2).
//      - POST /booking/api/search/calendar → 403 Access Denied de Akamai.
//
// A diferencia de Avianca (donde headless:false + fetch in-page alcanzó),
// acá Akamai bloquea el punto de entrada de la búsqueda misma, no solo un
// detalle del fingerprint. NO SE INTENTÓ evadir el bloqueo (spoofing de
// fingerprint, rotación de IP, stealth plugins, etc.) — mismo criterio que
// con Copa.
//
// Decisión (2026-09-28): pausar American y avanzar con Laser en CCS<->MIA.
// Retomar solo con una idea concreta nueva (¿otra fuente/agregador que
// publique tarifas AA para CCS<->MIA?), no repitiendo los mismos intentos.

async function scrapeAmerican({ origen, destino, fechaVuelo, tramoId }, _opts = {}) {
  return {
    aerolinea: "american",
    tramo: tramoId,
    fecha: fechaVuelo,
    dias_anticipacion: null,
    tarifa: null,
    moneda: null,
    hora_salida: null,
    timestamp: new Date().toISOString(),
    ok: false,
    error:
      "American pausado: Akamai bloquea la búsqueda (403 Access Denied en resultados; " +
      "API de itinerarios devuelve error 309). Ver scrapers/american.js — no se intentó evadir el bloqueo.",
  };
}

module.exports = { scrapeAmerican };
