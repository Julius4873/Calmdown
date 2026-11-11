#pragma once
#include <BLEDevice.h>
#include <BLEServer.h>
#include <atomic>
#include "Protocol.h"
#include "HistoryStore.h"
class BleLink : public BLEServerCallbacks, public BLECharacteristicCallbacks {
 public:
  bool ready=false;
  bool connected() const { return connected_.load(); }
  void begin(uint64_t hardware, uint64_t generation) {
    if(!BLEDevice::init("StressMonitor")) return;
    server_=BLEDevice::createServer(); server_->setCallbacks(this);
    BLEService *svc=server_->createService(BLEUUID(Protocol::service), 32);
    data_=svc->createCharacteristic(Protocol::measurements,BLECharacteristic::PROPERTY_READ|BLECharacteristic::PROPERTY_NOTIFY);
    // Der C6-NimBLE-Stack erzeugt den Notify-Descriptor automatisch.
    auto clock=svc->createCharacteristic(Protocol::clock,BLECharacteristic::PROPERTY_WRITE);
    clock->setCallbacks(this);
    auto identity = svc->createCharacteristic(HistoryProtocol::identity, BLECharacteristic::PROPERTY_READ);
    historyStatus_ = svc->createCharacteristic(HistoryProtocol::status, BLECharacteristic::PROPERTY_READ);
    historyControl_ = svc->createCharacteristic(HistoryProtocol::control, BLECharacteristic::PROPERTY_WRITE);
    historyA_ = svc->createCharacteristic(HistoryProtocol::partA, BLECharacteristic::PROPERTY_READ);
    historyB_ = svc->createCharacteristic(HistoryProtocol::partB, BLECharacteristic::PROPERTY_READ);
    historyControl_->setCallbacks(this);
    uint8_t identityBytes[20]{};
    identityBytes[0] = HistoryProtocol::version;
    HistoryProtocol::write64(identityBytes + 2, hardware);
    HistoryProtocol::write64(identityBytes + 10, generation);
    identity->setValue(identityBytes, sizeof(identityBytes));
    uint8_t initial[20]; Protocol::encode(initial,0,0,NAN,NAN,0,0,0,0,false,false);
    data_->setValue(initial,sizeof(initial)); svc->start();
    auto adv=BLEDevice::getAdvertising(); adv->addServiceUUID(Protocol::service);
    adv->setScanResponse(true); adv->start(); ready=true;
  }
  void poll() {
    if(restart_.exchange(false)) { restartAt_=millis(); waiting_=true; }
    if(waiting_ && millis()-restartAt_>=500) {
      waiting_=false; if(!connected()) BLEDevice::startAdvertising();
    }
  }
  void publish(const uint8_t *packet) {
    if(!ready) return;
    data_->setValue(packet,20);
    // notify() sendet nur an Clients mit aktivem Abonnement.
    if(connected()) data_->notify();
  }
  bool takeClock(uint32_t &epoch,int16_t &offset) {
    portENTER_CRITICAL(&mutex_);
    bool pending=clockPending_; epoch=epoch_; offset=offset_; clockPending_=false;
    portEXIT_CRITICAL(&mutex_); return pending;
  }
  bool takeHistory(HistoryProtocol::Command &command) {
    portENTER_CRITICAL(&mutex_);
    const bool pending = historyPending_;
    command = historyCommand_;
    historyPending_ = false;
    portEXIT_CRITICAL(&mutex_);
    return pending;
  }
  void publishHistory(const HistoryStore::Snapshot &snapshot, bool clockValid) {
    if (!ready || (historyRevision_ == snapshot.revision && historyClockValid_ == clockValid)) return;
    historyRevision_ = snapshot.revision;
    historyClockValid_ = clockValid;
    uint8_t status[20]{};
    status[0] = HistoryProtocol::version;
    status[1] = snapshot.flags | (clockValid ? HistoryProtocol::clockValid : 0);
    Protocol::u32(status + 2, snapshot.oldest);
    Protocol::u32(status + 6, snapshot.newest);
    Protocol::u16(status + 10, snapshot.count);
    Protocol::u16(status + 12, snapshot.capacity);
    Protocol::u32(status + 14, snapshot.requested);
    status[18] = snapshot.error;
    uint8_t tail[20]{};
    Protocol::u32(tail, snapshot.prepared);
    memcpy(tail + 4, snapshot.record + 20, 16);
    historyA_->setValue(snapshot.record, 20);
    historyB_->setValue(tail, sizeof(tail));
    historyStatus_->setValue(status, sizeof(status));
  }
  void onConnect(BLEServer *) override { connected_.store(true); }
  void onDisconnect(BLEServer *) override { connected_.store(false); restart_.store(true); }
  void onWrite(BLECharacteristic *c) override {
    auto value=c->getValue();
    if (c == historyControl_) {
      HistoryProtocol::Command command;
      if (!HistoryProtocol::decodeCommand(reinterpret_cast<const uint8_t *>(value.c_str()), value.length(), command)) return;
      portENTER_CRITICAL(&mutex_);
      historyCommand_ = command;
      historyPending_ = true;
      portEXIT_CRITICAL(&mutex_);
      return;
    }
    if(value.length()!=8 || uint8_t(value[0])!=1 || uint8_t(value[1])!=0) return;
    uint32_t epoch=0; for(int i=0;i<4;++i) epoch|=uint32_t(uint8_t(value[i+2]))<<(8*i);
    int16_t offset=int16_t(uint16_t(uint8_t(value[6]))|(uint16_t(uint8_t(value[7]))<<8));
    if(epoch<946684800UL||epoch>4102444799UL||offset < -720||offset>840) return;
    // Kein I2C/NVS im Bluetooth-Callback: Auftrag an die Hauptschleife.
    portENTER_CRITICAL(&mutex_); epoch_=epoch; offset_=offset; clockPending_=true; portEXIT_CRITICAL(&mutex_);
  }
 private:
  BLEServer *server_=nullptr; BLECharacteristic *data_=nullptr;
  BLECharacteristic *historyStatus_=nullptr, *historyControl_=nullptr, *historyA_=nullptr, *historyB_=nullptr;
  HistoryProtocol::Command historyCommand_{};
  bool historyPending_=false, historyClockValid_=false;
  uint32_t historyRevision_=UINT32_MAX;
  std::atomic<bool> connected_{false},restart_{false};
  bool waiting_=false,clockPending_=false; uint32_t restartAt_=0,epoch_=0; int16_t offset_=60;
  portMUX_TYPE mutex_=portMUX_INITIALIZER_UNLOCKED;
};
