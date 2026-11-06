import './style.css';
import { BleTransport } from './ble/ble-transport.js';
import { createSimulator } from './simulator.js';

const MAX_SAMPLES = 60;
const HISTORY_WINDOW_MS = 60_000;

document.querySelector('#app').innerHTML = `
  <main class="shell">
    <header class="topbar">
      <a class="brand" href="#" aria-label="PanicWearable Startseite">
        <span class="brand-mark" aria-hidden="true">p</span>
        <span>Panic<span class="brand-light">Wearable</span></span>
      </a>
      <span class="prototype-tag"><span class="tag-dot"></span> Forschungsprototyp</span>
    </header>

    <section class="intro">
      <div>
        <p class="eyebrow">PERSÖNLICHES DASHBOARD</p>
        <h1>Dein Signal im Blick.</h1>
        <p class="intro-copy">Messwerte deines Wearable-Prototyps in Echtzeit.</p>
      </div>
      <div class="connection-card">
        <div class="connection-copy">
          <span class="connection-label">GERÄTESTATUS</span>
          <span id="connection-status" class="connection-value"><span class="status-dot"></span>Simulation aktiv</span>
          <span id="device-name" class="device-name">Künstliche Testdaten</span>
        </div>
        <button id="connect-button" class="button button-dark" type="button">BLE verbinden</button>
      </div>
    </section>

    <div id="notice" class="notice" role="status" aria-live="polite">
      Demo-Modus: Die angezeigten Werte sind künstlich erzeugt und stammen nicht von einem Sensor.
    </div>

    <section class="metrics" aria-label="Aktuelle Messwerte">
      <article class="metric-card heart-card">
        <div class="metric-heading">
          <span class="metric-icon heart-icon" aria-hidden="true">♡</span>
          <span class="metric-caption">HERZFREQUENZ</span>
          <span class="live-indicator"><span></span> LIVE</span>
        </div>
        <div class="metric-reading"><span id="heart-rate" class="metric-number">—</span><span class="metric-unit">bpm</span></div>
        <p class="metric-footnote">Schläge pro Minute</p>
      </article>
      <article class="metric-card breath-card">
        <div class="metric-heading">
          <span class="metric-icon breath-icon" aria-hidden="true">≈</span>
          <span class="metric-caption">ATEMFREQUENZ</span>
          <span class="live-indicator"><span></span> LIVE</span>
        </div>
        <div class="metric-reading"><span id="respiration-rate" class="metric-number">—</span><span class="metric-unit">/min</span></div>
        <p class="metric-footnote">Experimentelle Schätzung</p>
      </article>
    </section>

    <section class="panel chart-panel" aria-labelledby="chart-title">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">LETZTE 60 SEKUNDEN</p>
          <h2 id="chart-title">Messverlauf</h2>
        </div>
        <div class="legend" aria-label="Legende">
          <span><i class="legend-dot heart-legend"></i> Herzfrequenz</span>
          <span><i class="legend-dot breath-legend"></i> Atmung</span>
        </div>
      </div>
      <div class="chart-wrap">
        <canvas id="history-chart" role="img" aria-label="Zeitlicher Verlauf der empfangenen oder simulierten Messwerte"></canvas>
      </div>
      <div class="chart-axis"><span>vor 60 s</span><span>jetzt</span></div>
    </section>

    <section class="bottom-grid">
      <article class="panel signal-panel">
        <div class="panel-heading compact-heading">
          <div>
            <p class="eyebrow">SENSOR &amp; STATUS</p>
            <h2>ADC-Rohwert</h2>
          </div>
          <span id="signal-value" class="signal-number">—</span>
        </div>
        <div class="quality-track"><div id="quality-bar" class="quality-bar"></div></div>
        <div class="signal-meta"><span id="signal-label">Warte auf Messwerte</span><span>0–4095</span></div>
        <div id="sensor-details" class="sensor-details">IR — · Rot —</div>
        <div id="packet-details" class="sensor-details">Paket — · Laufzeit —</div>
        <div id="observation" class="observation">
          <span class="observation-icon" aria-hidden="true">✓</span>
          <span>Keine Warnung gemeldet</span>
        </div>
      </article>

      <article class="panel clock-panel">
        <div class="clock-copy">
          <p class="eyebrow">GERÄTEZEIT</p>
          <h2>Uhr synchronisieren</h2>
          <p id="clock-status">Wird bei Verbindung und Zeitzonenwechsel gesendet.</p>
        </div>
        <button id="clock-button" class="button button-dark" type="button">
          Uhr jetzt senden
        </button>
      </article>
    </section>

    <footer class="disclaimer">
      <span class="info-mark" aria-hidden="true">i</span>
      <p>Kein Medizinprodukt. Werte und Hinweise dienen ausschließlich der Erprobung und stellen keine Diagnose dar. Die Atemfrequenz ist experimentell. Die BLE-Entwicklungsschnittstelle ist unverschlüsselt und ungepaart; keine personenbezogenen Daten verwenden.</p>
    </footer>
  </main>
`;

