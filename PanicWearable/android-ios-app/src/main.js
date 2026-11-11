import './style.css';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { Share } from '@capacitor/share';
import { BleClient } from '@capacitor-community/bluetooth-le';
import { BleTransport } from './ble/ble-transport.js';
import { WebBluetoothClient } from './ble/web-bluetooth-client.js';
import { WatchHistorySync } from './ble/watch-history-sync.js';
import { watchBrowserVisibility } from './browser-visibility.js';
import { drawChart, SERIES } from './chart.js';
import { average, History } from './history.js';
import { DailyDatabase } from './daily-database.js';
import { DailyView } from './daily-view.js';
import { createSimulator } from './simulator.js';
import { icon, layout } from './view.js';

async function boot() {
  const app = document.querySelector('#app');
  app.innerHTML = layout;
  const byId = (id) => document.getElementById(id);
  const all = (selector) => app.querySelectorAll(selector);
  const text = (id, value) => {
    const element = byId(id);
    if (element.textContent !== value) element.textContent = value;
  };
  const native = Capacitor.isNativePlatform();
  const fullDate = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  const dayDate = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
  const shortTime = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const rate = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
  const settingsKey = 'calmdown.settings.v1';
  const historyKey = 'calmdown.history.v1';
  const titles = { overview: 'overview-title', history: 'history-title', device: 'device-title' };
  const cancellable = new Set(['connecting', 'reconnecting', 'paused', 'awaiting', 'live', 'stale']);
  let chartWindow = 600_000;

  let view = 'overview';
  let active = !document.hidden;
  let demo = false;
  let demoSample = null;
  let livePoints = [];
  let storedPoints = [];
  let graphIsTest = null;
  let currentSession = null;
  let selectedRow = null;
  let exportBusy = false;
  let toastTimer;
  let settingsWrites = Promise.resolve();
  const historyRows = new Map();
  const settings = { autoReconnect: true, saveHistory: true };

  function toast(message) {
    clearTimeout(toastTimer);
    text('toast', message);
    byId('toast').hidden = false;
    toastTimer = setTimeout(() => { byId('toast').hidden = true; }, 6_000);
  }

  async function readStorage(key) {
    try {
      const { value } = await Preferences.get({ key });
      return value;
    } catch {
      toast('Der lokale Speicher ist gerade nicht verfügbar.');
      return undefined;
    }
  }

  const [rawHistory, rawSettings] = await Promise.all([readStorage(historyKey), readStorage(settingsKey)]);
  try {
    const stored = JSON.parse(rawSettings);
    for (const key of Object.keys(settings)) {
      if (typeof stored?.[key] === 'boolean') settings[key] = stored[key];
    }
  } catch {
    // Keep defaults if older or damaged settings cannot be read.
  }

  const history = new History({
    raw: rawHistory,
    persist: (value) => Preferences.set({ key: historyKey, value }),
    onChange: () => { if (view === 'history') renderHistory(); },
    onError: () => toast('Der Verlauf konnte nicht gespeichert werden.'),
  });

  let dailyView;
  const dailyDatabase = new DailyDatabase({
    onChange: () => dailyView?.changed(),
    onError: (error) => dailyView?.failed(error),
  });
  dailyView = new DailyView(dailyDatabase, {
    onChange: () => renderHistory(),
    onRecent: (points) => {
      storedPoints = points;
      if (view === 'overview') renderLiveChart();
    },
    notify: toast,
  });

  const watchHistory = new WatchHistorySync({
    database: dailyDatabase,
    enabled: () => active && !demo && settings.saveHistory,
    onChange: () => renderConnection(),
  });

  const ble = new BleTransport(native ? BleClient : new WebBluetoothClient(navigator.bluetooth), {
    onChange: (state) => {
      if (state.status !== 'live') history.finish();
      if (!['live', 'stale', 'awaiting'].includes(state.status) && !demo) clearGraph();
      renderConnection();
    },
    onMeasurement: (sample) => {
      if (!active || demo) return;
      recordGraph(sample);
    },
    recordEnabled: () => active && !demo && settings.saveHistory,
    onLegacyMeasurement: (sample) => { void dailyDatabase.record(sample).catch(() => {}); },
    onHistory: (access) => { void watchHistory.setAccess(access); },
  });
  const simulator = createSimulator((sample) => {
    if (!active || !demo) return;
    demoSample = sample;
    recordGraph(sample);
    renderConnection();
  });

  function showView(next, focus = true) {
    if (!Object.prototype.hasOwnProperty.call(titles, next)) return;
    view = next;
    for (const page of all('.page')) page.hidden = page.id !== next;
    for (const tab of all('.tab')) {
      if (tab.dataset.view === next) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
    if (next === 'history' || next === 'device') renderHistory();
    if (next === 'history') {
      dailyView.render();
      void dailyView.refresh();
    }
    if (next === 'overview') renderLiveChart();
    if (focus) {
      window.scrollTo(0, 0);
      byId(titles[next]).focus({ preventScroll: true });
    }
  }

  const linkText = {
    idle: 'Nicht verbunden', selecting: 'Geräteauswahl', connecting: 'Verbindet …',
    awaiting: 'Wartet auf Daten', live: 'Uhr verbunden', stale: 'Keine neuen Daten',
    reconnecting: 'Verbindet erneut …', paused: 'Verbindung pausiert', disconnected: 'Getrennt',
  };

  function renderConnection() {
    const state = ble.state;
    const sample = demo ? demoSample : state.measurement;
    const test = demo || Boolean(sample?.demo);
    const status = state.status;
    const connected = ['awaiting', 'live', 'stale'].includes(status);
    const action = cancellable.has(status) ? 'disconnect' : 'connect';
    const actionLabel = status === 'reconnecting' || status === 'connecting' || status === 'paused'
      ? 'Verbindung abbrechen' : connected ? 'Uhr trennen'
        : status === 'selecting' ? 'Geräteauswahl …' : 'Uhr verbinden';

    text('app-connection', demo ? 'Demo aktiv' : linkText[status]);
    document.querySelector('.connection-pill').dataset.state = test ? 'demo' : status;
    for (const button of all('button[data-action="connect"]')) {
      button.dataset.linkAction = action;
      button.querySelector('span').textContent = actionLabel;
      button.disabled = action === 'connect' && state.busy;
    }
    for (const button of all('button[data-action="toggle-demo"]')) {
      button.innerHTML = demo ? `Demo beenden ${icon('arrow')}` : `Demo ausprobieren ${icon('arrow')}`;
      button.disabled = status === 'selecting';
    }
    byId('demo-warning-button').hidden = !demo;
    byId('demo-banner').hidden = !test;
    byId('demo-banner').querySelector('button').hidden = !demo;
    text('demo-label', demo ? 'Demo läuft' : 'Uhr im Testmodus');
    text('demo-copy', demo ? 'Die Werte stammen aus der Simulation.' : 'Die Uhr sendet Testpakete. Sie werden nicht gespeichert.');

    const message = state.error || {
      idle: 'Verbinde den StressMonitor, um deine Livewerte direkt zu empfangen.',
      selecting: 'Wähle deinen StressMonitor aus.',
      connecting: 'Bluetooth-Verbindung wird hergestellt.',
      awaiting: 'Verbunden. Die App wartet auf das erste Messpaket.',
      live: 'Die Uhr überträgt Messwerte direkt an diese App.',
      stale: 'Es kommen gerade keine neuen Messwerte an.',
      reconnecting: state.attempt ? `Verbindungsversuch ${state.attempt} von 3.` : 'Die Verbindung wird wiederhergestellt.',
      paused: 'Die App wartet auf den Vordergrund.',
      disconnected: 'Verbinde die Uhr erneut.',
    }[status];
    text('connect-copy', message);
    text('device-message', status === 'reconnecting' && state.attempt ? `${message} Versuch ${state.attempt} von 3.` : message);
    text('device-name', state.deviceName || 'StressMonitor');
    const clockMessage = {
      idle: 'Die Zeit wird beim Verbinden übertragen.',
      sending: 'Zeit wird gesendet …',
      sent: state.clock.at ? `Gesendet um ${shortTime.format(state.clock.at)}. Die dauerhafte Speicherung ist unbestätigt.` : '',
      failed: 'Zeit konnte nicht übertragen werden. Versuche es erneut.',
    };
    text('clock-state', clockMessage[state.clock.status] || clockMessage.idle);
    byId('sync-clock').disabled = !state.canSync;
    text('diag-packet', !demo && sample ? `#${sample.packetCount} · ${shortTime.format(sample.receivedAt)}` : '–');
    text('diag-adc', !demo && sample ? String(sample.adc) : '–');
    text('diag-optics', !demo && sample?.maxFresh ? `${sample.ir} / ${sample.red}` : '–');
    text('diag-errors', String(state.invalidPackets));
    text('diag-delivery', state.deliveryMode === 'read' ? 'Direktes Lesen (1 s)'
      : state.deliveryMode === 'notifications' ? 'BLE-Benachrichtigungen' : '–');
    text('diag-step', state.diagnostic?.step || message);
    text('diag-error', state.diagnostic?.error || 'Kein Fehler gemeldet');
    const { phase, status: storage, imported, error: historyError } = watchHistory.state;
    const messages = {
      checking: 'Uhrspeicher wird geprüft …',
      syncing: `Uhrverlauf wird übertragen · ${imported} Minuten übernommen`,
      ready: imported ? `Uhrverlauf abgeglichen · ${imported} Minuten übernommen` : 'Uhrverlauf aktuell',
      unavailable: 'Uhrspeicher nicht verfügbar',
      error: 'Abgleich unterbrochen. Calmdown versucht es erneut.',
    };
    const storageMessage = !settings.saveHistory
      ? state.historyMode === 'watch' ? 'Übernahme in die App ist ausgeschaltet; die Uhr speichert weiter.' : 'Aufzeichnung in der App ist ausgeschaltet.'
      : state.historyMode === 'legacy' ? 'Diese Firmware speichert nur über die verbundene App.'
        : state.historyMode === 'checking' ? 'Uhrspeicher wird geprüft. Livewerte bleiben sichtbar.'
          : messages[phase] || 'Uhrverlauf verfügbar, sobald die Uhr verbunden ist.';
    text('history-sync-status', storageMessage);
    text('diag-storage', storage ? `${storage.count} / ${storage.capacity} gespeicherte Minuten` : '–');
    const notes = [];
    if (storage && !storage.clockValid) notes.push('Uhrzeit fehlt; neue Minuten werden noch nicht gespeichert.');
    if (storage?.overflow) notes.push('Ältere Minuten fehlen im Ringspeicher.');
    if (storage?.gap) notes.push('Der Uhrspeicher meldet eine Lücke.');
    if (storage?.errorCode) notes.push('Uhrspeicher-Code ' + storage.errorCode + '.');
    if (historyError) notes.push(historyError);
    text('diag-storage-note', notes.join(' ') || '–');
    renderLive(sample, test, status);
  }

  function renderLive(sample, test, status) {
    text('live-label', test ? 'Testdaten' : {
      live: 'Live', awaiting: 'Wartet auf Daten', stale: 'Keine neuen Daten',
      selecting: 'Verbindet …', connecting: 'Verbindet …', reconnecting: 'Verbindet erneut …',
    }[status] ?? 'Wartet auf Uhr');
    byId('live-status').dataset.state = test ? 'demo' : status;
    text('pulse', sample?.heartRate != null ? rate.format(sample.heartRate) : '–');
    text('respiration', sample?.respirationRate != null ? rate.format(sample.respirationRate) : '–');
    text('pulse-hint', sample && sample.heartRate === null ? 'Kein Pulssignal' : 'Schläge pro Minute');
    text('respiration-hint', sample && sample.respirationRate === null ? 'Kein Atemsignal' : 'Atemzüge pro Minute');
    text('signal-status', sample
      ? test ? 'Testmodus · Werte zur Erprobung' : `Empfangen um ${shortTime.format(sample.receivedAt)} · Atmung experimentell`
      : status === 'stale' ? 'Letzte Messwerte sind veraltet.'
        : ['live', 'awaiting'].includes(status) ? 'Wartet auf das erste Messpaket.'
          : 'Verbinde den StressMonitor, um Messwerte zu sehen.');
    const warning = sample?.warning || sample?.state === 2;
    byId('watch-event').hidden = !warning;
    text('watch-event-title', test ? 'Testwarnung' : 'Warnung von der Uhr');
    text('watch-event-copy', test
      ? 'So sieht eine Warnmeldung in Calmdown aus.' : 'Die Uhr meldet erhöhte Puls- und Atemwerte.');
  }

  function recordGraph(sample) {
    if (graphIsTest !== sample.demo) clearGraph();
    graphIsTest = sample.demo;
    livePoints.push({ at: sample.receivedAt || Date.now(), heartRate: sample.heartRate, respirationRate: sample.respirationRate });
    if (livePoints.length > 3_600) livePoints.shift();
    if (view === 'overview') renderLiveChart();
  }

  function clearGraph() {
    livePoints = [];
    graphIsTest = null;
    renderLiveChart();
  }

  function renderLiveChart() {
    const now = Date.now();
    livePoints = livePoints.filter((point) => point.at > now - 3_600_000);
    const saved = demo || graphIsTest === true ? [] : storedPoints;
    // Keep imported minutes throughout the window, including reconnect gaps.
    // A live sample takes precedence when both sources have the same timestamp.
    const byTime = new Map(saved.map((point) => [point.at, point]));
    for (const point of livePoints) byTime.set(point.at, point);
    const points = [...byTime.values()]
      .filter((point) => point.at > now - chartWindow && point.at <= now)
      .sort((left, right) => left.at - right.at);
    const hasValues = points.some((point) => Number.isFinite(point.heartRate) || Number.isFinite(point.respirationRate));
    byId('live-chart-empty').hidden = hasValues;
    byId('live-chart').hidden = !hasValues;
    if (!hasValues || view !== 'overview') return;
    text('live-chart-from', chartWindow === 60_000 ? 'vor 1 min' : chartWindow === 600_000 ? 'vor 10 min' : 'vor 1 h');
    text('live-chart-to', 'jetzt');
    drawChart(byId('live-chart-pulse'), points, now - chartWindow, now, SERIES[0]);
    drawChart(byId('live-chart-breath'), points, now - chartWindow, now, SERIES[1]);
  }

  function startDemo() {
    ble.disconnect();
    history.finish();
    clearGraph();
    demo = true;
    showView('overview');
    simulator.start();
    renderConnection();
  }

  function stopDemo() {
    simulator.stop();
    demo = false;
    demoSample = null;
    clearGraph();
    renderConnection();
  }

  function sessionStats(session) {
    const heart = average(session.heart);
    const breath = average(session.breath);
    return [heart !== null ? `Ø ${rate.format(heart)} bpm` : 'Kein Puls',
      breath !== null ? `Ø ${rate.format(breath)} /min` : 'Keine Atmung',
      session.warnings ? `${session.warnings} ${session.warnings === 1 ? 'Warnung' : 'Warnungen'}` : 'Keine Warnung aufgezeichnet',
    ].join(' · ');
  }

  function renderHistory() {
    byId('history-recovery').hidden = !history.issue;
    text('history-recovery-copy', history.issue === 'corrupt'
      ? 'Der bisherige Inhalt bleibt erhalten. Du kannst die älteren Rohdaten sichern oder diesen alten Speicher zurücksetzen.'
      : 'Die älteren Aufzeichnungen sind gerade nicht erreichbar. Die Tagesdatenbank hat ihren eigenen Speicher.');
    for (const button of all('[data-action="backup-history"], [data-action="reset-history"]')) {
      button.hidden = history.issue !== 'corrupt';
      button.disabled = exportBusy;
    }
    byId('save-history').disabled = false;
    byId('history-empty').hidden = true;
    byId('legacy-history-heading').hidden = !history.sessions.length;
    const rows = [];
    const ids = new Set(history.sessions.map((session) => session.id));
    for (const id of historyRows.keys()) {
      if (!ids.has(id)) historyRows.delete(id);
    }
    for (const session of history.sessions) {
      if (!historyRows.has(session.id)) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'card history-row';
        row.dataset.action = 'open-session';
        row.dataset.session = session.id;
        row.innerHTML = `<span class="round-icon">${icon('history')}</span><span class="history-copy"><strong></strong><small></small></span>${icon('chevron')}`;
        historyRows.set(session.id, row);
      }
      const row = historyRows.get(session.id);
      row.querySelector('strong').textContent = fullDate.format(session.startedAt);
      row.querySelector('small').textContent = `${history.activeId === session.id ? 'Läuft · ' : ''}${sessionStats(session)}`;
      row.setAttribute('aria-expanded', String(currentSession === session.id));
      row.setAttribute('aria-controls', 'history-detail');
      rows.push(row);
    }
    const list = byId('history-entries');
    if (list.children.length !== rows.length || rows.some((row, index) => row !== list.children[index])) {
      list.replaceChildren(...rows);
    }
    const selected = history.sessions.find((session) => session.id === currentSession);
    byId('history-detail').hidden = !selected;
    if (selected) renderHistoryDetail(selected);
    text('history-settings-note', settings.saveHistory
      ? 'Neue Messwerte bleiben als Tagesdaten auf diesem Gerät. Ältere Aufzeichnungen bleiben separat erhalten. Der Export enthält beide Bereiche.'
      : 'Übernahme in die App ist ausgeschaltet. Eine Uhr mit eigenem Speicher zeichnet weiter auf.');
    for (const button of all('[data-action="export"], [data-action="delete-history"]')) {
      button.disabled = (!rows.length && !dailyView?.hasData) || exportBusy;
    }
  }

  function renderHistoryDetail(session) {
    text('history-detail-title', fullDate.format(session.startedAt));
    const seconds = Math.round((session.endedAt - session.startedAt) / 1_000);
    const duration = seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
    text('history-detail-meta', `${duration} · ${sessionStats(session)}`);
    const eventRows = session.events.filter(({ kind }) => kind === 'warning').map((event) => {
      const li = document.createElement('li');
      li.textContent = `${shortTime.format(event.at)} · Warnung gemeldet`;
      return li;
    });
    if (!eventRows.length) {
      const li = document.createElement('li');
      li.textContent = 'Keine Uhrmeldungen aufgezeichnet.';
      eventRows.push(li);
    }
    byId('history-events').replaceChildren(...eventRows);

    const hasValues = session.points.some((point) => point.heartRate !== null || point.respirationRate !== null);
    byId('history-chart').hidden = !hasValues;
    if (!hasValues) return;
    const times = session.points.map((point) => point.at);
    const start = Math.min(...times);
    const end = Math.max(...times, start + 1);
    text('saved-chart-from', shortTime.format(start));
    text('saved-chart-to', shortTime.format(end));
    drawChart(byId('saved-chart-pulse'), session.points, start, end, { ...SERIES[0], maxGap: 8_000 });
    drawChart(byId('saved-chart-breath'), session.points, start, end, { ...SERIES[1], maxGap: 8_000 });
  }

  function closeDetail() {
    currentSession = null;
    byId('remove-session-confirm').hidden = true;
    renderHistory();
    (selectedRow?.isConnected ? selectedRow : byId('history-title')).focus();
  }

  async function exportHistory() {
    try {
      let daily = null;
      let dailyIssue = null;
      try {
        daily = await dailyDatabase.export();
      } catch (error) {
        if (!history.sessions.length) throw error;
        dailyIssue = 'Tagesdaten konnten nicht gelesen werden: ' + String(error?.message || error);
      }
      const data = {
        version: 2,
        exportedAt: new Date().toISOString(),
        daily,
        dailyIssue,
        legacySessions: JSON.parse(history.export()).sessions,
        legacyIssue: history.issue,
      };
      const exported = await exportFile(JSON.stringify(data, null, 2), 'verlauf', 'json');
      if (exported && dailyIssue) toast('Der Export enthält die älteren Aufzeichnungen. Die Tagesdatenbank konnte nicht gelesen werden.');
    } catch {
      toast('Die Tagesdaten konnten nicht exportiert werden. Prüfe den Datenbankstatus unter Verlauf.');
    }
  }

  async function exportFile(data, label, extension) {
    if (exportBusy) return false;
    exportBusy = true;
    renderHistory();
    const filename = `calmdown-${label}-${new Date().toISOString().slice(0, 10)}.${extension}`;
    try {
      if (native) {
        const { uri } = await Filesystem.writeFile({ path: filename, data, directory: Directory.Cache, encoding: Encoding.UTF8 });
        try {
          await Share.share({ title: 'Calmdown-Verlauf', files: [uri] });
        } finally {
          await Filesystem.deleteFile({ path: filename, directory: Directory.Cache }).catch(() => {});
        }
      } else {
        const url = URL.createObjectURL(new Blob([data], { type: extension === 'json' ? 'application/json' : 'text/plain' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        app.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
      }
    } catch (error) {
      if (!/cancel/i.test(error?.message)) toast('Der Export konnte nicht erstellt werden.');
      return false;
    } finally {
      exportBusy = false;
      renderHistory();
    }
    return true;
  }

  function setActive(value, updateConnection = true) {
    if (updateConnection) ble.setActive(value);
    if (active === value) return;
    active = value;
    if (!active) {
      history.finish();
      simulator.stop();
      demoSample = null;
      clearGraph();
    } else if (demo) {
      simulator.start();
    }
    renderConnection();
  }

  const actions = {
    connect(button) {
      if (button.dataset.linkAction === 'disconnect') {
        ble.disconnect();
      } else if (!native && (!window.isSecureContext || !navigator.bluetooth)) {
        showView('device');
        toast('Dieser Browser bietet keinen Bluetooth-Zugriff. Öffne die HTTPS-Seite auf dem iPhone in Bluefy oder verwende die installierte App.');
      } else {
        if (demo) stopDemo();
        void ble.connect();
      }
    },
    'toggle-demo': () => demo ? stopDemo() : startDemo(),
    'stop-demo': stopDemo,
    'demo-warning'() {
      simulator.triggerWarning();
      showView('overview');
    },
    'sync-clock': () => void ble.syncClock(),
    export: () => void exportHistory(),
    'backup-history': () => void exportFile(history.recoveryBackup, 'sicherung', 'txt'),
    'reset-history': () => { byId('reset-history-confirm').hidden = false; },
    'cancel-reset-history': () => { byId('reset-history-confirm').hidden = true; },
    async 'confirm-reset-history'(button) {
      button.disabled = true;
      try {
        if (await history.resetCorruptHistory()) {
          byId('reset-history-confirm').hidden = true;
          toast('Verlauf zurückgesetzt.');
          byId('history-title').focus();
        }
      } finally {
        button.disabled = false;
      }
    },
    'open-session'(button) {
      selectedRow = button;
      currentSession = button.dataset.session;
      byId('remove-session-confirm').hidden = true;
      renderHistory();
      byId('history-detail-title').focus();
    },
    'close-detail': closeDetail,
    'remove-session': () => { byId('remove-session-confirm').hidden = false; },
    'cancel-remove-session': () => { byId('remove-session-confirm').hidden = true; },
    async 'confirm-remove-session'() {
      if (!currentSession) return;
      const id = currentSession;
      closeDetail();
      const result = await history.remove(id);
      if (result !== false) toast('Messung gelöscht.');
      if (!selectedRow?.isConnected) byId('history-title').focus();
    },
    'delete-history': () => { byId('clear-history-confirm').hidden = false; },
    'cancel-delete-history': () => { byId('clear-history-confirm').hidden = true; },
    async 'confirm-delete-history'() {
      currentSession = null;
      try {
        await dailyDatabase.clear();
        const result = history.issue === 'corrupt' ? await history.resetCorruptHistory() : await history.clear();
        if (result === false) {
          toast('Tagesdaten gelöscht. Der ältere Speicher konnte nicht gelöscht werden. Prüfe die Hinweise unter Verlauf.');
        } else {
          byId('clear-history-confirm').hidden = true;
          toast('Verlauf gelöscht. Neue Messungen werden bei aktiver Aufzeichnung weiter gespeichert.');
        }
        await dailyView.refresh();
        renderHistory();
      } catch {
        toast('Der Verlauf konnte nicht vollständig gelöscht werden. Bitte erneut versuchen.');
      }
    },
  };

  app.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.view) showView(button.dataset.view);
    else if (button.dataset.action) void actions[button.dataset.action]?.(button);
  });

  byId('live-range').addEventListener('change', (event) => {
    const next = Number(event.target.value);
    if (next === 60_000 || next === 600_000 || next === 3_600_000) chartWindow = next;
    renderLiveChart();
  });
  for (const [id, key] of [['auto-reconnect', 'autoReconnect'], ['save-history', 'saveHistory']]) {
    byId(id).checked = settings[key];
    byId(id).addEventListener('change', (event) => {
      settings[key] = event.target.checked;
      if (key === 'autoReconnect') ble.setAutoReconnect(settings.autoReconnect);
      if (!settings.saveHistory) history.finish();
      const value = JSON.stringify(settings);
      settingsWrites = settingsWrites.then(() => Preferences.set({ key: settingsKey, value }))
        .catch(() => toast('Einstellungen konnten nicht gespeichert werden.'));
    });
  }

  function watchVisibility() {
    document.addEventListener('visibilitychange', () => setActive(!document.hidden));
  }

  ble.setAutoReconnect(settings.autoReconnect);
  ble.setActive(active);
  if (native) {
    // Native events cover iOS lock and app switching even when the WebView does
    // not dispatch a DOM visibility event.
    void App.addListener('appStateChange', ({ isActive }) => setActive(isActive))
      .catch(watchVisibility);
  } else {
    watchBrowserVisibility(document, {
      onHidden: () => setActive(false, false),
      onVisible: () => setActive(true),
      onPause: () => ble.setActive(false),
    });
  }
  window.addEventListener('resize', () => {
    if (view === 'overview') renderLiveChart();
    if (view === 'history') renderHistory();
    if (view === 'history') dailyView.draw();
  });
  setInterval(() => {
    ble.tick();
    void watchHistory.tick();
    dailyView.tick();
    if (active && view === 'overview') renderLiveChart();
    text('today', dayDate.format(Date.now()));
  }, 500);

  text('today', dayDate.format(Date.now()));
  renderConnection();
  renderHistory();
  dailyView.render();
  void dailyView.initialize();
  showView('overview', false);
  if (history.issue === 'corrupt') toast('Der gespeicherte Verlauf ist nicht lesbar. Unter Verlauf kannst du ihn sichern.');
}

void boot().catch((error) => {
  console.error(error);
  document.querySelector('#app').textContent = 'Calmdown konnte nicht gestartet werden. Öffne die App erneut.';
});
