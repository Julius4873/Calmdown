// Host test: c++ -std=c++17 -O2 history-core.cpp -o history-core && ./history-core
#include "../HistoryRing.h"
#include <cassert>
#include <vector>

namespace H = HistoryProtocol;

struct MemoryFiles {
  std::vector<uint8_t> slots[64];
  bool exists[64]{};
  size_t tornBytes = 0;
  int32_t size(uint8_t slot) { return exists[slot] ? int32_t(slots[slot].size()) : -1; }
  bool read(uint8_t slot, size_t offset, uint8_t *p, size_t length) {
    if (offset + length > slots[slot].size()) return false;
    memcpy(p, slots[slot].data() + offset, length);
    return true;
  }
  bool erase(uint8_t slot) { slots[slot].clear(); exists[slot] = false; return true; }
  bool append(uint8_t slot, const uint8_t *p, size_t length) {
    exists[slot] = true;
    if (tornBytes) {
      slots[slot].insert(slots[slot].end(), p, p + tornBytes);
      tornBytes = 0;
      return false;
    }
    slots[slot].insert(slots[slot].end(), p, p + length);
    return true;
  }
};

static H::Record one(uint32_t at = 1794006600) {
  H::Record r;
  r.first = r.last = at; r.offset = 60; r.samples = r.pulseCount = r.breathingCount = 1;
  r.pulseSum = r.pulseMax = 720; r.breathingSum = r.breathingMax = 150;
  return r;
}

template<typename Ring>
static uint32_t readNext(Ring &ring, uint32_t requested) {
  uint8_t bytes[H::recordSize];
  uint32_t sequence = 0;
  assert(ring.readNext(requested, bytes, sequence));
  if (sequence) {
    H::Record r;
    assert(H::decode(bytes, r) && r.sequence == sequence);
  }
  return sequence;
}

int main() {
  using Ring = HistoryRing<MemoryFiles, 64, 192>;
  MemoryFiles storage;
  Ring ring(storage);
  assert(ring.recover(64) && ring.capacity() == 12288);
  for (uint32_t sequence = 1; sequence <= 12289; ++sequence) assert(ring.append(one()));
  assert(ring.oldest() == 193 && ring.newest() == 12289 && ring.count() == 12097);
  assert(readNext(ring, 1) == 193 && readNext(ring, 12289) == 12289 && readNext(ring, 12290) == 0);
  Ring reboot(storage);
  assert(reboot.recover(64) && reboot.oldest() == 193 && reboot.newest() == 12289);
  assert(reboot.append(one()) && reboot.newest() == 12290);

  MemoryFiles damaged;
  HistoryRing<MemoryFiles, 4, 3> start(damaged);
  assert(start.recover(4) && start.append(one()));
  damaged.tornBytes = 10;
  assert(!start.append(one()));
  HistoryRing<MemoryFiles, 4, 3> recovered(damaged);
  assert(recovered.recover(4) && recovered.gap() && recovered.newest() == 1);
  const size_t sealedSize = damaged.slots[0].size();
  assert(recovered.append(one()) && recovered.newest() == 4);
  assert(damaged.slots[0].size() == sealedSize && readNext(recovered, 2) == 4);
  damaged.slots[1][HistoryRing<MemoryFiles, 4, 3>::headerSize + 20] ^= 1;
  HistoryRing<MemoryFiles, 4, 3> corrupted(damaged);
  assert(corrupted.recover(4) && corrupted.gap() && corrupted.newest() == 1);
  assert(corrupted.append(one()) && corrupted.newest() == 7); // Never reuse the corrupt reservation.
  damaged.slots[2][12] ^= 1;
  HistoryRing<MemoryFiles, 4, 3> invalidHeader(damaged);
  assert(!invalidHeader.recover(4)); // Cannot safely recover the high-water reservation.

  H::Minute minute;
  std::vector<H::Record> completed;
  const auto emit = [&](const H::Record &record) { completed.push_back(record); };
  const uint32_t at = 1794006600;
  static_assert(at % 60 == 0);
  minute.observe(1, 60, 720, 150, false, emit); // Invalid RTC time.
  minute.observe(at, 60, 720, 150, true, emit); // Test mode.
  assert(completed.empty());
  minute.observe(at + 12, 60, 720, UINT16_MAX, false, emit);
  minute.observe(at + 13, 60, 800, 160, false, emit);
  assert(completed.empty()); // The current minute is RAM-only.
  minute.observe(at + 60, 60, 900, 180, true, emit);
  assert(completed.size() == 1 && completed[0].first == at + 12 && completed[0].last == at + 13);
  assert(completed[0].samples == 2 && completed[0].pulseSum == 1520 && completed[0].pulseMax == 800);
  assert(completed[0].breathingCount == 1 && completed[0].breathingMax == 160);
  minute.observe(at + 61, 60, 600, 140, false, emit);
  minute.finish(true, emit); // Explicit clock change seals known real values only.
  minute.observe(at - 3600, 0, 610, 141, false, emit);
  minute.observe(at - 3540, 0, 620, 142, false, emit);
  assert(completed.size() == 3 && (completed[1].flags & H::partial) && completed[2].first == at - 3600);
  return 0;
}