const elements = {
  status: document.querySelector('#connection-status'),
  deviceName: document.querySelector('#device-name'),
  connectButton: document.querySelector('#connect-button'),
  notice: document.querySelector('#notice'),
  heartRate: document.querySelector('#heart-rate'),
  respirationRate: document.querySelector('#respiration-rate'),
  signalValue: document.querySelector('#signal-value'),
  signalLabel: document.querySelector('#signal-label'),
  qualityBar: document.querySelector('#quality-bar'),
  observation: document.querySelector('#observation'),
  sensorDetails: document.querySelector('#sensor-details'),
  packetDetails: document.querySelector('#packet-details'),
  clockButton: document.querySelector('#clock-button'),
  clockStatus: document.querySelector('#clock-status'),
  chart: document.querySelector('#history-chart'),
};

const ble = new BleTransport();
const simulator = createSimulator(updateMeasurement);
const samples = [];
let mode = 'simulation';
let isConnecting = false;
let lastSyncedTimezoneOffset = null;
let simulationButton;

function setConnectionStatus(label, state) {
  elements.status.className = `connection-value state-${state}`;
  elements.status.innerHTML = `<span class="status-dot"></span>${label}`;
}

function setNotice(message, type = 'info') {
  elements.notice.textContent = message;
  elements.notice.className = `notice notice-${type}`;
}

function renderMeasurement(measurement) {
  elements.heartRate.textContent = measurement.heartRate !== null
    ? measurement.heartRate.toFixed(1)
    : '—';
  elements.respirationRate.textContent = measurement.respirationRate !== null
    ? measurement.respirationRate.toFixed(1)
    : '—';

  elements.signalValue.textContent = String(measurement.adc);
  elements.qualityBar.style.width = `${(measurement.adc / 4095) * 100}%`;
  elements.signalLabel.textContent = `Zustand: ${['Messen', 'Schwelle halten', 'Warnung', 'Atemhilfe'][measurement.state]}`;
  elements.sensorDetails.textContent = measurement.maxFresh
    ? `IR ${measurement.ir} · Rot ${measurement.red} · MAX aktuell`
    : `IR zuletzt ${measurement.ir} · Rot zuletzt ${measurement.red}`;
  const uptimeSeconds = Math.floor(measurement.uptimeMs / 1000);
  const uptimeHours = Math.floor(uptimeSeconds / 3600);
  const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);
  elements.packetDetails.textContent = `Paket ${measurement.packetCount} · Laufzeit ${uptimeHours} h ${uptimeMinutes} min`;

  const warning = measurement.warning || measurement.state === 2;
  const statusDetails = [
    warning ? 'Warnung gemeldet' : 'Keine Warnung gemeldet',
    measurement.breathAssist ? 'Atemhilfe aktiv' : '',
    measurement.demo ? 'Demo-Daten' : '',
  ].filter(Boolean);
  elements.observation.classList.toggle('observation-alert', warning);
  elements.observation.querySelector('span:last-child').textContent = statusDetails.join(' · ');

  const now = measurement.receivedAt || Date.now();
  samples.push({ ...measurement, receivedAt: now });
  while (samples.length > MAX_SAMPLES || samples[0].receivedAt < now - HISTORY_WINDOW_MS) {
    samples.shift();
  }
  drawChart();
}

function updateMeasurement(measurement) {
  renderMeasurement(measurement);
}

