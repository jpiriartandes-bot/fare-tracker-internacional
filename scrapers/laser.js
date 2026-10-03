// scrapers/laser.js
//
// Scraper de tarifa más económica para un tramo/fecha en Laser Airlines (QL).
//
// ESTADO (2026-09-28): funcional para PRECIO y HORA DE SALIDA, sin browser.
//
// ESTRATEGIA — API del motor de reservas KIU, por HTTP directo:
//   El sitio de reservas (booking.laserairlines.com) es la SPA de KIU; no
//   tiene WAF ni captcha en la búsqueda. El flujo real son 3 llamadas a
//   ecommerce-prod.kiusys.net, que se pueden replicar con fetch() pelado:
//
//   1. GET  /searchflight/api/v1/init_data/?carrier=ql&app=ecommerce&init_data=1
//      → apps.response... session_key ("backendsearchflight...AAD-...").
//        Es el token de la sesión, se usa como "Authorization: Token <key>".
//   2. POST /searchflight/api/v1/action/
//      body: { state:{}, departure_date:"YYYY-MM-DD", origin, destination,
//              adults:1, ..., country_setting:{USD/PA}, session_key }
//      → registra la búsqueda en la sesión. El `state` que manda la SPA
//        (56 KB, el estado entero de la app) NO hace falta: con {} funciona
//        igual — probado.
//   3. GET  /flightresults/api/v1/configs/
//      → la DISPONIBILIDAD (el nombre engaña): journeys[].fares por familia
//        con base / cargos / impuestos por separado, flights[] con horario,
//        y carousel (±3 días, total más barato disponible).
//   El paso intermedio que hace la SPA (flightresults/.../metasearch_init)
//   no es necesario — probado.
//
//   GOTCHA — sin headers Origin/Referer de booking.laserairlines.com,
//   init_data devuelve 403 ("Page Access Error"). Con esos headers anda.
//
//   NO USAR landings-persistence-prod.kiusys.net/rates: es la API de precios
//   del calendario del widget, pero es un caché — comparada contra la
//   búsqueda real el 2026-09-28 difería en 3 de 5 fechas.
//
// PRECIO QUE SE GUARDA en `tarifa` (criterio acordado 2026-09-28):
//   tarifa base + cargos de la aerolínea, SIN tasas de gobierno.
//     - base: fares[f].total_equivalent_paid
//     - cargos de aerolínea: fees.total_fees (código OB, "ticketing fee")
//       + impuestos con código YQ/YR (recargo de la aerolínea; en CCS<->MIA
//       es un YQ fijo de USD 200 que KIU lista dentro de las "tasas")
//     - todo lo demás en taxes_list es tasa de gobierno (6I IGTF, AK, C2,
//       EU, YN IVA; de EE.UU.: US, XA, XY, YC, AY, XF).
//   OJO: KIU etiqueta varias tasas de gobierno de EE.UU. como "AIRLINE FEE"
//   en tax_code_name — por eso se clasifica por CÓDIGO, nunca por nombre.
//   El desglose completo (base, cargos, tasas, total) va en campos extra
//   del resultado (quedan en el JSON de output) por si cambia el criterio.
//   Ej. real CCS->MIA 2026-09-30, ECONOMY-BASIC: base 188.70 + OB 25 +
//   YQ 200 = 413.70 (total con tasas: 561.23).
//
//   (2026-10-03) Una entrada por familia — ECONOMY-LIGHT, ECONOMY-BASIC y
//   ECONOMY-PLUS —, cada una con su más barata CON ASIENTOS
//   (fares[f].rbd.posting > 0): el sitio muestra como "Agotada" las que
//   tienen posting 0 aunque la API igual devuelva su precio; esas van con
//   disponible=false y sin precio. Resultado: { ok, familias:[...] }.
//   Horarios, duración (journey.order.total_time) y número de vuelo salen
//   de la misma respuesta.
//
// OPERADOR: los vuelos CCS<->MIA que vende Laser los opera GlobalX (código
//   G6, remark "OPERADO POR GLOBAL X"). Se guarda en `operador`.
//
// SIN DISPONIBILIDAD: si no hay vuelo/asiento para la fecha, el paso 3
//   responde HTTP 400 CreatedItineraryException (error_code 0201060, "Can
//   not create an itinerary"). Se registra como ok:true con tarifa:null
//   (igual criterio que Gol cuando no hay vuelo), no como falla.

