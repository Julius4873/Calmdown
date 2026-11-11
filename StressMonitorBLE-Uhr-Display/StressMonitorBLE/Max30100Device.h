#pragma once
#include <Arduino.h>
#include <Wire.h>
#include "Config.h"

// MAX30100: FIFO mit 16 Samples, je 2 Byte IR und 2 Byte Rot.
// Jeder I2C-Zugriff wird geprüft.
class Max30100Device {
 public:
  struct Sample {
    uint16_t ir, red;
  };

  uint32_t i2cErrors = 0;
  uint32_t overflowEvents = 0;
  uint32_t lostSamplesAtLeast = 0;
  uint8_t partId = 0;

  bool begin() {
    ready_ = false;
    Wire.setClock(Config::i2cHz);

    // MAX30100 erwartet die Kennung 0x11.
    if (!read(0xFF, &partId, 1) || partId != 0x11) {
      return false;
    }

    // Sensor zurücksetzen.
    if (!write(0x06, 0x40)) return false;

    const uint32_t started = millis();
    uint8_t mode = 0x40;

    do {
      delay(1);
      if (!read(0x06, &mode, 1) ||
          millis() - started > 100) {
        return false;
      }
    } while (mode & 0x40);

    // 100 Hz, 16 Bit / 1600 µs, High Resolution.
    if (!write(0x01, 0) ||
        !write(0x07, 0x47) ||
        !write(0x09, Config::ledCurrent) ||
        !clearFifo() ||
        !write(0x06, 0x03)) {
      return false;
    }

    ready_ = verifyRegisters();
    return ready_;
  }

  bool ready() const {
    return ready_;
  }

  void offline() {
    ready_ = false;
  }

  bool verifyRegisters() {
    uint8_t mode, adc, leds;

    return read(0x06, &mode, 1) &&
           read(0x07, &adc, 1) &&
           read(0x09, &leds, 1) &&
           mode == 0x03 &&
           adc == 0x47 &&
           leds == Config::ledCurrent;
  }

  // -1: Übertragungsfehler
  // -2: Datenlücke
  // Sonst: Anzahl gelesener Samples
  int readSamples(Sample samples[16]) {
    uint8_t pointers[3];

    if (!read(0x02, pointers, 3)) return -1;

    if (pointers[1] & 0x0F) {
      ++overflowEvents;
      lostSamplesAtLeast += pointers[1] & 0x0F;

      if (!clearFifo()) return -1;
      return -2;
    }

    const uint8_t count =
        (pointers[0] - pointers[2]) & 0x0F;

    if (!count) return 0;

    uint8_t data[64];

    if (!read(0x05, data, count * 4)) return -1;

    for (uint8_t i = 0; i < count; ++i) {
      samples[i].ir =
          (uint16_t(data[i * 4]) << 8) |
           data[i * 4 + 1];

      samples[i].red =
          (uint16_t(data[i * 4 + 2]) << 8) |
           data[i * 4 + 3];
    }

    return count;
  }

 private:
  bool ready_ = false;

  bool write(uint8_t reg, uint8_t value) {
    Wire.beginTransmission(0x57);
    Wire.write(reg);
    Wire.write(value);

    if (Wire.endTransmission() == 0) return true;

    ++i2cErrors;
    return false;
  }

  bool read(uint8_t reg, uint8_t *bytes, size_t count) {
    Wire.beginTransmission(0x57);
    Wire.write(reg);

    if (Wire.endTransmission(false) != 0) {
      ++i2cErrors;
      return false;
    }

    if (Wire.requestFrom(uint8_t(0x57), count) != count) {
      while (Wire.available()) Wire.read();
      ++i2cErrors;
      return false;
    }

    for (size_t i = 0; i < count; ++i) {
      bytes[i] = Wire.read();
    }

    return true;
  }

  bool clearFifo() {
    return write(0x02, 0) &&
           write(0x03, 0) &&
           write(0x04, 0);
  }
};