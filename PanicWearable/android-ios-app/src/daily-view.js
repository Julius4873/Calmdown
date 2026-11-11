import { aggregatePoint, calendarMonth, DAILY_METRICS, dayDate, localMinute, moveMonth } from './daily-data.js';
import { drawChart } from './chart.js';

const dateLabel = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthLabel = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const number = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });

export class DailyView {
  #revision = 0;
  #refreshTimer = null;
  #dayData = { summary: null, minutes: [] };
  #deletingDay = null;
  #today = localMinute(Date.now()).day;
  #followToday = true;
  #days = new Set();

  constructor(database, { onChange, onRecent, notify }) {
    this.database = database;
    this.onChange = onChange;
    this.onRecent = onRecent;
    this.notify = notify;
    this.selectedDay = this.#today;
    this.month = this.selectedDay.slice(0, 7);
    this.hasData = false;
    this.ready = false;
    this.issue = null;
    this.metric = 'heartRate';
    this.byId = (id) => document.getElementById(id);
    this.byId('daily-calendar').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-day]');
      if (button) void this.select(button.dataset.day);
    });
    this.byId('daily-calendar').addEventListener('keydown', (event) => this.#calendarKey(event));
    this.byId('calendar-previous').addEventListener('click', () => this.#browse(-1));
    this.byId('calendar-next').addEventListener('click', () => this.#browse(1));
    this.byId('calendar-today').addEventListener('click', () => {
      this.#followToday = true;
      void this.select(localMinute(Date.now()).day);
    });
    this.byId('daily-metric').addEventListener('change', (event) => {
      this.metric = event.target.value;
      this.draw();
    });
    this.byId('database-retry').addEventListener('click', () => {
      void this.database.retry().then(() => this.refresh()).catch((error) => this.failed(error));
    });
    this.byId('delete-day').addEventListener('click', () => {
      this.#deletingDay = this.selectedDay;
      this.byId('delete-day-question').textContent = dateLabel.format(dayDate(this.#deletingDay)) + ' endgültig löschen?';
      this.byId('delete-day-confirm').hidden = false;
    });
    this.byId('cancel-delete-day').addEventListener('click', () => {
      this.byId('delete-day-confirm').hidden = true;
      this.#deletingDay = null;
    });
    this.byId('confirm-delete-day').addEventListener('click', () => void this.#deleteDay());
  }

  async initialize() {
    try {
      await this.database.open();
      await this.refresh();
    } catch (error) {
      this.failed(error);
    }
  }

  failed(error) {
    this.issue = error;
    const message = error?.name === 'QuotaExceededError'
      ? 'Der Browserspeicher ist voll. Exportiere deine Daten und lösche ältere Tage.'
      : 'Die Tagesdatenbank ist gerade nicht verfügbar. Livewerte bleiben nutzbar.';
    if (this.byId('database-state').textContent !== message) this.byId('database-state').textContent = message;
    this.byId('database-error').textContent = String(error?.message || 'Prüfe die Speichereinstellungen von Bluefy.').slice(0, 240);
    this.byId('database-retry').hidden = false;
    this.byId('database-state').dataset.state = 'error';
    this.onChange();
  }

  changed() {
    if (this.#refreshTimer !== null) return;
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      void this.refresh();
    }, 1_000);
  }

  async refresh() {
    const revision = ++this.#revision;
    const selectedDay = this.selectedDay;
    const month = this.month;
    try {
      const [days, data, total, recent] = await Promise.all([
        this.database.listDays(month),
        this.database.getDay(selectedDay),
        this.database.countDays(),
        this.database.recent(Date.now() - 3_600_000),
      ]);
      if (revision !== this.#revision) return;
      this.#days = new Set(days.map(({ day }) => day));
      this.#dayData = data;
      this.hasData = total > 0;
      this.ready = true;
      this.issue = this.database.issue;
      if (!this.issue) {
        const message = 'Tagesdaten werden lokal in diesem Browser gespeichert.';
        if (this.byId('database-state').textContent !== message) this.byId('database-state').textContent = message;
        this.byId('database-state').dataset.state = 'ready';
        this.byId('database-error').textContent = '';
        this.byId('database-retry').hidden = true;
      }
      this.onRecent(recent.map(aggregatePoint));
      this.render();
      this.onChange();
    } catch (error) {
      if (revision === this.#revision) this.failed(error);
    }
  }

  async select(day) {
    this.#followToday = day === localMinute(Date.now()).day;
    this.selectedDay = day;
    this.month = day.slice(0, 7);
    this.byId('delete-day-confirm').hidden = true;
    this.#deletingDay = null;
    await this.refresh();
  }

  #browse(delta) {
    this.month = moveMonth(this.month, delta);
    void this.refresh();
  }

  tick() {
    const today = localMinute(Date.now()).day;
    if (today === this.#today) return;
    this.#today = today;
    if (this.#followToday) {
      this.selectedDay = today;
      this.month = today.slice(0, 7);
    }
    void this.refresh();
  }

  render() {
    this.byId('calendar-month').textContent = monthLabel.format(dayDate(this.month + '-01'));
    const existing = new Map([...this.byId('daily-calendar').querySelectorAll('button[data-day]')]
      .map((button) => [button.dataset.day, button]));
    const cells = calendarMonth(this.month).map((day) => {
      if (!day) {
        const blank = document.createElement('span');
        blank.className = 'calendar-blank';
        return blank;
      }
      const button = existing.get(day) || document.createElement('button');
      button.type = 'button';
      button.className = 'calendar-day';
      button.dataset.day = day;
      button.textContent = String(Number(day.slice(-2)));
      button.dataset.hasData = String(this.#days.has(day));
      button.setAttribute('aria-label', dateLabel.format(dayDate(day)) + (this.#days.has(day) ? ', Messwerte vorhanden' : ', keine Messwerte'));
      button.setAttribute('aria-pressed', String(day === this.selectedDay));
      if (day === this.#today) button.setAttribute('aria-current', 'date');
      else button.removeAttribute('aria-current');
      button.tabIndex = day === this.selectedDay || (!this.selectedDay.startsWith(this.month) && day.endsWith('-01')) ? 0 : -1;
      return button;
    });
    // Reuse day buttons to preserve keyboard focus during live updates.
    const calendar = this.byId('daily-calendar');
    const focused = document.activeElement?.dataset.day;
    calendar.replaceChildren(...cells);
    if (focused) calendar.querySelector(`[data-day="${focused}"]`)?.focus({ preventScroll: true });
    this.byId('selected-day-title').textContent = dateLabel.format(dayDate(this.selectedDay));
    const summary = this.#dayData.summary;
    this.byId('daily-empty').hidden = Boolean(summary);
    this.byId('daily-summary').hidden = !summary;
    this.byId('daily-chart-area').hidden = !summary;
    this.byId('delete-day').disabled = !summary;
    for (const { key, unit } of DAILY_METRICS) {
      const metric = summary?.metrics[key];
      this.byId(key + '-average').textContent = metric?.count ? number.format(metric.sum / metric.count) : '–';
      this.byId(key + '-maximum').textContent = metric?.count ? number.format(metric.max) : '–';
      this.byId(key + '-day-note').textContent = metric?.count
        ? metric.count + ' Messwerte · ' + unit : 'Für diesen Tag nicht übertragen';
    }
    this.byId('daily-count').textContent = summary ? 'Durchschnitt aller gültigen Einzelwerte' : '';
    this.draw();
  }

  draw() {
    const metric = DAILY_METRICS.find(({ key }) => key === this.metric);
    const points = this.#dayData.minutes.map(aggregatePoint);
    const hasMetric = points.some((point) => Number.isFinite(point[this.metric]));
    this.byId('daily-chart-empty').hidden = hasMetric;
    this.byId('daily-chart-empty').textContent = 'Für ' + metric.label + ' wurden an diesem Tag keine Werte übertragen.';
    this.byId('daily-chart-wrap').hidden = !hasMetric;
    if (!hasMetric) return;
    const start = this.#dayData.minutes[0].minute * 60_000;
    const end = (this.#dayData.minutes[this.#dayData.minutes.length - 1].minute + 1) * 60_000;
    const labelTime = (at, point) => new Intl.DateTimeFormat('de-DE', {
      timeZone: point.timeZone || 'UTC', hour: '2-digit', minute: '2-digit',
    }).format(point.timeZone ? at : at + (point.offsetMinutes || 0) * 60_000);
    this.byId('daily-chart-from').textContent = labelTime(start, points[0]);
    this.byId('daily-chart-to').textContent = labelTime(end, points[points.length - 1]);
    this.byId('daily-chart-canvas').setAttribute('aria-label', metric.label + ' als Minutenmittel am ' + dateLabel.format(dayDate(this.selectedDay)));
    drawChart(this.byId('daily-chart-canvas'), points, start, end, { ...metric, maxGap: 120_000 });
  }

  async #deleteDay() {
    const day = this.#deletingDay;
    if (!day) return;
    this.byId('confirm-delete-day').disabled = true;
    try {
      await this.database.deleteDay(day);
      this.byId('delete-day-confirm').hidden = true;
      this.#deletingDay = null;
      await this.refresh();
      this.notify('Tagesdaten gelöscht. Neue Messungen werden weiterhin gespeichert, wenn die Aufzeichnung aktiv ist.');
    } catch (error) {
      this.failed(error);
    } finally {
      this.byId('confirm-delete-day').disabled = false;
    }
  }

  #calendarKey(event) {
    const day = event.target.dataset.day;
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (!day || delta === undefined) return;
    event.preventDefault();
    const date = dayDate(day);
    date.setUTCDate(date.getUTCDate() + delta);
    const target = date.toISOString().slice(0, 10);
    void this.select(target).then(() => this.byId('daily-calendar').querySelector(`[data-day="${target}"]`)?.focus());
  }
}