const API = "https://ecommerce-prod.kiusys.net";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  Origin: "https://booking.laserairlines.com",
  Referer: "https://booking.laserairlines.com/booking/widget?carrier=ql",
};
// Configuración de país/moneda que manda la SPA para USD (punto de venta PA).
const COUNTRY_SETTING_USD = {
  currency_code: "USD",
  default: true,
  device_id: "PTY00QLW03",
  enable: true,
  id: 37,
  iso_country_code: "PA",
  setting: "2bd17390-0b3f-4f8a-835c-f55ee2eb68fd",
  user_id: "PTY00QLEW",
};
// Familias que se relevan, en este orden (una fila por familia).
const FAMILIAS = ["ECONOMY-LIGHT", "ECONOMY-BASIC", "ECONOMY-PLUS"];
const CODIGOS_CARGO_AEROLINEA = new Set(["YQ", "YR"]);
const ERROR_SIN_ITINERARIO = "0201060";

class SinDisponibilidad extends Error {}
class RateLimit extends Error {}

// RATE LIMIT (verificado 2026-09-28): Cloudflare delante de KIU corta con
// HTTP 429 (página HTML, sin Retry-After) después de ~16 búsquedas seguidas
// con sesión nueva cada una y 1.5-3s de pausa, y el bloqueo duró más de
// 30 min. Por eso: una sola sesión reusada entre búsquedas (1 init_data en
// vez de 1 por búsqueda), pausa de 8-15s entre búsquedas, y ante un 429
// espera larga (3 y 5 min) antes de reintentar.
const PAUSA_ENTRE_BUSQUEDAS = [8_000, 15_000];
const ESPERAS_TRAS_429 = [180_000, 300_000];

async function pedir(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(60_000) });
  const txt = await r.text();
  if (r.status === 429) throw new RateLimit(`${url.replace(API, "")} respondió 429 (rate limit de Cloudflare)`);
  if (r.status === 400 && txt.includes(ERROR_SIN_ITINERARIO)) throw new SinDisponibilidad();
  if (!r.ok) throw new Error(`${url.replace(API, "")} respondió ${r.status}: ${txt.slice(0, 200)}`);
  return JSON.parse(txt);
}

// Sesión KIU compartida entre búsquedas. Se descarta ante cualquier falla
// que no sea "sin disponibilidad", así el reintento arranca con una nueva.
let sesion = null;

async function obtenerSesion() {
  if (sesion) return sesion;
  const init = await pedir(`${API}/searchflight/api/v1/init_data/?carrier=ql&app=ecommerce&init_data=1`, {
    headers: HEADERS,
  });
  const key = JSON.stringify(init).match(/"session_key":"([^"]+)"/)?.[1];
  if (!key) throw new Error("init_data no devolvió session_key");
  sesion = { key, busquedas: 0 };
  return sesion;
}

// "00G6_0" -> "G6"
function codigoAerolinea(carrierRef) {
  return (carrierRef ?? "").replace(/^00/, "").replace(/_\d+$/, "") || null;
}

// Desglose de una familia tarifaria (1 adulto).
function desglosar(fare) {
  const base = Number(fare.total_equivalent_paid);
  const fees = Number(fare.fees?.total_fees ?? 0);
  const taxes = (fare.taxes?.taxes_detail ?? []).flatMap((d) => d.taxes_list ?? []);
  const recargo = taxes
    .filter((t) => CODIGOS_CARGO_AEROLINEA.has(t.tax_code))
    .reduce((s, t) => s + Number(t.amount), 0);
  const tasasGobierno = Number(fare.taxes?.total_taxes ?? 0) - recargo;
  const redondear = (n) => Math.round(n * 100) / 100;
  return {
    tarifa: redondear(base + fees + recargo),
    tarifa_base: base,
    cargos_aerolinea: redondear(fees + recargo),
    tasas_gobierno: redondear(tasasGobierno),
    total_con_tasas: Number(fare.average_amount),
  };
}

