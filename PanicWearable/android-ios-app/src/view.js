import { DAILY_METRICS } from './daily-data.js';

const paths = {
  logo: '<path d="M3 12c2.5 0 3.4-4 6-4s3.4 8 6 8 3.5-4 6-4"/>',
  home: '<path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 21v-7h6v7"/>',
  breath: '<path d="M3 8h13a2.5 2.5 0 1 0-2.5-2.5M3 12h17a2.5 2.5 0 1 1-2.5 2.5M3 16h9a2.5 2.5 0 1 1-2.5 2.5"/>',
  history: '<path d="M3 11a9 9 0 1 1 2.5 7.2M3 6v5h5m4-4v5l3 2"/>',
  watch: '<rect x="5" y="6" width="14" height="12" rx="3"/><path d="M8 6l1-4h6l1 4m-8 12 1 4h6l1-4m-4-9v3l2 1"/>',
  heart: '<path d="M20.8 4.6a5.4 5.4 0 0 0-7.6 0L12 5.8l-1.2-1.2a5.4 5.4 0 0 0-7.6 7.6L12 21l8.8-8.8a5.4 5.4 0 0 0 0-7.6Z"/>',
  bluetooth: '<path d="m6 7 12 10-6 5V2l6 5L6 17"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3m-4 5v2"/>',
  check: '<path d="m5 12 4 4 10-10"/>',
  warning: '<path d="M12 8v5m0 3v.1M10.2 4.9 3.4 17a2 2 0 0 0 1.7 3h13.8a2 2 0 0 0 1.7-3L13.8 4.9a2 2 0 0 0-3.6 0Z"/>',
  export: '<path d="M12 15V3m-4 4 4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
};

