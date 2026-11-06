#pragma once
#include <cmath>
#include <cstdint>
#include "Config.h"

namespace Measurement {
constexpr float pi = 3.14159265358979323846f;
inline bool finite(float x) { return std::isfinite(x); }
inline float maximum(float a, float b) { return a > b ? a : b; }

class PulseSmoother {
 public:
  void reset() { *this = PulseSmoother(); }
  float addInterval(uint32_t samples) {
    if (!samples) return value_;
    periods_[next_] = float(samples);
    next_ = (next_ + 1) % 5;
    if (count_ < 5) ++count_;
    float sum = 0;
    for (uint8_t i = 0; i < count_; ++i) sum += periods_[i];
    const float meanRate = 60.0f * Config::sampleHz * count_ / sum;
    value_ = finite(value_) ? value_ + 0.25f * (meanRate - value_) : meanRate;
    return value_;
  }
  float value() const { return value_; }
 private:
  float periods_[5] = {};
  uint8_t next_ = 0, count_ = 0;
  float value_ = NAN;
};

// Signalfilter und adaptive Spitzen-Erkennung, ohne Signalqualitaets-Score.
// Alle Zeitabstaende stammen aus dem 100-Hz-Sampletakt, nie aus FIFO-Lesezeiten.
class BeatDetector {
 public:
  bool add(uint16_t raw) {
    ++time_;
    if (!initialized_) { baseline_ = raw; initialized_ = true; }
    baseline_ += 0.04f * (float(raw) - baseline_);
    const float ac = baseline_ - raw;
    // Zweite Hochpassstufe entfernt langsame Drift auch bei schwachen Pulsen.
    // Die Atmung wird separat aus dem Potentiometer berechnet.
    acBaseline_ += 0.04f * (ac - acBaseline_);
    low1_ += 0.3f * ((ac - acBaseline_) - low1_);
    low2_ += 0.3f * (low1_ - low2_);
    envelope_ = maximum(std::fabs(low2_), envelope_ * 0.995f);
    if (time_ < 200) return false; // Filter einschwingen lassen.
    if (low2_ <= 0) armed_ = true;
    if (!tracking_ && armed_ && low2_ > maximum(8.0f, envelope_ * 0.5f) &&
        (!haveBeat_ || time_ - beatTime_ >= 30)) {
      tracking_ = true;
      peak_ = low2_;
    }
    if (!tracking_) return false;
    peak_ = maximum(peak_, low2_);
    if (low2_ > peak_ - maximum(3.0f, peak_ * 0.15f)) return false;
    tracking_ = false;
    armed_ = false;
    beatTime_ = time_;
    haveBeat_ = true;
    return true;
  }
 private:
  uint32_t time_ = 0, beatTime_ = 0;
  float baseline_ = 0, acBaseline_ = 0, low1_ = 0, low2_ = 0, envelope_ = 0, peak_ = 0;
  bool initialized_ = false, armed_ = true, tracking_ = false, haveBeat_ = false;
};

class Pipeline {
 public:
  void reset() { detector_ = BeatDetector(); smoother_.reset(); span_ = 0; haveBeat_ = false; }
  bool add(uint16_t raw) {
    ++span_;
    if (detector_.add(raw)) {
      if (haveBeat_) smoother_.addInterval(span_);
      haveBeat_ = true; span_ = 0; return true;
    }
    if (haveBeat_ && span_ >= Config::noBeatMs * Config::sampleHz / 1000) reset();
    return false;
  }
  float pulse() const { return smoother_.value(); }
 private:
  BeatDetector detector_;
  PulseSmoother smoother_;
  uint32_t span_ = 0;
  bool haveBeat_ = false;
};

enum class Phase : uint8_t { Monitoring, Pending, Warning, Guide };
class Alert {
 public:
  void update(uint32_t now, float pulse, float breathing, bool fresh) {
    const bool high = fresh && finite(pulse) && finite(breathing) &&
                      pulse > Config::warningPulse && breathing > Config::warningBreathing;
    switch (phase_) {
      case Phase::Monitoring:
        if (high) { phase_ = Phase::Pending; since_ = now; }
        break;
      case Phase::Pending:
        if (!high) phase_ = Phase::Monitoring;
        else if (now - since_ >= Config::thresholdHoldMs) { phase_ = Phase::Warning; since_ = now; }
        break;
      case Phase::Warning:
        if (now - since_ >= Config::warningDurationMs) { phase_ = Phase::Guide; since_ = now; }
        break;
      case Phase::Guide:
        if (now - since_ >= Config::guideDurationMs) phase_ = Phase::Monitoring;
        break;
    }
  }
  Phase phase() const { return phase_; }
  uint32_t elapsed(uint32_t now) const { return now - since_; }
  bool red(uint32_t now) const { return phase_ == Phase::Warning && (elapsed(now) / Config::blinkHalfPeriodMs) % 2 == 0; }
  bool inhaling(uint32_t now) const { return elapsed(now) % (Config::inhaleMs + Config::exhaleMs) < Config::inhaleMs; }
  uint32_t breathRemaining(uint32_t now) const {
    const uint32_t t = elapsed(now) % (Config::inhaleMs + Config::exhaleMs);
    return t < Config::inhaleMs ? Config::inhaleMs - t : Config::inhaleMs + Config::exhaleMs - t;
  }
 private:
  Phase phase_ = Phase::Monitoring;
  uint32_t since_ = 0;
};
}

