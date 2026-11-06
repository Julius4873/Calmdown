#pragma once
#include <Arduino.h>
#include <Wire.h>
#include <Preferences.h>
#include <time.h>
#include <sys/time.h>
class ClockService {
 public:
  bool valid=false;
  void begin() {
    prefs_.begin("stress-clock",false);
    offset_=prefs_.getShort("offset",60);
    if (!prefs_.getBool("set",false)) return;
    Wire.beginTransmission(0x51); Wire.write(uint8_t(0));
    if(Wire.endTransmission(false)!=0 || Wire.requestFrom(uint8_t(0x51),size_t(1))!=1) return;
    if(Wire.read() & 0x20) return;
    uint8_t r[7];
    if (!read(r) || (r[0]&0x80)) return;
    tm t={}; t.tm_sec=bcd(r[0]&0x7f); t.tm_min=bcd(r[1]&0x7f);
    t.tm_hour=bcd(r[2]&0x3f); t.tm_mday=bcd(r[3]&0x3f);
    t.tm_mon=bcd(r[5]&0x1f)-1; t.tm_year=100+bcd(r[6]);
    if(t.tm_sec>59||t.tm_min>59||t.tm_hour>23||t.tm_mday<1||t.tm_mday>31||t.tm_mon<0||t.tm_mon>11) return;
    setenv("TZ","UTC0",1); tzset();
    time_t epoch=mktime(&t); if(epoch<946684800||epoch>4102444799LL) return;
    timeval tv={epoch,0}; settimeofday(&tv,nullptr); valid=true;
  }
  bool set(uint32_t epoch,int16_t offset) {
    if(epoch<946684800UL || epoch>4102444799UL || offset < -720 || offset > 840) return false;
    time_t seconds=epoch; tm t; gmtime_r(&seconds,&t);
    Wire.beginTransmission(0x51); Wire.write(uint8_t(0)); Wire.write(uint8_t(0x20));
    bool saved=Wire.endTransmission()==0;
    uint8_t data[]={0x02,enc(t.tm_sec),enc(t.tm_min),enc(t.tm_hour),enc(t.tm_mday),enc(t.tm_wday),enc(t.tm_mon+1),enc(t.tm_year-100)};
    Wire.beginTransmission(0x51); Wire.write(data,sizeof(data));
    saved=(Wire.endTransmission()==0) && saved;
    // STOP loeschen: eine zuvor angehaltene RTC muss wieder laufen.
    Wire.beginTransmission(0x51); Wire.write(uint8_t(0)); Wire.write(uint8_t(0));
    saved=(Wire.endTransmission()==0) && saved;
    // Lokale Uhr funktioniert auch ohne RTC; keine falsche Persistenz versprechen.
    timeval tv={seconds,0}; settimeofday(&tv,nullptr); offset_=offset; valid=true;
    prefs_.putShort("offset",offset); prefs_.putBool("set",saved);
    return saved;
  }
  void strings(char *hhmm,char *ss,char *date) const {
    if(!valid) { strcpy(hhmm,"--:--"); strcpy(ss,""); strcpy(date,"Uhr stellen"); return; }
    time_t local=time(nullptr)+offset_*60; tm t; gmtime_r(&local,&t);
    strftime(hhmm,6,"%H:%M",&t); strftime(ss,3,"%S",&t); strftime(date,16,"%d.%m.%Y",&t);
  }
 private:
  Preferences prefs_; int16_t offset_=60;
  static uint8_t enc(int n) { return (n/10)*16+n%10; }
  static int bcd(uint8_t n) { return (n>>4)*10+(n&15); }
  bool read(uint8_t *r) {
    Wire.beginTransmission(0x51); Wire.write(0x02);
    if(Wire.endTransmission(false)!=0 || Wire.requestFrom(uint8_t(0x51),size_t(7))!=7) return false;
    for(int i=0;i<7;++i) r[i]=Wire.read(); return true;
  }
};