export const icon = (name, classes = '') => `<svg class="icon ${classes}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;

function chart(prefix) {
  return `
    <div class="chart-row">
      <div class="chart-key"><span class="legend-dot pulse-dot"></span>Puls <span>Schläge/min</span></div>
      <canvas id="${prefix}-pulse" role="img" aria-label="Pulsverlauf in Schlägen pro Minute"></canvas>
    </div>
    <div class="chart-row">
      <div class="chart-key"><span class="legend-dot breath-dot"></span>Atmung <span>Atemzüge/min</span></div>
      <canvas id="${prefix}-breath" role="img" aria-label="Atemverlauf in Atemzügen pro Minute"></canvas>
    </div>
    <div class="chart-axis"><span id="${prefix}-from"></span><span id="${prefix}-to"></span></div>`;
}

export const layout = `
  <header class="appbar">
    <div class="appbar-inner">
      <button class="brand" type="button" data-view="overview" aria-label="Calmdown Übersicht">
        <img class="brand-logo" src="./calmdown-logo-sage.png" alt="" width="64" height="64" />
        <span>calmdown<span class="brand-point">.</span></span>
      </button>
      <nav class="tabs" aria-label="Hauptnavigation">
        <button class="tab" type="button" data-view="overview" aria-current="page">${icon('home')}<span>Übersicht</span></button>
        <button class="tab" type="button" data-view="history">${icon('history')}<span>Verlauf</span></button>
        <button class="tab" type="button" data-view="device">${icon('watch')}<span>Gerät</span></button>
      </nav>
      <button class="connection-pill" type="button" data-view="device"><i class="status-dot"></i><span id="app-connection">Nicht verbunden</span></button>
    </div>
  </header>

  <main class="main">
    <section class="page" id="overview" aria-labelledby="overview-title">
      <div class="page-heading">
        <div>
          <p class="eyebrow"><span class="eyebrow-dot"></span> DEIN WEARABLE</p>
          <h1 id="overview-title" tabindex="-1">Dein Moment.</h1>
          <p class="page-intro">Puls und Atemfrequenz im Blick.</p>
        </div>
        <span class="date-badge">${icon('clock')}<time id="today"></time></span>
      </div>

      <div id="demo-banner" class="banner demo-banner" hidden><strong id="demo-label">Demo läuft</strong><span id="demo-copy">Die Werte stammen aus der Simulation.</span><button type="button" class="text-button" data-action="stop-demo">Demo beenden</button></div>

      <div class="dashboard-grid">
        <div class="stack">
          <article class="live-card">
            <div class="live-heading">
              <div><p class="eyebrow">MESSWERTE</p><h2>Deine Livewerte</h2></div>
              <span class="live-pill" id="live-status"><i class="status-dot"></i><span id="live-label">Wartet auf Uhr</span></span>
            </div>
            <div class="metrics">
              <div class="metric metric-heart">
                <span class="metric-name">${icon('heart')} Puls</span>
                <div class="metric-line"><strong id="pulse">–</strong><span>bpm</span></div>
                <p id="pulse-hint">Schläge pro Minute</p>
              </div>
              <div class="metric metric-breath">
                <span class="metric-name">${icon('breath')} Atmung</span>
                <div class="metric-line"><strong id="respiration">–</strong><span>/min</span></div>
                <p id="respiration-hint">Atemzüge pro Minute</p>
              </div>
            </div>
            <p class="live-foot" id="signal-status">Verbinde den StressMonitor, um Messwerte zu sehen.</p>
          </article>

          <article id="watch-event" class="banner event-banner" hidden>
            <span class="event-icon">${icon('warning')}</span>
            <div><strong id="watch-event-title"></strong><p id="watch-event-copy"></p></div>
          </article>

          <article class="card">
            <div class="card-heading"><div><p class="eyebrow">LÄNGER IM BLICK</p><h2>Messverlauf</h2></div><label class="range-label">Zeitraum<select id="live-range"><option value="60000">Letzte Minute</option><option value="600000" selected>10 Minuten</option><option value="3600000">1 Stunde</option></select></label></div>
            <div id="live-chart-empty" class="chart-empty"><span class="round-icon">${icon('history')}</span><p>Sobald Werte eintreffen, siehst du sie hier im Verlauf.</p></div>
            <div id="live-chart" hidden>${chart('live-chart')}</div>
            <p class="chart-explainer">Frische Einzelwerte und gespeicherte Minutenmittel. Wähle im Kalender einen früheren Tag.</p>
          </article>
        </div>

        <aside class="stack">
          <article class="card connect-card">
            <span class="round-icon">${icon('watch')}</span>
            <p class="eyebrow">BLUETOOTH</p><h2>Deine Uhr</h2>
            <p id="connect-copy">Verbinde den StressMonitor, um deine Livewerte direkt zu empfangen.</p>
            <button type="button" class="button primary full" data-action="connect">${icon('bluetooth')} <span>Uhr verbinden</span></button>
            <button type="button" class="text-button" data-action="toggle-demo">Demo ausprobieren ${icon('arrow')}</button>
          </article>
        </aside>
      </div>
    </section>

    <section class="page" id="history" aria-labelledby="history-title" hidden>
      <div class="page-heading"><div><p class="eyebrow"><span class="eyebrow-dot"></span> AUF DIESEM GERÄT</p><h1 id="history-title" tabindex="-1">Dein Verlauf.</h1><p class="page-intro">Aufzeichnungen aus deinen Messungen mit dem StressMonitor.</p></div><button type="button" class="button secondary" data-action="export">${icon('export')} Exportieren</button></div>
      <div class="database-notice">
        <p id="database-state" role="status">Lokale Tagesdatenbank wird geöffnet …</p>
        <p class="muted" id="database-error"></p>
        <button type="button" id="database-retry" class="text-button" hidden>Erneut versuchen</button>
      </div>
      <div class="daily-layout">
        <article class="card calendar-card">
          <div class="calendar-heading"><button id="calendar-previous" class="calendar-nav" type="button" aria-label="Vorheriger Monat">‹</button><h2 id="calendar-month"></h2><button id="calendar-next" class="calendar-nav" type="button" aria-label="Nächster Monat">›</button></div>
          <div class="calendar-weekdays" aria-hidden="true"><span>Mo</span><span>Di</span><span>Mi</span><span>Do</span><span>Fr</span><span>Sa</span><span>So</span></div>
          <div id="daily-calendar" class="calendar-grid" role="group" aria-label="Tag für Messverlauf auswählen"></div>
          <div class="calendar-foot"><span><i class="calendar-data-dot"></i> Messwerte vorhanden</span><button type="button" id="calendar-today" class="text-button">Heute</button></div>
        </article>
        <article class="card daily-detail">
          <p class="eyebrow">TAGESAUSWERTUNG</p><h2 id="selected-day-title"></h2>
          <p class="muted" id="daily-count"></p>
          <div id="daily-empty" class="daily-empty"><p>Für diesen Tag wurden noch keine Messwerte gespeichert.</p><p class="muted">Verbinde deine Uhr und lasse die Aufzeichnung unter Gerät eingeschaltet. Uhrdaten erscheinen nach Abschluss einer Messminute.</p></div>
          <div id="daily-summary" class="daily-summary" hidden>
            ${DAILY_METRICS.map(({ key, label, unit }) => `<section class="daily-metric"><h3>${label} <span>${unit}</span></h3><dl><div><dt>Durchschnitt</dt><dd id="${key}-average">–</dd></div><div><dt>Maximum</dt><dd id="${key}-maximum">–</dd></div></dl><p id="${key}-day-note"></p></section>`).join('')}
          </div>
          <div id="daily-chart-area" hidden>
            <label class="daily-chart-label" for="daily-metric">Tagesverlauf<select id="daily-metric">${DAILY_METRICS.map(({ key, label }) => `<option value="${key}">${label}</option>`).join('')}</select></label>
            <p class="chart-explainer">Minutenmittel der aufgezeichneten Werte. Fehlende Messungen bleiben frei.</p>
            <p id="daily-chart-empty" class="muted" hidden></p>
            <div id="daily-chart-wrap"><canvas id="daily-chart-canvas" class="daily-chart" role="img"></canvas><div class="chart-axis"><span id="daily-chart-from"></span><span id="daily-chart-to"></span></div></div>
            <p class="chart-explainer">Tage richten sich nach der lokalen Zeitzone beim Empfang.</p>
          </div>
          <button type="button" class="text-button danger" id="delete-day" disabled>Tag löschen</button>
          <div class="confirm" id="delete-day-confirm" hidden><p id="delete-day-question"></p><button type="button" class="button danger-button" id="confirm-delete-day">Tag löschen</button><button type="button" class="text-button" id="cancel-delete-day">Abbrechen</button></div>
        </article>
      </div>
      <h2 class="legacy-heading" id="legacy-history-heading" hidden>Ältere Aufzeichnungen</h2>
      <article class="card" id="history-recovery" hidden>
        <p class="eyebrow">ÄLTERE AUFZEICHNUNGEN</p><h2>Älterer Verlauf nicht lesbar</h2>
        <p id="history-recovery-copy"></p>
        <button type="button" class="button secondary" data-action="backup-history">Rohdaten sichern</button>
        <button type="button" class="text-button danger" data-action="reset-history">Verlauf zurücksetzen</button>
        <div id="reset-history-confirm" class="confirm" hidden><p>Den bisherigen Inhalt endgültig löschen?</p><button type="button" class="button danger-button" data-action="confirm-reset-history">Zurücksetzen</button><button type="button" class="text-button" data-action="cancel-reset-history">Abbrechen</button></div>
      </article>
      <div id="history-empty" class="card empty-state"><span class="round-icon">${icon('history')}</span><h2>Noch kein Messverlauf</h2><p>Wenn die Uhr gültige Daten sendet, erscheint hier deine erste Messung.</p><button type="button" class="button secondary" data-view="device">Zur Uhr ${icon('arrow')}</button></div>
      <div id="history-entries" class="stack"></div>
      <article id="history-detail" class="card history-detail" hidden>
        <div class="card-heading"><div><p class="eyebrow">MESSUNG</p><h2 id="history-detail-title" tabindex="-1"></h2><p class="muted" id="history-detail-meta"></p></div><button class="text-button" data-action="close-detail" type="button">Schließen</button></div>
        <div id="history-chart" hidden>${chart('saved-chart')}</div>
        <h3>Uhrmeldungen</h3><ul id="history-events" class="event-list"></ul>
        <button type="button" class="text-button danger" data-action="remove-session">Messung löschen</button>
        <div id="remove-session-confirm" class="confirm" hidden><p>Diese Messung endgültig löschen?</p><button type="button" class="button danger-button" data-action="confirm-remove-session">Löschen</button><button type="button" class="text-button" data-action="cancel-remove-session">Abbrechen</button></div>
      </article>
      <p id="history-settings-note" class="muted"></p>
    </section>

    <section class="page" id="device" aria-labelledby="device-title" hidden>
      <div class="page-heading"><div><p class="eyebrow"><span class="eyebrow-dot"></span> STRESSMONITOR</p><h1 id="device-title" tabindex="-1">Dein Gerät.</h1><p class="page-intro">Verbindung, Uhrzeit und deine Einstellungen.</p></div></div>
      <div class="device-grid">
        <div class="stack">
          <article class="card">
            <div class="card-heading"><div><p class="eyebrow">BLUETOOTH</p><h2 id="device-name">StressMonitor</h2><p id="device-message">Deine Uhr ist gerade nicht verbunden.</p></div><span class="round-icon">${icon('watch')}</span></div>
            <button type="button" class="button primary" data-action="connect">${icon('bluetooth')} <span>Uhr verbinden</span></button>
            <p class="muted" id="history-sync-status" role="status">Uhrverlauf verfügbar, sobald die Uhr verbunden ist.</p>
            <details class="disclosure"><summary>Verbindungshilfe</summary><p>Schalte die Uhr ein und halte sie in der Nähe. Bluetooth muss auf dem iPhone eingeschaltet sein. Erlaube Bluefy beziehungsweise Calmdown den Bluetooth-Zugriff und wähle dann den StressMonitor aus.</p><p>Auf dem iPhone funktioniert diese HTTPS-Version in einem Web-Bluetooth-Browser wie Bluefy. Alternativ kann später die native Calmdown-App installiert werden. Die Uhr misst und warnt eigenständig weiter, wenn die Webseite geschlossen ist.</p></details>
          </article>

          <article class="card">
            <div class="card-heading"><div><p class="eyebrow">GERÄTEZEIT</p><h2>Uhr synchronisieren</h2><p id="clock-state">Die Zeit wird beim Verbinden übertragen.</p></div><span class="round-icon">${icon('clock')}</span></div>
            <button type="button" class="button secondary" data-action="sync-clock" id="sync-clock" disabled>Zeit jetzt senden</button>
            <details class="disclosure"><summary>Gerätediagnose</summary><dl class="diagnostics">
              <div><dt>Verbindungsschritt</dt><dd id="diag-step">Noch nicht verbunden</dd></div><div><dt>Letzter Bluetooth-Fehler</dt><dd id="diag-error">Kein Fehler gemeldet</dd></div><div><dt>Datenempfang</dt><dd id="diag-delivery">–</dd></div><div><dt>Letztes Paket</dt><dd id="diag-packet">–</dd></div><div><dt>ADC (Potentiometer)</dt><dd id="diag-adc">–</dd></div><div><dt>IR / Rot</dt><dd id="diag-optics">–</dd></div><div><dt>Verworfene Pakete</dt><dd id="diag-errors">0</dd></div><div><dt>Uhrspeicher</dt><dd id="diag-storage">–</dd></div><div><dt>Speicherhinweis</dt><dd id="diag-storage-note">–</dd></div>
            </dl></details>
          </article>
        </div>
        <div class="stack">
          <article class="card">
            <p class="eyebrow">EINSTELLUNGEN</p><h2>Deine Daten</h2>
            <label class="setting"><span><strong>Verbindung wiederherstellen</strong><small>Versucht im Vordergrund bis zu dreimal, dieselbe Uhr erneut zu verbinden.</small></span><input type="checkbox" id="auto-reconnect" role="switch" checked></label>
            <label class="setting"><span><strong>Verlauf speichern</strong><small>Übernimmt echte Messungen lokal in die App. Der Speicher auf der Uhr läuft unabhängig davon.</small></span><input type="checkbox" id="save-history" role="switch" checked></label>
            <button type="button" class="text-button danger" data-action="delete-history">Verlauf löschen</button>
            <div id="clear-history-confirm" class="confirm" hidden><p>Alle Tagesdaten und älteren Aufzeichnungen endgültig löschen?</p><button type="button" class="button danger-button" data-action="confirm-delete-history">Alles löschen</button><button type="button" class="text-button" data-action="cancel-delete-history">Abbrechen</button></div>
          </article>
          <article class="card">
            <p class="eyebrow">AUSPROBIEREN</p><h2>Demo-Modus</h2><p>Teste die Ansichten mit simulierten Werten. Demo-Daten werden nicht gespeichert.</p>
            <button type="button" class="button secondary" data-action="toggle-demo">Demo ausprobieren ${icon('arrow')}</button>
            <button type="button" id="demo-warning-button" class="text-button demo-test" data-action="demo-warning" hidden>Demo-Warnung anzeigen ${icon('arrow')}</button>
          </article>
        </div>
      </div>
    </section>

    <p id="toast" class="toast" role="status" hidden></p>
    <footer class="footer">${icon('lock')}<p>Kein Konto, keine Cloud. Calmdown zeigt experimentelle Messungen und Warnungen bei erhöhten Werten. Eine Panikattacke lässt sich daraus nicht diagnostizieren.</p></footer>
  </main>
`;
