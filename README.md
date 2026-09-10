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
  dias_anticipacion, precio, moneda, hora_salida, ok.
- **GitHub Actions**: **funcional**. Cron diario a las 13:00 UTC +
  `workflow_dispatch`, con `xvfb-run` (necesario porque Avianca y Gol
  fuerzan `headless:false`), secret `GOOGLE_CREDENTIALS` configurado, y
  push automático de `output/historico.csv`. Probado end-to-end con las
  124 combinaciones completas: 43m 58s, 124/124 OK.

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
