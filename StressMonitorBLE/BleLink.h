#pragma once
#include <BLEDevice.h>
#include <BLEServer.h>
#include <atomic>
#include "Protocol.h"
class BleLink : public BLEServerCallbacks, public BLECharacteristicCallbacks {
 public:
  bool ready=false;
  bool connected() const { return connected_.load(); }
  void begin() {
    if(!BLEDevice::init("StressMonitor")) return;
    server_=BLEDevice::createServer(); server_->setCallbacks(this);
    BLEService *svc=server_->createService(Protocol::service);
    data_=svc->createCharacteristic(Protocol::measurements,BLECharacteristic::PROPERTY_READ|BLECharacteristic::PROPERTY_NOTIFY);
    // Der C6-NimBLE-Stack erzeugt den Notify-Descriptor automatisch.
    auto clock=svc->createCharacteristic(Protocol::clock,BLECharacteristic::PROPERTY_WRITE);
    clock->setCallbacks(this);
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
  void onConnect(BLEServer *) override { connected_.store(true); }
  void onDisconnect(BLEServer *) override { connected_.store(false); restart_.store(true); }
  void onWrite(BLECharacteristic *c) override {
    auto value=c->getValue();
    if(value.length()!=8 || uint8_t(value[0])!=1 || uint8_t(value[1])!=0) return;
    uint32_t epoch=0; for(int i=0;i<4;++i) epoch|=uint32_t(uint8_t(value[i+2]))<<(8*i);
    int16_t offset=int16_t(uint16_t(uint8_t(value[6]))|(uint16_t(uint8_t(value[7]))<<8));
    if(epoch<946684800UL||epoch>4102444799UL||offset < -720||offset>840) return;
    // Kein I2C/NVS im Bluetooth-Callback: Auftrag an die Hauptschleife.
    portENTER_CRITICAL(&mutex_); epoch_=epoch; offset_=offset; clockPending_=true; portEXIT_CRITICAL(&mutex_);
  }
 private:
  BLEServer *server_=nullptr; BLECharacteristic *data_=nullptr;
  std::atomic<bool> connected_{false},restart_{false};
  bool waiting_=false,clockPending_=false; uint32_t restartAt_=0,epoch_=0; int16_t offset_=60;
  portMUX_TYPE mutex_=portMUX_INITIALIZER_UNLOCKED;
};
