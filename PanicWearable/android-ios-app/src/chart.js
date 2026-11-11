export const SERIES = [
  { key: 'heartRate', label: 'Puls', min: 50, max: 110, color: '#ac4c3d' },
  { key: 'respirationRate', label: 'Atmung', min: 8, max: 28, color: '#27766a' },
];

export function drawChart(canvas, points, start, end, series) {
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return;
  const pixelRatio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  const context = canvas.getContext('2d');
  if (!context) return;
  context.scale(pixelRatio, pixelRatio);
  const left = 34;
  const right = 5;
  const top = 10;
  const bottom = height - 10;
  const windowPoints = points.filter((point) => point.at >= start && point.at <= end);
  const values = windowPoints.map((point) => point[series.key]).filter(Number.isFinite);
  const min = Math.max(0, Math.min(series.min, Math.floor(Math.min(...values) / 5) * 5));
  const max = Math.max(series.max, Math.ceil(Math.max(...values) / 5) * 5);
  const plotWidth = width - left - right;

  context.font = '11px system-ui';
  context.textBaseline = 'middle';
  context.fillStyle = '#62726c';
  context.strokeStyle = '#e1e9e3';
  context.lineWidth = 1;
  for (const [index, y] of [top, (top + bottom) / 2, bottom].entries()) {
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(width - right, y);
    context.stroke();
    if (index !== 1) context.fillText(String(index === 0 ? max : min), 0, y);
  }

  context.strokeStyle = series.color;
  context.fillStyle = series.color;
  context.lineWidth = 2;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  const maxGap = series.maxGap ?? 3_000;
  let previous = null;
  for (const point of windowPoints) {
    const value = point[series.key];
    if (!Number.isFinite(value)) {
      previous = null;
      continue;
    }
    const x = left + ((point.at - start) / Math.max(1, end - start)) * plotWidth;
    const y = bottom - ((value - min) / (max - min)) * (bottom - top);
    context.beginPath();
    const allowedGap = point.aggregated || previous?.aggregated ? Math.max(maxGap, 90_000) : maxGap;
    if (previous && point.at >= previous.at && point.at - previous.at <= allowedGap) {
      context.moveTo(previous.x, previous.y);
      context.lineTo(x, y);
      context.stroke();
    } else {
      context.arc(x, y, 2, 0, Math.PI * 2);
      context.fill();
    }
    previous = { x, y, at: point.at, aggregated: point.aggregated };
  }
}
