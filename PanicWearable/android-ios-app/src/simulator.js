export function createSimulator(onMeasurement) {
  let timerId = null;
  let tick = 0;

  function publish() {
    tick += 1;
    const now = Date.now();
    const heartRate = Math.round(74 + Math.sin(tick / 5) * 5 + Math.sin(tick / 13) * 3);
    const respirationRate = Math.round(15 + Math.sin(tick / 9) * 2);

    onMeasurement({
      valid: true,
      heartRate,
      respirationRate,
      maxFresh: true,
      warning: false,
      breathAssist: false,
      demo: true,
      packetCount: tick & 0xffff,
      uptimeMs: tick * 1200,
      adc: 2400 + Math.round(Math.sin(tick / 4) * 250),
      ir: 18000 + Math.round(Math.sin(tick / 5) * 1500),
      red: 15000 + Math.round(Math.sin(tick / 6) * 1200),
      state: 0,
      receivedAt: now,
    });
  }

  return {
    start() {
      if (timerId !== null) return;
      publish();
      timerId = window.setInterval(publish, 1200);
    },
    stop() {
      if (timerId === null) return;
      window.clearInterval(timerId);
      timerId = null;
    },
  };
}
