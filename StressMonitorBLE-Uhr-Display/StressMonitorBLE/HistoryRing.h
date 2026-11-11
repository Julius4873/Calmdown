#pragma once
#include "HistoryProtocol.h"

// Only one thread owns the ring and its backend after startup. Each segment
// contains an immutable valid prefix; an interrupted tail is never extended.
template<typename Backend, uint8_t MaxSlots, uint16_t PerSlot>
class HistoryRing {
 public:
  static constexpr size_t headerSize = 16;
  explicit HistoryRing(Backend &io) : io_(io) {}

  bool recover(uint8_t slots) {
    if (slots < 2 || slots > MaxSlots) return false;
    slots_ = slots;
    newestSlot_ = -1;
    reservedHigh_ = 0;
    gap_ = false;
    segmentsReset();
    for (uint8_t slot = 0; slot < slots_; ++slot) {
      const int32_t bytes = io_.size(slot);
      if (bytes == -1) continue; // No file.
      if (bytes < 0) return false;
      Segment &segment = segments_[slot];
      segment.exists = true;
      uint8_t header[headerSize];
      if (size_t(bytes) < headerSize) {
        segment.sealed = true; gap_ = true; continue;
      }
      if (!io_.read(slot, 0, header, sizeof(header))) return false;
      const uint32_t first = HistoryProtocol::read32(header + 4);
      if (memcmp(header, "CMH1", 4) || !first || first > UINT32_MAX - PerSlot + 1
          || HistoryProtocol::read16(header + 8) != PerSlot || HistoryProtocol::read16(header + 10)
          || HistoryProtocol::crc32(header, 12) != HistoryProtocol::read32(header + 12)) {
        if (size_t(bytes) > headerSize) return false; // Cannot safely recover sequence reservation.
        segment.sealed = true; gap_ = true; continue;
      }
      segment.first = first;
      const uint32_t end = first + PerSlot - 1;
      for (uint8_t old = 0; old < slot; ++old) {
        const uint32_t prior = segments_[old].first;
        if (prior && first <= prior + PerSlot - 1 && prior <= end) return false;
      }
      if (end > reservedHigh_) { reservedHigh_ = end; newestSlot_ = slot; }
      const uint32_t payload = uint32_t(bytes) - headerSize;
      const uint32_t complete = payload / HistoryProtocol::recordSize;
      if (complete > PerSlot || payload % HistoryProtocol::recordSize) {
        segment.sealed = true;
        gap_ = true;
      }
      const uint32_t limit = complete < PerSlot ? complete : PerSlot;
      for (uint32_t index = 0; index < limit; ++index) {
        uint8_t bytes[HistoryProtocol::recordSize];
        HistoryProtocol::Record record;
        if (!io_.read(slot, headerSize + index * sizeof(bytes), bytes, sizeof(bytes))) return false;
        if (!HistoryProtocol::decode(bytes, record)
            || record.sequence != segment.first + index) {
          segment.sealed = true;
          gap_ = true;
          break;
        }
        ++segment.count;
      }
    }
    const uint32_t low = oldest(), high = newest();
    if (low && high - low + 1 != count()) gap_ = true;
    return true;
  }

  bool append(HistoryProtocol::Record record) {
    if (!slots_) return false;
    uint8_t slot = newestSlot_ < 0 ? 0 : uint8_t(newestSlot_);
    if (newestSlot_ >= 0 && (segments_[slot].sealed || segments_[slot].count >= PerSlot))
      slot = uint8_t((slot + 1) % slots_);
    const bool newSegment = slot != newestSlot_;
    if (newSegment && reservedHigh_ > UINT32_MAX - PerSlot) return false;
    record.sequence = newSegment ? reservedHigh_ + 1 : segments_[slot].first + segments_[slot].count;
    if (!HistoryProtocol::valid(record)) return false;
    Segment &segment = segments_[slot];
    if (newSegment) {
      if (segment.exists && !io_.erase(slot)) return false;
      segment = {};
      uint8_t header[headerSize]{};
      memcpy(header, "CMH1", 4);
      Protocol::u32(header + 4, record.sequence);
      Protocol::u16(header + 8, PerSlot);
      Protocol::u32(header + 12, HistoryProtocol::crc32(header, 12));
      if (!io_.append(slot, header, sizeof(header))) { gap_ = true; return false; }
      segment.exists = true;
      segment.first = record.sequence;
      reservedHigh_ = record.sequence + PerSlot - 1;
      newestSlot_ = slot;
    }
    uint8_t bytes[HistoryProtocol::recordSize];
    HistoryProtocol::encode(bytes, record);
    if (!io_.append(slot, bytes, sizeof(bytes))) {
      segment.sealed = true;
      gap_ = true;
      return false;
    }
    segment.exists = true;
    ++segment.count;
    newestSlot_ = slot;
    return true;
  }

  bool readNext(uint32_t requested, uint8_t *bytes, uint32_t &sequence) {
    int chosen = -1;
    sequence = 0;
    for (uint8_t slot = 0; slot < slots_; ++slot) {
      const Segment &segment = segments_[slot];
      if (!segment.count || requested > segment.last()) continue;
      const uint32_t candidate = requested > segment.first ? requested : segment.first;
      if (chosen < 0 || candidate < sequence) { chosen = slot; sequence = candidate; }
    }
    if (chosen < 0) return true; // Valid empty response.
    const bool read = io_.read(uint8_t(chosen), headerSize + (sequence - segments_[chosen].first) * HistoryProtocol::recordSize,
                              bytes, HistoryProtocol::recordSize);
    HistoryProtocol::Record record;
    if (!read || !HistoryProtocol::decode(bytes, record) || record.sequence != sequence) {
      sequence = 0;
      gap_ = true;
      return false;
    }
    return true;
  }

  uint32_t oldest() const {
    uint32_t first = 0;
    for (uint8_t slot = 0; slot < slots_; ++slot)
      if (segments_[slot].count && (!first || segments_[slot].first < first)) first = segments_[slot].first;
    return first;
  }
  uint32_t newest() const {
    uint32_t last = 0;
    for (uint8_t slot = 0; slot < slots_; ++slot)
      if (segments_[slot].count && segments_[slot].last() > last) last = segments_[slot].last();
    return last;
  }
  uint16_t count() const {
    uint16_t total = 0;
    for (uint8_t slot = 0; slot < slots_; ++slot) total += segments_[slot].count;
    return total;
  }
  uint16_t capacity() const { return uint16_t(slots_) * PerSlot; }
  bool gap() const { return gap_; }

 private:
  struct Segment {
    uint32_t first = 0;
    uint16_t count = 0;
    bool exists = false, sealed = false;
    uint32_t last() const { return first + count - 1; }
  };
  void segmentsReset() { for (auto &segment : segments_) segment = {}; }
  Backend &io_;
  Segment segments_[MaxSlots]{};
  uint8_t slots_ = 0;
  int16_t newestSlot_ = -1;
  uint32_t reservedHigh_ = 0;
  bool gap_ = false;
};
