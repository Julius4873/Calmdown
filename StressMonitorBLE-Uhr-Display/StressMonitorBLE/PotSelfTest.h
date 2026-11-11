#pragma once
#include <Arduino.h>
#include "BreathDetector.h"

namespace PotSelfTest {
inline void run() {
  int passed = 0, failed = 0;
  auto check = [&](bool ok, const char *name) {
    Serial.printf("TEST %s %s\n", ok ? "PASS" : "FAIL", name);
    if (ok) ++passed; else ++failed;
  };
  constexpr float pi = 3.14159265358979323846f;
  BreathDetector detector;
  const float rates[] = {6, 12, 20, 30, 60};
  const char *names[] = {"6_per_min", "12_per_min", "20_per_min", "30_per_min", "60_per_min"};
  for (int r = 0; r < 5; ++r) {
    detector.reset();
    for (uint32_t t = 0; t < 90000; t += 20)
      detector.add(uint16_t(2000 + 700 * std::sin(2 * pi * rates[r] * t / 60000)), t);
    check(std::fabs(detector.rate() - rates[r]) < 0.5f, names[r]);
  }
  detector.reset();
  for (uint32_t t = 0; t < 30000; t += 20) detector.add(2000 + (t % 7) - 3, t);
  check(!std::isfinite(detector.rate()), "constant_plus_small_noise_no_breaths");
  detector.reset();
  for (uint32_t t = 0; t < 60000; t += 20) {
    const float wave = 2000 - 500 * std::sin(2 * pi * 15 * t / 60000);
    detector.add(uint16_t(wave + int(t % 11) - 5), t);
  }
  check(std::fabs(detector.rate() - 15) < 0.5f, "inverted_direction_with_noise");
  for (uint32_t t = 60000; t < 80000; t += 20) detector.add(2000, t);
  check(!std::isfinite(detector.rate()), "no_movement_clears_stale_rate");
  for (uint32_t t = 80000; t < 140000; t += 20)
    detector.add(uint16_t(2000 + 600 * std::sin(2 * pi * 24 * t / 60000)), t);
  check(std::fabs(detector.rate() - 24) < 0.5f, "movement_returns_at_24");
  detector.add(2000, 141000);
  check(!std::isfinite(detector.rate()), "sampling_gap_resets");
  detector.reset();
  const uint32_t start = UINT32_MAX - 25000;
  for (uint32_t t = 0; t < 60000; t += 20)
    detector.add(uint16_t(2000 + 600 * std::sin(2 * pi * 12 * t / 60000)), start + t);
  check(std::fabs(detector.rate() - 12) < 0.5f, "millis_wrap_around");
  detector.reset();
  check(!std::isfinite(detector.rate()) && detector.cycles() == 0, "explicit_reset");
  Serial.printf("SELFTEST passed=%d failed=%d\n", passed, failed);
}
}