async function _scrapeLaserOnce({ origen, destino, fechaVuelo, tramoId }) {
  const base = {
    aerolinea: "laser",
    tramo: tramoId,
    fecha: fechaVuelo,
    dias_anticipacion: null,
    tarifa: null,
    moneda: null,
    hora_salida: null,
    operador: null,
    timestamp: new Date().toISOString(),
    ok: false,
  };

  try {
    // 1. sesión (reusada entre búsquedas)
    const s = await obtenerSesion();
    s.busquedas++;
    const sessionKey = s.key;
    const auth = { ...HEADERS, Authorization: `Token ${sessionKey}`, carrier: "ql", lang: "es" };

    // 2. búsqueda
    await pedir(`${API}/searchflight/api/v1/action/`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json;charset=UTF-8" },
      body: JSON.stringify({
        state: {},
        departure_date: fechaVuelo,
        origin: origen,
        destination: destino,
        adults: 1,
        minors: 0,
        infants: 0,
        cabin: "economy",
        country_setting: COUNTRY_SETTING_USD,
        return_date: null,
        session_key: sessionKey,
        device_model: "???",
        device_id: "???",
        device_branding: "???",
        device_os_system_version: 10,
        device_os_system: "Windows",
        agent_preferred_language: "es-VE",
        device_category: "DESKTOP",
        promo_code: "",
      }),
    });

    // 3. disponibilidad
    const { response: r } = await pedir(`${API}/flightresults/api/v1/configs/`, {
      headers: {
        ...auth,
        Referer: `https://booking.laserairlines.com/flightresults/?id_session=${sessionKey}&lang=es&carrier=ql`,
      },
    });

    // Una entrada por familia (FAMILIAS): la más barata CON ASIENTOS entre
    // todos los vuelos del día. Agotada (rbd.posting = 0, el sitio la
    // muestra como "Agotada" aunque la API devuelva precio) -> disponible
    // "no", sin precio.
    const hhmm = (t) => t?.slice(0, 5) ?? null;
    const aMin = (t) => {
      const m = /^(\d+):(\d+)/.exec(t ?? "");
      return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    };
    const familias = FAMILIAS.map((familia) => {
      let mejor = null; // más barata con asientos
      let agotada = null; // primera vista, para los datos del vuelo
      for (const journey of Object.values(r.journeys ?? {})) {
        const vuelo = r.flights?.[journey.flights?.[0]] ?? null;
        for (const [clave, fare] of Object.entries(journey.fares ?? {})) {
          if (clave.replace(/_.*$/, "") !== familia || fare.total_equivalent_paid == null) continue;
          const dato = { vuelo, journey, ...desglosar(fare) };
          if (Number(fare.rbd?.posting) > 0) {
            if (!mejor || dato.tarifa < mejor.tarifa) mejor = dato;
          } else if (!agotada) agotada = dato;
        }
      }
      const e = mejor ?? agotada;
      const vuelo = e?.vuelo;
      const remark = (vuelo?.flight_additional_information?.flight_remarks_list ?? [])
        .map((x) => x.trim())
        .find((x) => /OPERADO POR/i.test(x));
      const escalas = e ? Number(e.journey.order?.total_stops ?? vuelo?.flight_stops ?? 0) : null;
      return {
        familia,
        disponible: !!mejor,
        precio: mejor ? mejor.tarifa : null,
        total_con_tasas: mejor ? mejor.total_con_tasas : null,
        desglose: mejor ? { base: mejor.tarifa_base, cargos_aerolinea: mejor.cargos_aerolinea, tasas_gobierno: mejor.tasas_gobierno } : null,
        hora_salida: hhmm(vuelo?.departure_information?.time),
        hora_llegada: hhmm(vuelo?.arrival_information?.time),
        escalas,
        duracion_total_min: e ? aMin(e.journey.order?.total_time ?? vuelo?.flight_duration) : null,
        numero_vuelo: vuelo?.flight_number ?? null,
        operador: codigoAerolinea(vuelo?.carrier_reference_id),
        operador_nombre: remark ? remark.replace(/^OPERADO PORs*/i, "") : null,
        nota: e ? null : "la familia no figura en la respuesta",
      };
    });
    return { ...base, moneda: "USD", ok: true, familias };
  } catch (err) {
    if (err instanceof SinDisponibilidad) {
      return { ...base, moneda: "USD", ok: true, familias: [], nota: "sin vuelo disponible" };
    }
    sesion = null; // el reintento arranca con sesión nueva
    return { ...base, error: err.message, rateLimit: err instanceof RateLimit };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Reintentos: ante 429 espera larga (ESPERAS_TRAS_429); ante otras fallas
// de red/API, backoff corto (mismo patrón que Gol). "Sin disponibilidad"
// no se reintenta: es ok:true.
async function scrapeLaser(params, _opts = {}) {
  const backoffsCortos = [10_000, 30_000];
  let ultimo;
  for (let intento = 0; intento < 3; intento++) {
    if (intento > 0) {
      const espera = ultimo.rateLimit ? ESPERAS_TRAS_429[intento - 1] : backoffsCortos[intento - 1];
      console.warn(
        `[laser] ${ultimo.rateLimit ? "Rate limit (429)" : "Falla"} — reintento ${intento}/2 en ${espera / 1000}s...`
      );
      await sleep(espera);
    }
    ultimo = await _scrapeLaserOnce(params);
    if (ultimo.ok) break;
  }
  delete ultimo.rateLimit;
  const [min, max] = PAUSA_ENTRE_BUSQUEDAS;
  await sleep(min + Math.random() * (max - min));
  return ultimo;
}

module.exports = { scrapeLaser, desglosar, FAMILIAS };
