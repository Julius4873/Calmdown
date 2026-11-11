#pragma once
#include "Protocol.h"
#include <cstring>

namespace HistoryProtocol {
constexpr char identity[] = "89e10004-3b55-4a92-9b4d-173a6a0d8200";
constexpr char status[] = "89e10005-3b55-4a92-9b4d-173a6a0d8200";
constexpr char control[] = "89e10006-3b55-4a92-9b4d-173a6a0d8200";
constexpr char partA[] = "89e10007-3b55-4a92-9b4d-173a6a0d8200";
constexpr char partB[] = "89e10008-3b55-4a92-9b4d-173a6a0d8200";
constexpr size_t recordSize = 36;
constexpr uint8_t version = 1;
constexpr uint8_t request = 1, ack = 2;
constexpr uint8_t ready = 1, clockValid = 2, overflow = 4, fault = 8, gap = 16;
constexpr uint8_t partial = 1;
constexpr uint8_t maxSamples = 120;

struct Command { uint8_t op; uint32_t sequence; };
struct Record {
  uint32_t sequence = 0, first = 0, last = 0;
  uint32_t pulseSum = 0, breathingSum = 0;
  uint16_t pulseMax = 0, breathingMax = 0;
  int16_t offset = 0;
  uint8_t samples = 0, pulseCount = 0, breathingCount = 0, flags = 0;
};

inline uint16_t read16(const uint8_t *p) { return uint16_t(p[0]) | uint16_t(p[1]) << 8; }
inline uint32_t read32(const uint8_t *p) {
  return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}
inline void write64(uint8_t *p, uint64_t value) {
  for (unsigned i = 0; i < 8; ++i) p[i] = uint8_t(value >> (8 * i));
}
inline uint64_t read64(const uint8_t *p) {
  uint64_t value = 0;
  for (unsigned i = 0; i < 8; ++i) value |= uint64_t(p[i]) << (8 * i);
  return value;
}
inline uint32_t crc32(const uint8_t *p, size_t size) {
  uint32_t crc = UINT32_MAX;
  for (size_t i = 0; i < size; ++i) {
    crc ^= p[i];
    for (unsigned bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ (0xEDB88320U & (0U - (crc & 1U)));
  }
  return ~crc;
}
inline bool validTime(uint32_t epoch, int16_t offset) {
  return epoch >= 946684800UL && epoch <= 4102444799UL && offset >= -720 && offset <= 840;
}
inline bool validMetric(uint8_t count, uint32_t sum, uint16_t max, uint8_t samples) {
  if (!count) return !sum && !max;
  return count <= samples && max < UINT16_MAX && sum >= max && sum <= uint32_t(max) * count;
}
inline bool valid(const Record &r) {
  return r.sequence && validTime(r.first, r.offset) && validTime(r.last, r.offset)
    && r.last >= r.first && r.first / 60 == r.last / 60
    && !(r.flags & ~partial) && r.samples && r.samples <= maxSamples
    && (r.pulseCount || r.breathingCount) && unsigned(r.pulseCount) + r.breathingCount >= r.samples
    && validMetric(r.pulseCount, r.pulseSum, r.pulseMax, r.samples)
    && validMetric(r.breathingCount, r.breathingSum, r.breathingMax, r.samples);
}
inline void encode(uint8_t *p, const Record &r) {
  p[0] = version; p[1] = r.flags;
  Protocol::u32(p + 2, r.sequence);
  Protocol::u32(p + 6, r.first);
  Protocol::u16(p + 10, uint16_t(r.offset));
  p[12] = r.samples; p[13] = r.pulseCount; p[14] = r.breathingCount; p[15] = 0;
  Protocol::u32(p + 16, r.pulseSum);
  Protocol::u32(p + 20, r.breathingSum);
  Protocol::u16(p + 24, r.pulseMax);
  Protocol::u16(p + 26, r.breathingMax);
  Protocol::u32(p + 28, r.last);
  Protocol::u32(p + 32, crc32(p, 32));
}
inline bool decode(const uint8_t *p, Record &r) {
  if (p[0] != version || p[15] || crc32(p, 32) != read32(p + 32)) return false;
  r = {};
  r.flags = p[1]; r.sequence = read32(p + 2); r.first = read32(p + 6);
  r.offset = int16_t(read16(p + 10)); r.samples = p[12]; r.pulseCount = p[13]; r.breathingCount = p[14];
  r.pulseSum = read32(p + 16); r.breathingSum = read32(p + 20);
  r.pulseMax = read16(p + 24); r.breathingMax = read16(p + 26); r.last = read32(p + 28);
  return valid(r);
}
inline bool decodeCommand(const uint8_t *p, size_t size, Command &result) {
  if (size != 6 || p[0] != version || (p[1] != request && p[1] != ack)) return false;
  result = {p[1], read32(p + 2)};
  return result.sequence != 0;
}

class Minute {
 public:
  template<typename Emit>
  void observe(uint32_t epoch, int16_t offset, uint16_t pulse, uint16_t breathing, bool demo, Emit emit) {
    if (!validTime(epoch, offset)) return;
    if (record_.samples && (record_.first / 60 != epoch / 60 || record_.offset != offset))
      finish(record_.offset != offset || epoch < record_.first, emit);
    if (demo || (pulse == UINT16_MAX && breathing == UINT16_MAX)) return;
    if (record_.samples == maxSamples) finish(true, emit);
    if (!record_.samples) {
      record_.first = record_.last = epoch;
      record_.offset = offset;
    }
    if (epoch < record_.first) record_.first = epoch;
    if (epoch > record_.last) record_.last = epoch;
    ++record_.samples;
    add(pulse, record_.pulseCount, record_.pulseSum, record_.pulseMax);
    add(breathing, record_.breathingCount, record_.breathingSum, record_.breathingMax);
  }
  template<typename Emit>
  void finish(bool isPartial, Emit emit) {
    if (!record_.samples) return;
    record_.flags = isPartial ? partial : 0;
    emit(record_);
    record_ = {};
  }
 private:
  Record record_{};
  static void add(uint16_t value, uint8_t &count, uint32_t &sum, uint16_t &max) {
    if (value == UINT16_MAX) return;
    ++count;
    sum += value;
    if (value > max) max = value;
  }
};
}
