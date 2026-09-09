// scrapers/copa.js
//
// Scraper de tarifa más económica para un tramo/fecha en Copa Airlines.
//
// ESTADO (2026-09-09): PAUSADO — bloqueo total de DataDome desde la
// primera carga de página, no solo en el flujo de búsqueda.
//
// Reconocimiento hecho: la home (copaair.com/es-ar/) es una SPA con
// Material UI (inputs `#origin`/`#destination`, fecha en
// `#datecalendar-input-big-id`, botón `#btn-search`). Antes de completar
// el flujo real, siguiendo el mismo criterio que funcionó con Avianca
// (buscar API interna antes que pelear con el DOM), se probó cargar la
// home directo: apareció un CAPTCHA explícito de DataDome ("Desliza hacia
// la derecha para asegurar tu acceso") en la carga inicial, ANTES de
// interactuar con el formulario. El propio mensaje del sitio dice
// textualmente que detectó "Actividad automatizada (bot)" y "Uso de
// herramientas de desarrollo o de inspección" — apunta a que DataDome
// está detectando el protocolo CDP que usa Playwright para controlar el
// browser (no un header/flag ajustable), a diferencia del fingerprint de
// Client Hints que se pudo esquivar en Aerolíneas Argentinas y Avianca.
//
// Se vio una API legítima en otro subdominio (`apicm.copaair.com/catalog/
// booking-airports`, catálogo de aeropuertos) que respondió bien incluso
// con el captcha activo — pero no se pudo observar la llamada real de
// precios/calendario porque esa parte del flujo sí queda detrás del
// captcha, y no hay forma de descubrir el endpoint real sin pasar por ahí.
//
// NO SE INTENTÓ resolver/evadir el captcha — completar o esquivar
// CAPTCHAs no es algo que se haga acá, sea cual sea el motivo.
//
// Decisión (2026-09-09): en vez de seguir insistiendo con Copa, se
// prioriza avanzar con Gol/American (etapa 2 del brief) para completar la
// etapa 1 con 3 aerolíneas en vez de pelear un bloqueo total. Retomar acá
// solo si aparece una idea concreta nueva (¿otro punto de entrada?
// ¿agregador?), no repitiendo el mismo intento.

async function scrapeCopa({ origen, destino, fechaVuelo, tramoId }, _opts = {}) {
  const base = {
    aerolinea: "copa",
    tramo: tramoId,
    fecha: fechaVuelo,
    dias_anticipacion: null,
    tarifa: null,
    moneda: null,
    hora_salida: null,
    timestamp: new Date().toISOString(),
    ok: false,
    error:
      "Copa pausado: bloqueo de DataDome (captcha) desde la carga inicial de la página. " +
      "Ver scrapers/copa.js para el detalle — no se intentó evadir el captcha.",
  };
  return base;
}

module.exports = { scrapeCopa };
