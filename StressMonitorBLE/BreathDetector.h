#pragma once
#include <cmath>
#include <stdint.h>

// Ein kompletter Hin-und-zurueck-Zyklus des Potis entspricht einem Atemzug.
// Hysterese ist die notwendige Flankenerkennung, kein Qualitaets-Score.
class BreathDetector {
 public:
  static constexpr uint32_t sampleMs = 20; // 50 Hz
  static constexpr float minimumSwing = 30; // ADC-Schritte bei 12 Bit; anpassbar
  static constexpr uint32_t minimumPeriodMs = 1000; // bis 60 Atemzuege/min
  static constexpr uint32_t maximumPeriodMs = 15000; // ab 4 Atemzuegen/min
  static constexpr uint32_t timeoutMs = maximumPeriodMs + 2000;

  void reset() { *this = BreathDetector(); }
  bool add(uint16_t raw, uint32_t now) {
    if (initialized_ && (now - lastSample_ > 200 ||
        (havePeak_ && now - lastPeak_ >= timeoutMs))) reset();
    lastSample_ = now;
    if (!initialized_) {
      initialized_ = true; filtered_ = low_ = high_ = raw; highTime_ = now;
      return false;
    }
    filtered_ += 0.2f * (float(raw) - filtered_);
    switch (direction_) {
      case Direction::Unknown:
        if (filtered_ < low_) low_ = filtered_;
        if (filtered_ > high_) { high_ = filtered_; highTime_ = now; }
        if (filtered_ - low_ >= hysteresis_) { direction_ = Direction::Rising; high_ = filtered_; highTime_ = now; }
        else if (high_ - filtered_ >= hysteresis_) { direction_ = Direction::Falling; low_ = filtered_; }
        return false;
      case Direction::Rising:
        if (filtered_ > high_) { high_ = filtered_; highTime_ = now; }
        if (high_ - filtered_ < hysteresis_) return false;
        hysteresis_ = hysteresis(high_ - low_);
        low_ = filtered_; direction_ = Direction::Falling;
        return recordPeak(highTime_);
      case Direction::Falling:
        if (filtered_ < low_) low_ = filtered_;
        if (filtered_ - low_ < hysteresis_) return false;
        hysteresis_ = hysteresis(high_ - low_);
        high_ = filtered_; highTime_ = now; direction_ = Direction::Rising;
        return false;
    }
    return false;
  }
  float rate() const { return rate_; }
  float signal() const { return filtered_; }
  uint32_t cycles() const { return cycles_; }
 private:
  enum class Direction { Unknown, Rising, Falling };
  Direction direction_ = Direction::Unknown;
  bool initialized_ = false, havePeak_ = false;
  float filtered_ = 0, low_ = 0, high_ = 0, hysteresis_ = minimumSwing;
  uint32_t lastSample_ = 0, highTime_ = 0, lastPeak_ = 0, cycles_ = 0;
  float intervals_[3] = {}, rate_ = NAN;
  uint8_t count_ = 0, next_ = 0;

  static float hysteresis(float swing) {
    // 20% der zuletzt beobachteten Bewegung; begrenzt fuer Potentiometerwege.
    return std::fmax(minimumSwing, std::fmin(300.0f, 0.2f * swing));
  }
  bool recordPeak(uint32_t now) {
    if (!havePeak_) { lastPeak_ = now; havePeak_ = true; return false; }
    const uint32_t period = now - lastPeak_;
    if (period < minimumPeriodMs) return false; // keine zweite Flanke desselben Zugs
    lastPeak_ = now;
    if (period > maximumPeriodMs) { rate_ = NAN; count_ = next_ = 0; return false; }
    ++cycles_;
    intervals_[next_] = float(period); next_ = (next_ + 1) % 3;
    if (count_ < 3) ++count_;
    float total = 0;
    for (uint8_t i = 0; i < count_; ++i) total += intervals_[i];
    const float current = 60000.0f * count_ / total;
    rate_ = std::isfinite(rate_) ? rate_ + 0.3f * (current - rate_) : current;
    return true;
  }
};