function clearMeasurement() {
  elements.heartRate.textContent = '—';
  elements.respirationRate.textContent = '—';
  elements.signalValue.textContent = '—';
  elements.signalLabel.textContent = 'Warte auf Messwerte';
  elements.sensorDetails.textContent = 'IR — · Rot —';
  elements.packetDetails.textContent = 'Paket — · Laufzeit —';
  elements.qualityBar.style.width = '0%';
  elements.observation.classList.remove('observation-alert');
  elements.observation.querySelector('span:last-child').textContent = 'Keine Warnung gemeldet';
  samples.length = 0;
  drawChart();
}

function updateSimulationButton() {
  if (!simulationButton) return;
  simulationButton.textContent = mode === 'simulation'
    ? 'Simulation pausieren'
    : 'Simulation starten';
}

function drawChart() {
  const canvas = elements.chart;
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;

  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(bounds.width * ratio);
  canvas.height = Math.round(bounds.height * ratio);
  const context = canvas.getContext('2d');
  context.scale(ratio, ratio);

  const width = bounds.width;
  const height = bounds.height;
  const padding = { top: 10, right: 6, bottom: 10, left: 6 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  context.clearRect(0, 0, width, height);

  context.strokeStyle = '#e8eeea';
  context.lineWidth = 1;
  for (let line = 0; line < 4; line += 1) {
    const y = padding.top + (plotHeight * line) / 3;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
  }

  const validSamples = samples.filter((sample) => sample.valid);
  const series = [
    { key: 'heartRate', min: 45, max: 125, color: '#e27973' },
    { key: 'respirationRate', min: 6, max: 30, color: '#55a88a' },
  ];

  for (const item of series) {
    const points = validSamples.filter((sample) => sample[item.key] !== null);
    if (!points.length) continue;

    context.beginPath();
    points.forEach((sample, index) => {
      const timeOffset = Math.max(0, nowForChart() - sample.receivedAt);
      const x = width - padding.right - (timeOffset / HISTORY_WINDOW_MS) * plotWidth;
      const normalized = Math.min(1, Math.max(0, (sample[item.key] - item.min) / (item.max - item.min)));
      const y = padding.top + plotHeight * (1 - normalized);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.strokeStyle = item.color;
    context.lineWidth = 2.5;
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.stroke();
  }
}

function nowForChart() {
  return samples.length ? samples[samples.length - 1].receivedAt : Date.now();
}

async function connectBle() {
  if (isConnecting) return;
  isConnecting = true;
  elements.connectButton.disabled = true;
  simulator.stop();
  mode = 'ble';
  clearMeasurement();
  updateSimulationButton();
  elements.deviceName.textContent = 'Geräteauswahl wird geöffnet …';
  setConnectionStatus('Verbindung wird hergestellt', 'connecting');
  setNotice('Bitte wähle dein StressMonitor im Bluetooth-Dialog aus.', 'info');

  try {
    const deviceName = await ble.connect({
      onMeasurement: updateMeasurement,
      onDisconnected: () => {
        elements.deviceName.textContent = 'Gerät getrennt';
        setConnectionStatus('Getrennt', 'disconnected');
        setNotice('Die BLE-Verbindung wurde unterbrochen. Du kannst erneut verbinden oder die Simulation starten.', 'warning');
        elements.connectButton.textContent = 'BLE verbinden';
        elements.clockStatus.textContent = 'Nicht verbunden.';
        clearMeasurement();
        updateSimulationButton();
      },
      onProtocolError: (error) => {
        setNotice(`BLE-/Protokollfehler: ${error.message || error}`, 'error');
      },
    });
    if (ble.deviceId === null) return;
    elements.deviceName.textContent = deviceName;
    setConnectionStatus('Verbunden', 'connected');
    elements.connectButton.textContent = 'Trennen';
    updateSimulationButton();
    await synchronizeClock({ automatic: true });
  } catch (error) {
    elements.deviceName.textContent = 'Kein Gerät verbunden';
    setConnectionStatus('Nicht verbunden', 'disconnected');
    elements.connectButton.textContent = 'BLE verbinden';
    setNotice(`Verbindung fehlgeschlagen: ${error.message || error}`, 'error');
  } finally {
    isConnecting = false;
    elements.connectButton.disabled = false;
    updateSimulationButton();
  }
}

async function disconnectBle() {
  elements.connectButton.disabled = true;
  try {
    await ble.disconnect();
    elements.deviceName.textContent = 'Gerät getrennt';
    setConnectionStatus('Getrennt', 'disconnected');
    setNotice('BLE-Verbindung getrennt. Du kannst erneut verbinden oder die Simulation starten.', 'info');
    elements.connectButton.textContent = 'BLE verbinden';
    elements.clockStatus.textContent = 'Nicht verbunden.';
    clearMeasurement();
    return true;
  } catch (error) {
    setNotice(`Trennen fehlgeschlagen: ${error.message || error}`, 'error');
    return false;
  } finally {
    elements.connectButton.disabled = false;
  }
}

function toggleSimulation() {
  if (isConnecting) return;
  if (mode === 'simulation') {
    simulator.stop();
    mode = 'paused';
    setConnectionStatus('Simulation pausiert', 'disconnected');
    elements.deviceName.textContent = 'Keine neuen Demo-Werte';
    setNotice('Simulation pausiert. Der letzte Verlauf bleibt sichtbar.', 'info');
    elements.connectButton.textContent = 'BLE verbinden';
    updateSimulationButton();
    return;
  }

  mode = 'simulation';
  elements.connectButton.textContent = 'BLE verbinden';
  elements.deviceName.textContent = 'Künstliche Testdaten';
  setConnectionStatus('Simulation aktiv', 'simulation');
  setNotice('Demo-Modus: Die angezeigten Werte sind künstlich erzeugt und stammen nicht von einem Sensor.', 'info');
  samples.length = 0;
  simulator.start();
  updateSimulationButton();
}

elements.connectButton.addEventListener('click', () => {
  if (isConnecting) return;
  if (mode === 'ble' && ble.deviceId !== null) {
    void disconnectBle();
  } else {
    void connectBle();
  }
});

async function synchronizeClock({ automatic = false } = {}) {
  if (ble.deviceId === null) {
    if (!automatic) setNotice('Kein Gerät verbunden. Bitte zuerst BLE verbinden.', 'warning');
    return;
  }

  const now = new Date();
  elements.clockButton.disabled = true;
  try {
    await ble.syncClock(now);
    elements.clockStatus.textContent = `Zuletzt gesendet: ${now.toLocaleString()}`;
    setNotice(
      'Uhrzeit an den ESP32 übertragen. BLE bestätigt den Empfang, nicht die Speicherung in der RTC.',
      automatic ? 'info' : 'success',
    );
  } catch (error) {
    elements.clockStatus.textContent = 'Synchronisierung fehlgeschlagen.';
    setNotice(`Uhr-Synchronisierung fehlgeschlagen: ${error.message || error}`, 'error');
  } finally {
    elements.clockButton.disabled = false;
  }
}

elements.clockButton.addEventListener('click', () => {
  void synchronizeClock();
});

window.addEventListener('keydown', (event) => {
  if (event.key === 's' && event.altKey) {
    event.preventDefault();
    toggleSimulation();
  }
});

simulationButton = document.createElement('button');
simulationButton.type = 'button';
simulationButton.className = 'simulation-button';
simulationButton.textContent = 'Simulation pausieren';
simulationButton.setAttribute('aria-label', 'Simulation pausieren oder starten');
document.querySelector('.intro').after(simulationButton);
simulationButton.addEventListener('click', () => {
  if (mode === 'ble' && ble.deviceId !== null) {
    void disconnectBle().then((disconnected) => {
      if (disconnected) toggleSimulation();
      updateSimulationButton();
    });
  } else {
    toggleSimulation();
  }
  updateSimulationButton();
});

const resizeObserver = new ResizeObserver(drawChart);
resizeObserver.observe(elements.chart);
window.addEventListener('resize', drawChart);

let observedTimezoneOffset = new Date().getTimezoneOffset();
window.setInterval(() => {
  const timezoneOffset = new Date().getTimezoneOffset();
  if (timezoneOffset === observedTimezoneOffset) return;
  observedTimezoneOffset = timezoneOffset;
  if (ble.deviceId !== null) void synchronizeClock({ automatic: true });
}, 30_000);

simulator.start();
