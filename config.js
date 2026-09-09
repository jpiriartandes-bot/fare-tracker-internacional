// config.js
// Config central: acá se agregan rutas y aerolíneas a medida que se escala el relevamiento.

module.exports = {
  // Rutas activas (código IATA origen_destino)
  rutas: [
    { id: "EZE_CCS", origen: "EZE", destino: "CCS" },
    { id: "CCS_EZE", origen: "CCS", destino: "EZE" },
  ],

  // Avianca y Gol funcionales. Copa pausado (bloqueo total de DataDome,
  // ver scrapers/copa.js). American Airlines (etapa 2) sin relevar todavía.
  aerolineas: ["avianca", "gol"],

  // Ventanas de anticipación en días desde hoy: día 1 a día 30 (uno por
  // día) + un extra a día 60. index.js las convierte a fechas en tiempo de
  // ejecución (no son fechas fijas). Total: 31 fechas x 2 rutas x 2
  // aerolíneas activas = 124 búsquedas por corrida.
  ventanas: [...Array.from({ length: 30 }, (_, i) => i + 1), 60],

  // Metodología: tarifa más económica visible, SIN impuestos/tasas,
  // consistente con la metodología v2 usada en el fare-tracker doméstico.
  // Nota: cada aerolínea devuelve su propia moneda nativa en el campo
  // "moneda" del resultado (Avianca: USD, Gol: BRL) — no hay una moneda
  // global única todavía.
  metodologia: "v2_sin_impuestos",

  outputDir: "./output",
};
