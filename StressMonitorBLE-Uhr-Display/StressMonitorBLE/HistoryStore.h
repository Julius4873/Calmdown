#pragma once
#include <Arduino.h>
#include <LittleFS.h>
#include <esp_partition.h>
#include <esp_random.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <dirent.h>
#include <errno.h>
#include <atomic>
#include "HistoryRing.h"

class HistoryFiles {
 public:
  static constexpr char mountPath[] = "/cmfs";
  static constexpr char directory[] = "/cmfs/calmdown-history";

  int32_t size(uint8_t slot) const {
    char path[48]; name(slot, path);
    struct stat info{};
    if (stat(path, &info)) return errno == ENOENT ? -1 : -2;
    return S_ISREG(info.st_mode) && info.st_size <= INT32_MAX ? int32_t(info.st_size) : -2;
  }
  bool read(uint8_t slot, size_t offset, uint8_t *data, size_t length) {
    if (reader_ < 0 || readerSlot_ != slot) {
      closeReader();
      char path[48]; name(slot, path);
      reader_ = open(path, O_RDONLY);
      if (reader_ < 0) return false;
      readerSlot_ = slot;
    }
    return lseek(reader_, off_t(offset), SEEK_SET) == off_t(offset)
      && ::read(reader_, data, length) == ssize_t(length);
  }
  bool erase(uint8_t slot) {
    closeReader();
    char path[48]; name(slot, path);
    return unlink(path) == 0 || errno == ENOENT;
  }
  bool append(uint8_t slot, const uint8_t *data, size_t length) {
    closeReader();
    char path[48]; name(slot, path);
    return durableWrite(path, data, length, O_APPEND);
  }
  void closeReader() {
    if (reader_ >= 0) close(reader_);
    reader_ = -1;
  }
  static bool durableWrite(const char *path, const uint8_t *data, size_t length, int mode) {
    const int fd = open(path, O_WRONLY | O_CREAT | mode, 0600);
    if (fd < 0) return false;
    const bool saved = write(fd, data, length) == ssize_t(length) && fsync(fd) == 0;
    return close(fd) == 0 && saved;
  }
 private:
  int reader_ = -1;
  uint8_t readerSlot_ = 0;
  static void name(uint8_t slot, char *path) { snprintf(path, 48, "%s/s%02u", directory, unsigned(slot)); }
};

class HistoryStore {
 public:
  static constexpr uint8_t maxSlots = 64;
  static constexpr uint16_t perSlot = 192;
  enum Error : uint8_t { None, NoPartition, ForeignFilesystem, InvalidMetadata, NoCapacity, FileIO, QueueFull, RecoveredTail, WorkerUnavailable };
  struct Snapshot {
    uint32_t revision = 0, oldest = 0, newest = 0, prepared = 0, requested = 0;
    uint16_t count = 0, capacity = 0;
    uint8_t flags = 0, error = 0;
    uint8_t record[HistoryProtocol::recordSize]{};
  };

