# fare-tracker-internacional — EZE ↔ CCS / Avianca, Copa

## Qué es
Hermano internacional del [fare-tracker](https://github.com/jpiriartandes-bot/fare-tracker)
doméstico: mismo patrón (Playwright + GitHub Actions + Google Sheets), pero
para rutas internacionales. Etapa 1: EZE↔CCS (Buenos Aires Ezeiza ↔ Caracas,
aeropuerto Simón Bolívar) en Avianca y Copa Airlines. Gol y American Airlines
quedan para la etapa 2.

Por corrida: 31 fechas (día 1 a 30 + un extra a día 60) × 2 rutas × 2
aerolíneas = 124 búsquedas.

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
- **Copa** (`scrapers/copa.js`): sin reconocimiento en vivo todavía, solo
  el inventario de campos del formulario de búsqueda.
- **Google Sheets**: todavía no hay Sheet creado ni `sheets.js` escrito.
  El plan es reutilizar la misma service account del fare-tracker
  doméstico (`fare-tracker-writer@fare-tracker-506113.iam.gserviceaccount.com`),
  compartiendo un Sheet nuevo con esa cuenta.
- **GitHub Actions**: el workflow (`fare-tracker-internacional.yml`) está
  armado siguiendo el mismo patrón del doméstico (cron diario +
  `workflow_dispatch`, secret `GOOGLE_CREDENTIALS` escrito a archivo y
  borrado al final), pero todavía no tiene el secret configurado en el
  repo, y correrlo hoy fallaría porque los scrapers no están terminados.

## Setup local (correr con Claude Code local — necesita salida a internet real)

```bash
npm install
npx playwright install chromium
```

## Próximos pasos (en orden)
1. Decidir qué hacer con la hora de salida de Avianca: ¿aceptar precio-only
   por ahora, buscar otra vía de entrada (API interna del motor de
   reservas en vez de la página web), o dejarlo pendiente?
2. Reconocimiento en vivo de Copa (`scrapers/copa.js`) — primero chequear
   si expone una API interna como Aerolíneas Argentinas y Avianca, antes
   de ir a selectores DOM. Mismo cuidado con headless real vs headless
   verdadero si el sitio tiene protección parecida.
3. Backoff/reintentos agresivos desde el arranque en ambos scrapers — en
   el fare-tracker doméstico, JetSMART tuvo inestabilidad recurrente por
   no tener esto desde el principio.
4. Crear el Google Sheet nuevo, compartirlo con la service account, y
   escribir `sheets.js` (mismo patrón que el doméstico).
5. Configurar el secret `GOOGLE_CREDENTIALS` en este repo (Settings →
   Secrets and variables → Actions).
6. Corrida de prueba end-to-end (unas pocas combinaciones primero, no las
   124 de una) antes de confiar en el cron diario.
