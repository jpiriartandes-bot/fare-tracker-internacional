// config.js
// Config central: acá se agregan rutas y aerolíneas a medida que se escala el relevamiento.

module.exports = {
  // Rutas activas (código IATA origen_destino)
  rutas: [
    { id: "EZE_CCS", origen: "EZE", destino: "CCS" },
    { id: "CCS_EZE", origen: "CCS", destino: "EZE" },
  ],

  // Etapa 1: Avianca y Copa. Etapa 2 (Gol, American) se suma más adelante.
  aerolineas: ["avianca", "copa"],

  // Ventanas de anticipación en días desde hoy: día 1 a día 30 (uno por
  // día) + un extra a día 60. index.js las convierte a fechas en tiempo de
  // ejecución (no son fechas fijas). Total: 31 fechas x 2 rutas x 2
  // aerolíneas = 124 búsquedas por corrida.
  ventanas: [...Array.from({ length: 30 }, (_, i) => i + 1), 60],

  // Metodología: tarifa más económica visible, SIN impuestos/tasas,
  // consistente con la metodología v2 usada en el fare-tracker doméstico.
  metodologia: "v2_sin_impuestos",

  moneda: "USD",

  outputDir: "./output",
};