  void begin() {
    hardware_ = ESP.getEfuseMac();
    const esp_partition_t *partition = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_SPIFFS, "spiffs");
    if (!partition) { error_ = NoPartition; publish(); return; }
    partitionBytes_ = partition->size;
    if (!LittleFS.begin(false, HistoryFiles::mountPath, 4, "spiffs")) {
      // Formatting is permissible only for a factory-erased partition.
      if (!erased(partition) || !LittleFS.begin(true, HistoryFiles::mountPath, 4, "spiffs")) {
        error_ = ForeignFilesystem; publish(); return;
      }
    }
    uint8_t slots = 0;
    if (!loadMetadata(slots)) { publish(); return; }
    if (!ring_.recover(slots)) { error_ = InvalidMetadata; publish(); return; }
    files_.closeReader();
    if (ring_.gap()) error_ = RecoveredTail;
    available_ = true;
    records_ = xQueueCreate(4, sizeof(HistoryProtocol::Record));
    controls_ = xQueueCreate(1, sizeof(HistoryProtocol::Command));
    if (!records_ || !controls_
        || xTaskCreate(taskEntry, "history-fs", 4096, this, tskIDLE_PRIORITY + 1, &task_) != pdPASS) {
      available_ = false; error_ = WorkerUnavailable; publish();
      if (records_) vQueueDelete(records_);
      if (controls_) vQueueDelete(controls_);
      records_ = controls_ = nullptr;
      return;
    }
    writable_.store(true);
    // Worker owns the ring once the task starts and publishes the initial view.
  }

  void enqueue(const HistoryProtocol::Record &record) {
    if (!writable_.load()) return;
    if (xQueueSend(records_, &record, 0) != pdTRUE) queueGap_.store(true);
  }
  void command(const HistoryProtocol::Command &command) {
    if (controls_) xQueueOverwrite(controls_, &command);
  }
  Snapshot snapshot() {
    portENTER_CRITICAL(&mutex_);
    Snapshot copy = snapshot_;
    portEXIT_CRITICAL(&mutex_);
    return copy;
  }
  uint64_t hardware() const { return hardware_; }
  uint64_t generation() const { return generation_; }
  uint32_t partitionBytes() const { return partitionBytes_; }

 private:
  static constexpr char manifest[] = "/cmfs/calmdown-history/format";
  static constexpr char temporary[] = "/cmfs/calmdown-history/format.new";
  HistoryFiles files_;
  HistoryRing<HistoryFiles, maxSlots, perSlot> ring_{files_};
  uint64_t hardware_ = 0, generation_ = 0;
  uint32_t partitionBytes_ = 0, prepared_ = 0, requested_ = 0;
  uint8_t record_[HistoryProtocol::recordSize]{};
  uint8_t error_ = None;
  bool available_ = false;
  std::atomic<bool> writable_{false}, queueGap_{false};
  QueueHandle_t records_ = nullptr, controls_ = nullptr;
  TaskHandle_t task_ = nullptr;
  portMUX_TYPE mutex_ = portMUX_INITIALIZER_UNLOCKED;
  Snapshot snapshot_{};

  static bool erased(const esp_partition_t *partition) {
    uint8_t bytes[512];
    for (size_t offset = 0; offset < partition->size; offset += sizeof(bytes)) {
      const size_t remaining = partition->size - offset;
      const size_t amount = remaining < sizeof(bytes) ? remaining : sizeof(bytes);
      if (esp_partition_read(partition, offset, bytes, amount) != ESP_OK) return false;
      for (size_t i = 0; i < amount; ++i) if (bytes[i] != 0xff) return false;
    }
    return true;
  }

  static bool readManifest(const char *path, uint8_t *bytes) {
    const int fd = open(path, O_RDONLY);
    if (fd < 0) return false;
    uint8_t extra;
    const bool valid = read(fd, bytes, 20) == 20 && read(fd, &extra, 1) == 0
      && !memcmp(bytes, "CMD1", 4) && HistoryProtocol::crc32(bytes, 16) == HistoryProtocol::read32(bytes + 16)
      && bytes[12] >= 2 && bytes[12] <= maxSlots && !bytes[13]
      && HistoryProtocol::read16(bytes + 14) == perSlot && HistoryProtocol::read64(bytes + 4);
    close(fd);
    return valid;
  }

  bool loadMetadata(uint8_t &slots) {
    uint8_t bytes[20]{};
    if (!readManifest(manifest, bytes)) {
      struct stat info{};
      if (stat(manifest, &info) == 0 || errno != ENOENT) { error_ = InvalidMetadata; return false; }
      if (mkdir(HistoryFiles::directory, 0700) && errno != EEXIST) { error_ = FileIO; return false; }
      DIR *directory = opendir(HistoryFiles::directory);
      if (!directory) { error_ = FileIO; return false; }
      bool hasTemporary = false, unknown = false;
      while (const dirent *entry = readdir(directory)) {
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        if (!strcmp(entry->d_name, "format.new")) hasTemporary = true;
        else unknown = true;
      }
      closedir(directory);
      if (unknown) { error_ = InvalidMetadata; return false; }
      if (hasTemporary && readManifest(temporary, bytes)) {
        if (rename(temporary, manifest)) { error_ = FileIO; return false; }
      } else {
        // Only our incomplete initial metadata is replaceable in this empty directory.
        if (hasTemporary && unlink(temporary)) { error_ = FileIO; return false; }
        const size_t total = LittleFS.totalBytes(), used = LittleFS.usedBytes();
        const size_t reserve = total / 8 > 32768 ? total / 8 : 32768;
        const size_t possible = total > used + reserve ? (total - used - reserve) / 16384 : 0;
        if (possible < 2) { error_ = NoCapacity; return false; }
        slots = possible < maxSlots ? uint8_t(possible) : maxSlots;
        uint64_t token = uint64_t(esp_random()) << 32 | esp_random();
        if (!token) token = 1;
        memcpy(bytes, "CMD1", 4); HistoryProtocol::write64(bytes + 4, token);
        bytes[12] = slots;
        Protocol::u16(bytes + 14, perSlot);
        Protocol::u32(bytes + 16, HistoryProtocol::crc32(bytes, 16));
        if (!HistoryFiles::durableWrite(temporary, bytes, sizeof(bytes), O_EXCL) || rename(temporary, manifest)) {
          error_ = FileIO; return false;
        }
      }
    }
    generation_ = HistoryProtocol::read64(bytes + 4);
    slots = bytes[12];
    return true;
  }

  static void taskEntry(void *self) { static_cast<HistoryStore *>(self)->run(); }
  void run() {
    publish();
    uint32_t lastRead = millis() - 50;
    for (;;) {
      HistoryProtocol::Record record;
      if (xQueueReceive(records_, &record, 0) == pdTRUE && writable_.load()) {
        if (!ring_.append(record)) {
          error_ = FileIO;
          writable_.store(false); // The last durable prefix remains readable.
        }
        publish();
      }
      if (queueGap_.exchange(false)) {
        if (error_ != FileIO) error_ = QueueFull;
        publish();
      }
      HistoryProtocol::Command command;
      if (millis() - lastRead >= 50 && xQueueReceive(controls_, &command, 0) == pdTRUE) {
        lastRead = millis();
        if (command.op == HistoryProtocol::request || (command.op == HistoryProtocol::ack && command.sequence == prepared_)) {
          requested_ = command.op == HistoryProtocol::ack ? command.sequence + 1 : command.sequence;
          prepared_ = 0;
          if (requested_ && !ring_.readNext(requested_, record_, prepared_)) error_ = FileIO;
          publish();
        }
      }
      vTaskDelay(pdMS_TO_TICKS(5) > 0 ? pdMS_TO_TICKS(5) : 1);
    }
  }

  void publish() {
    Snapshot data;
    data.oldest = available_ ? ring_.oldest() : 0; data.newest = available_ ? ring_.newest() : 0;
    data.count = available_ ? ring_.count() : 0; data.capacity = available_ ? ring_.capacity() : 0;
    data.prepared = prepared_; data.requested = requested_; data.error = error_;
    data.flags = (available_ ? HistoryProtocol::ready : 0)
      | (data.oldest > 1 ? HistoryProtocol::overflow : 0)
      | (error_ && error_ != RecoveredTail ? HistoryProtocol::fault : 0)
      | (ring_.gap() || error_ == QueueFull || error_ == FileIO ? HistoryProtocol::gap : 0);
    memcpy(data.record, record_, sizeof(record_));
    portENTER_CRITICAL(&mutex_);
    data.revision = snapshot_.revision + 1;
    snapshot_ = data;
    portEXIT_CRITICAL(&mutex_);
  }
};
