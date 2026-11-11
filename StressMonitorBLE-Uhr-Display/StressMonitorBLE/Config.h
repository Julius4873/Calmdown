#pragma once
#include <stdint.h>
namespace Config {
constexpr float warningPulse = 100.0f;
constexpr float warningBreathing = 20.0f;
constexpr uint32_t thresholdHoldMs = 5000;
constexpr uint32_t warningDurationMs = 4000;
constexpr uint32_t blinkHalfPeriodMs = 500;
constexpr uint32_t inhaleMs = 4000;
constexpr uint32_t exhaleMs = 6000;
constexpr uint32_t guideDurationMs = 60000;
constexpr uint16_t sampleHz = 100;
constexpr uint32_t noBeatMs = 3000;
constexpr uint32_t noDataMs = 500;
constexpr uint8_t ledCurrent = 0x88;
constexpr uint32_t i2cHz = 100000;
constexpr int sdaPin = 22, sclPin = 23;
constexpr int potPin = 0; // A0 des XIAO ESP32C6; Display-Batteriemessung trennen.
}
