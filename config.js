// config.js
// Config central: acá se agregan rutas y aerolíneas a medida que se escala el relevamiento.

module.exports = {
  // Rutas activas (código IATA origen_destino), cada una con las
  // aerolíneas que se relevan EN ESA RUTA (id = clave de SCRAPERS en
  // index.js).
  //   - Avianca y Gol funcionales en EZE<->CCS.
  //   - Laser funcional en CCS<->MIA (API de KIU por HTTP, sin browser;
  //     el vuelo lo opera GlobalX/G6, ver scrapers/laser.js).
  //   - Pausados, no listados: Copa (DataDome, ver scrapers/copa.js) y
  //     American (Akamai 403 en la búsqueda, ver scrapers/american.js).
  rutas: [
    { id: "EZE_CCS", origen: "EZE", destino: "CCS", aerolineas: ["avianca", "gol"] },
    { id: "CCS_EZE", origen: "CCS", destino: "EZE", aerolineas: ["avianca", "gol"] },
    { id: "CCS_MIA", origen: "CCS", destino: "MIA", aerolineas: ["laser"] },
    { id: "MIA_CCS", origen: "MIA", destino: "CCS", aerolineas: ["laser"] },
  ],

  // Ventanas de anticipación en días desde hoy: día 1 a día 30 (uno por
  // día) + un extra a día 60. index.js las convierte a fechas en tiempo de
  // ejecución (no son fechas fijas). Misma ventana para todas las rutas.
  // Total: 31 fechas x (2 rutas x 2 aerolíneas + 2 rutas x 1 aerolínea)
  // = 186 búsquedas por corrida (124 con browser + 62 de Laser por HTTP).
  ventanas: [...Array.from({ length: 30 }, (_, i) => i + 1), 60],

  // Metodología: tarifa más económica visible, SIN impuestos/tasas,
  // consistente con la metodología v2 usada en el fare-tracker doméstico.
  // Laser: base + cargos de la aerolínea (OB + YQ/YR), sin tasas de
  // gobierno — desglose completo en el JSON (ver scrapers/laser.js).
  // Avianca/Gol guardan el precio tal cual lo da su calendario de precios;
  // no está verificado qué recargos/tasas incluye ese número.
  // Nota: ambas aerolíneas devuelven el campo "moneda" del resultado en
  // USD (Avianca nativo; Gol se fuerza a USD vía interceptación de
  // request, ver scrapers/gol.js) — filas históricas previas al cambio
  // quedaron en BRL, documentado en sheets.js/README.
  metodologia: "v2_sin_impuestos",

  outputDir: "./output",
};
