# fare-tracker-internacional — EZE ↔ CCS

## Qué es
Hermano internacional del [fare-tracker](https://github.com/jpiriartandes-bot/fare-tracker)
doméstico: mismo patrón (Playwright + GitHub Actions + Google Sheets), pero
para rutas internacionales. EZE↔CCS (Buenos Aires Ezeiza ↔ Caracas,
aeropuerto Simón Bolívar). Aerolíneas originalmente previstas para la etapa
1 (Avianca, Copa) y etapa 2 (Gol, American) — Copa quedó pausado por un
bloqueo total (ver abajo) y se adelantó Gol en su lugar.

Por corrida: 31 fechas (día 1 a 30 + un extra a día 60) × 2 rutas ×
aerolíneas activas en `config.js`.

## Estado actual (2026-09-09)
- **Avianca** (`scrapers/avianca.js`): **funcional para precio**, probado
  contra las dos rutas y en los 4 bordes de ventana (día 1, 15, 30, 60) —
  8/8 OK. Usa la API interna de calendario de precios
  (`airmkt/api/pricing/calendar`), que da precio por día para ~40 días en
  una sola llamada — no hace falta ni tocar el formulario de búsqueda. Dos
  gotchas encontrados y documentados en el header del archivo:
  1. Akamai Bot Manager bloquea cualquier request que no salga de un
     `fetch()` ejecutado dentro de una página de Playwright ya cargada (un
     cliente HTTP directo da `ECONNRESET`).
  2. Akamai bloquea con **403 determinístico** el modo `headless:true`
     real (expone "HeadlessChrome" en los Client Hints sin importar el
     User-Agent) — el scraper fuerza `headless:false` siempre, lo que en
     CI requiere `xvfb-run` (ya configurado en el workflow).

  **Hora de salida: NO disponible.** Completar el buscador hasta
  `booking.avianca.com` (resultados reales) da "Acceso denegado" — un WAF
  Imperva distinto y más agresivo que el Akamai de la home. Probado sin
  éxito: spoofear `navigator.webdriver`, sacar el flag
  `--disable-blink-features`, ir más lento. Bloqueó las 3 veces con el
  mismo código de error 15. Por ahora `hora_salida` queda `null` para
  Avianca — no vale la pena seguir insistiendo con evasión sin una idea
  nueva concreta.
- **Copa** (`scrapers/copa.js`): **pausado**. Siguiendo el mismo criterio
  que Avianca (buscar API antes que pelear el DOM), se probó cargar la
  home directo — apareció un CAPTCHA explícito de DataDome en la carga
  inicial de la página, antes de tocar el formulario. El sitio detecta el
  protocolo CDP que usa Playwright, no algo ajustable con flags/headers.
  No se intentó resolver/evadir el captcha. Se vio una API legítima
  (`apicm.copaair.com/catalog/booking-airports`) pero no la de precios,
  porque esa parte del flujo sí queda detrás del captcha. Decisión: no
  seguir insistiendo, se prioriza Gol/American en su lugar.
- **Gol** (`scrapers/gol.js`): **funcional para precio**, con reintentos.
  Sin bloqueos de bot-detection en el flujo de búsqueda (a diferencia de
  Copa). Usa la API de calendario (`bff-flight.voegol.com.br/
  flightcalendar`) — a diferencia de Avianca, esta exige un header
  `x-aat` (token anti-fraude generado por JS) que no se pudo replicar
  aislado, así que se deja que la propia página arme la request
  completando el buscador (origen/destino/"Só ida"), pero se INTERCEPTA
  esa request con `page.route()` para reescribir el mes pedido y así
  llegar a +60d sin navegar el calendario visual mes a mes.
  Mismo gotcha que Avianca: `headless:true` real falla (acá ni se pudo
  interactuar con el formulario) — se fuerza `headless:false`.
  **Moneda: USD** (igual que Avianca) — la página pide BRL por defecto,
  pero la misma intercepción de `page.route()` que reescribe el mes
  también reescribe `currencyCode` a "USD" y la API lo respeta sin
  problema (confirmado: 2070 BRL ≈ 407 USD, consistente con el tipo de
  cambio real).
  **Dato real del sitio, no bug**: la ruta EZE↔CCS en Gol es esparcida,
  no diaria (EZE→CCS: 2 de 61 días con vuelo; CCS→EZE: ~20 de 61) — cuando
  no hay vuelo esa fecha, el resultado es `ok:true, tarifa:null` (se
  determinó correctamente el estado, no es una falla).
  Probado con la grilla completa (31 fechas × 2 rutas = 62): 59/62 OK a la
  primera, 3 fallas transitorias de timing (la SPA de Gol es más pesada en
  Web Components que la de Avianca) — se agregó backoff de reintentos
  (mismo patrón que Aerolíneas Argentinas en el doméstico) y las 3 pasaron
  al reintentar. Hora de salida: no investigada todavía (a diferencia de
  Avianca/Copa, acá no hay evidencia de bloqueo — vale la pena retomarlo).
- **Google Sheets**: **funcional**. `sheets.js` (mismo patrón que el
  doméstico) pushea a "Fare Tracker Internacional" → pestaña "Historico",
  compartida con la service account
  (`fare-tracker-writer@fare-tracker-506113.iam.gserviceaccount.com`).
  Columnas: fecha_busqueda, ruta, aerolinea, fecha_vuelo,
  dias_anticipacion, precio, moneda, hora_salida, ok, operador, fuente,
  nota. `fuente` = `sitio_aerolinea` (scrapers propios) o
  `google_flights` (ver abajo); `nota` explica los precios vacíos de
  Google Flights.
- **GitHub Actions**: **funcional**. Cron diario a las 13:00 UTC +
  `workflow_dispatch`, con `xvfb-run` (necesario porque Avianca y Gol
  fuerzan `headless:false`), secret `GOOGLE_CREDENTIALS` configurado, y
  push automático de `output/historico.csv`. Probado end-to-end con las
  124 combinaciones completas: 43m 58s, 124/124 OK.
- **Frecuencias históricas** (`frecuencias.js`): **funcional**, mismo
  patrón que `pasajeros.js` del doméstico (misma fuente ANAC/SIAC,
  overwrite completo de la pestaña cada corrida, cron mensual día 5).
  **Hallazgo importante**: no hay vuelos NONSTOP registrados en ANAC para
  EZE↔CCS desde 2023-05-04 (último operado por Aerolíneas Argentinas;
  antes, Conviasa). Ni Avianca ni Gol aparecen nunca en esta ruta directa
  en todo el histórico (2017-2026) — consistente con que sus itinerarios
  "EZE→CCS" vendidos hoy son en realidad con escala (Avianca vía Bogotá,
  Gol vía algún hub brasileño), no tramos directos. ANAC registra por
  tramo operado, no por itinerario vendido, así que esos vuelos con escala
  no aparecen acá. Por eso la pestaña "Frecuencias" va a estar vacía
  (excepto encabezado) para el período actual — es el resultado correcto,
  no un bug. Esto es justamente lo que la Parte 2 (Google Flights) resuelve.
- **Frecuencias futuras / Google Flights** (`google_flights.js`):
  **funcional**, 62/62 OK, 800 vuelos individuales relevados. Google
  Flights no expone una API JSON plana (usa RPCs internas ofuscadas tipo
  protobuf, `batchexecute`), pero la URL de resultados
  (`/travel/flights/search?tfs=<base64>`) SÍ es un protobuf simple donde
  origen/destino/fecha están en texto plano dentro de los bytes. Se armó
  UNA plantilla por ruta (vía la UI real, una sola vez) y de ahí en
  adelante se arma la URL de cada una de las 31 fechas reemplazando
  directamente el string de fecha (largo fijo, 10 caracteres, no hace
  falta recalcular ningún largo de protobuf) — sin tocar el formulario,
  sin calendario, sin clicks. Extracción de cada vuelo vía DOM
  (`li.pIav2d`, con un `aria-label` maestro por fila que trae aerolínea,
  horarios, escalas y precio en texto natural).
  Confirmado: Google Flights muestra **todas las aerolíneas juntas**,
  incluida **Copa** (bloqueada en su propio sitio) — resuelve exactamente
  el problema que Copa dejó pendiente.
  A diferencia de Avianca/Gol, **funciona con `headless:true` real**, sin
  bloqueo — no necesita `xvfb-run`.
  Precio (`precio_gf`) en USD desde 2026-09-29 (`&curr=USD` en la URL;
  antes ARS por geo/idioma) — es solo referencia cruzada para
  frecuencias, NO reemplaza las tarifas oficiales de Avianca/Gol (es el
  mínimo entre todos los vendedores, agencias incluidas).
  ~161 de 800 filas tienen `precio_gf` null — son itinerarios que Google
  Flights lista pero marca "Precio total no disponible" (dato real, no
  error de extracción).
  Sube a una pestaña nueva "Frecuencias_Futuras" (separada de
  "Frecuencias" porque la estructura es por-vuelo-individual, no
  agregada por día). Cron diario 07:00 UTC (04:00 ART) + `workflow_dispatch`.
  El workflow corre 3 jobs en paralelo (matrix, uno por par de rutas:
  EZE↔CCS, CCS↔MIA, BUE↔MIA; ~1,5 h cada uno, `fail-fast: false`,
  timeout 300 min). Solo el job EZE↔CCS reescribe Frecuencias_Futuras.
- **Tarifas vía Google Flights** (`google_flights.js`, 2026-09-29): para
  las aerolíneas bloqueadas en su propio sitio. CCS↔MIA: American y
  Copa; EZE↔CCS: Copa; BUE↔MIA (Buenos Aires como ciudad, EZE+AEP; MIA
  como aeropuerto): Copa y LATAM, solo itinerarios con 1 escala.
  Para cada ruta/fecha/aerolínea se abren las "opciones de reserva" de
  sus 2 vuelos más baratos de la lista y se lee SOLO la fila "Reservar
  con <aerolínea>" (marcada "Compañía aérea"); se guarda el menor de esos
  precios. Nunca el precio de la lista (puede ser de una agencia o de una
  aerolínea socia) ni el de una agencia. Si la aerolínea no vende
  directo, fila con precio vacío, `ok=true` y `nota`. Van a "Historico"
  con `fuente=google_flights`, en USD y **con impuestos** (Google Flights
  muestra precio final) — no comparables 1:1 con las tarifas sin
  impuestos de los scrapers propios. Pausas de 5-10 s entre páginas.
  Se escribe a medida que avanza (después de cada ruta/fecha) en
  "Historico" y en un CSV propio por job (`output/historico_gf_<par>.csv`,
  nunca en `historico.csv`, que es del workflow de tarifas).
  Prueba: `node google_flights.js --prueba --ventanas=1,15,60`
  (no sube a Sheets).

## Setup local (correr con Claude Code local — necesita salida a internet real)

```bash
npm install
npx playwright install chromium
```

## Próximos pasos (en orden)
1. Decidir qué hacer con la hora de salida de Avianca (bloqueada) y si
   vale la pena investigar la de Gol (no bloqueada, no probada todavía).
2. Agregar reintentos con backoff a `scrapers/avianca.js` también (Gol ya
   los tiene; Avianca no mostró fallas en 62/62 pero conviene ser
   consistente antes de confiar en el cron diario sin supervisión).
3. Evaluar American Airlines (etapa 2) para tener una tercera aerolínea
   activa, dado que Copa quedó pausado.
