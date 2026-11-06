#include <Arduino.h>
#include "driver.h"
#include <TFT_eSPI.h>
#include <Wire.h>
#include "Config.h"
#include "Measurement.h"
#include "Max30100Device.h"
#include "BreathDetector.h"
#include "PotSelfTest.h"
#include "BleLink.h"
#include "ClockService.h"

#if !defined(ARDUINO_XIAO_ESP32C6)
#error "Bitte Board XIAO_ESP32C6 aus esp32 von Espressif auswaehlen."
#endif
#if !defined(GC9A01_DRIVER) || !defined(TFT_BL)
#error "Seeed_GFX mit driver.h / BOARD_SCREEN_COMBO 501 erforderlich."
#endif

TFT_eSPI display;
TFT_eSprite frame(&display);
Max30100Device sensor;
Measurement::Pipeline pipeline;
BreathDetector potBreathing;
Measurement::Alert alert;
BleLink bluetooth;
ClockService clockService;
uint16_t packetSequence = 0;
uint32_t lastData = 0, lastBeat = 0, lastPot = 0;
uint16_t potRaw = 0;
bool havePot = false;
uint32_t lastPoll = 0, lastRetry = 0, lastFrame = 0, lastReport = 0, lastVerify = 0;
uint32_t totalSamples = 0, totalBeats = 0, reportSamples = 0, maxPollGap = 0, maxFrameMs = 0;
uint16_t ir = 0, red = 0, irMin = UINT16_MAX, irMax = 0;
bool haveData = false, haveBeat = false, haveFrame = false;
bool demo = false;
uint32_t demoStarted = 0;

void clearMeasurement() {
  pipeline.reset();
  haveData = haveBeat = false;
}

void serviceSensor() {
  const uint32_t now = millis();
  if (!sensor.ready() || now - lastPoll < 5) return;
  if (now - lastPoll > maxPollGap) maxPollGap = now - lastPoll;
  lastPoll = now;
  Max30100Device::Sample samples[16];
  const int count = sensor.readSamples(samples);
  if (count < 0) {
    clearMeasurement();
    if (count == -1) sensor.offline();
    return;
  }
  if (!count) return;
  haveData = true; lastData = millis();
  totalSamples += count;
  for (int i = 0; i < count; ++i) {
    ir = samples[i].ir; red = samples[i].red;
    if (ir < irMin) irMin = ir;
    if (ir > irMax) irMax = ir;
    if (pipeline.add(ir)) { haveBeat = true; lastBeat = lastData; ++totalBeats; }
  }
}

void servicePot() {
  const uint32_t now = millis();
  if (havePot && now - lastPot < BreathDetector::sampleMs) return;
  potRaw = analogRead(Config::potPin);
  potBreathing.add(potRaw, now);
  lastPot = now; havePot = true;
}

bool dataFresh(uint32_t now) {
  return sensor.ready() && haveData && now - lastData < Config::noDataMs;
}
float currentPulse(uint32_t now) {
  return dataFresh(now) && haveBeat && now - lastBeat < Config::noBeatMs ? pipeline.pulse() : NAN;
}
float currentBreathing(uint32_t now) {
  // Die Poti-Messung ist unabhaengig von Pulserkennung und MAX30100-Fehlern.
  return havePot && now - lastPot <= 200 ? potBreathing.rate() : NAN;
}

void centered(const char *text, int y, int font, uint16_t color, uint16_t background) {
  frame.setTextColor(color, background);
  frame.drawCentreString(text, 120, y, font);
}

namespace Theme {
constexpr uint16_t background=0x0863, card=0x10E5, border=0x21A8;
constexpr uint16_t white=0xEF9E, muted=0x9D16, teal=0x4F38, coral=0xFD51;
}

void metricCard(int x, const char *label, const char *value, uint16_t accent, bool warning) {
  const uint16_t surface=warning ? 0x4000 : Theme::card;
  frame.fillRoundRect(x,91,90,78,12,surface);
  frame.fillRoundRect(x+12,103,3,10,1,accent);
  frame.setTextColor(Theme::muted,surface);
  frame.drawString(label,x+22,103,1);
  frame.setTextColor(Theme::white,surface);
  frame.drawCentreString(value,x+45,119,4);
  frame.setTextColor(Theme::muted,surface);
  frame.drawCentreString("/ min",x+45,151,1);
}

void drawScreen(uint32_t now) {
  if (!haveFrame) return;
  const uint32_t started=millis();
  const auto phase=alert.phase();
  const bool guide=phase==Measurement::Phase::Guide;
  const bool warning=phase==Measurement::Phase::Warning;
  const uint16_t bg=alert.red(now) ? 0xC800 : Theme::background;
  frame.fillSprite(bg);
  frame.drawCircle(120,120,117,warning ? Theme::white : Theme::border);
  char hhmm[6],seconds[3],date[16],text[64],pulseText[12]="--",breathText[12]="--";
  clockService.strings(hhmm,seconds,date);
  const float pulse=currentPulse(now), breaths=currentBreathing(now);
  if(Measurement::finite(pulse)) snprintf(pulseText,sizeof(pulseText),"%.0f",pulse);
  if(Measurement::finite(breaths)) snprintf(breathText,sizeof(breathText),"%.1f",breaths);
  if(guide) {
    centered(hhmm,23,2,Theme::muted,bg);
    centered(demo ? "ATEMHILFE / TEST" : "ATEMHILFE",49,1,Theme::teal,bg);
    centered(alert.inhaling(now) ? "Einatmen" : "Ausatmen",70,4,Theme::white,bg);
    snprintf(text,sizeof(text),"%lu",(unsigned long)((alert.breathRemaining(now)+999)/1000));
    centered(text,103,6,Theme::teal,bg);
    centered("Sanft und angenehm",159,2,Theme::muted,bg);
    snprintf(text,sizeof(text),"Puls %s  |  Atmung %s",pulseText,breathText);
    centered(text,183,1,Theme::muted,bg);
    const uint32_t t=alert.elapsed(now)%(Config::inhaleMs+Config::exhaleMs);
    const float fraction=t<Config::inhaleMs ? float(t)/Config::inhaleMs :
      1.0f-float(t-Config::inhaleMs)/Config::exhaleMs;
    frame.fillRoundRect(73,204,94,5,2,Theme::border);
    const int width=int(94*fraction);
    if(width>2) frame.fillRoundRect(73,204,width,5,2,Theme::teal);
  } else {
    centered(hhmm,24,6,Theme::white,bg);
    centered(date,76,1,Theme::muted,bg);
    metricCard(25,"PULS",pulseText,Theme::coral,warning);
    metricCard(125,"ATMUNG",breathText,Theme::teal,warning);
    const char *status="Messung aktiv";
    if(!sensor.ready()) status="Pulssensor fehlt";
    else if(!dataFresh(now)) status="Warte auf Pulsdaten";
    else if(!Measurement::finite(pulse)) status="Finger ruhig auflegen";
    else if(!Measurement::finite(breaths)) status="Warte auf Atembewegung";
    if(warning) status="WERTE ERHOEHT";
    else if(phase==Measurement::Phase::Pending) {
      snprintf(text,sizeof(text),"Erhoeht seit %.1f s",alert.elapsed(now)/1000.0f); status=text;
    }
    centered(status,181,2,warning ? Theme::white : Theme::muted,bg);
    centered(demo ? "TESTMODUS" : (!bluetooth.ready ? "BLE nicht verfuegbar" :
      (bluetooth.connected() ? "BLE verbunden" : "BLE bereit")),207,1,
      bluetooth.connected() ? Theme::teal : Theme::muted,bg);
  }
  serviceSensor();
  // Kurze SPI-Transfers halten beide Sensorabfragen auch beim Zeichnen aktiv.
  for(int y=0;y<240;y+=20) {
    frame.pushSprite(0,y,0,y,240,20);
    servicePot(); serviceSensor();
  }
  const uint32_t duration=millis()-started;
  if(duration>maxFrameMs) maxFrameMs=duration;
}

void report(uint32_t now) {
  if (now - lastReport < 1000) return;
  const float hz = (totalSamples - reportSamples) * 1000.0f / (now - lastReport);
  reportSamples = totalSamples; lastReport = now;
  uint8_t packet[20];
  Protocol::encode(packet,packetSequence++,now,currentPulse(now),currentBreathing(now),
                   potRaw,ir,red,uint8_t(alert.phase()),dataFresh(now),demo);
  bluetooth.publish(packet);
  char line[256];
  const int length = snprintf(line, sizeof(line),
      "DATA id=%02X ok=%u hz=%.1f ir=%u red=%u irSpan=%u samples=%lu beats=%lu HR=%.1f RRpot=%.2f ADC=%u fifo=%lu i2c=%lu gap=%lu frame=%lu state=%u test=%u\n",
      unsigned(sensor.partId), unsigned(dataFresh(now)), hz, unsigned(ir), unsigned(red),
      unsigned(irMax >= irMin ? irMax - irMin : 0), (unsigned long)totalSamples,
      (unsigned long)totalBeats, currentPulse(now), currentBreathing(now),
      unsigned(potRaw), (unsigned long)sensor.overflowEvents,
      (unsigned long)sensor.i2cErrors, (unsigned long)maxPollGap, (unsigned long)maxFrameMs,
      unsigned(alert.phase()), unsigned(demo));
  // USB darf ohne geoeffneten Monitor niemals Sensor/FIFO blockieren.
  if (Serial && length > 0 && length < int(sizeof(line)) && Serial.availableForWrite() >= length)
    Serial.write(reinterpret_cast<const uint8_t *>(line), size_t(length));
  irMin = UINT16_MAX; irMax = 0;
}

void setClock(uint32_t epoch,int16_t offset) {
  if(epoch<946684800UL||epoch>4102444799UL||offset < -720||offset>840) {
    Serial.println("CLOCK ungueltige Zeit oder UTC-Abweichung"); return;
  }
  const bool saved=clockService.set(epoch,offset);
  Serial.println(saved ? "CLOCK gestellt; RTC gespeichert" : "CLOCK gestellt; RTC nicht gespeichert");
  servicePot(); serviceSensor();
}

void handleCommands() {
  static char line[48]; static size_t used=0; static bool collecting=false,discard=false;
  // Begrenzte Arbeit pro Durchlauf, niemals blockierend auf eine Zeile warten.
  for(int n=0;n<48 && Serial.available();++n) {
    const char command=Serial.read();
    if(collecting) {
      if(command=='\r') continue;
      if(command=='\n') {
        line[used]=0;
        unsigned long epoch; int offset; char extra;
        if(!discard && sscanf(line,"%lu %d %c",&epoch,&offset,&extra)==2 && offset>=-720 && offset<=840)
          setClock(uint32_t(epoch),int16_t(offset));
        else Serial.println("CLOCK Format: T <UTC-Unixsekunden> <UTC-Abweichung-Minuten>");
        collecting=false; used=0; discard=false;
      } else if(used<sizeof(line)-1) line[used++]=command;
      else discard=true;
      continue;
    }
    if(command=='T') { collecting=true; used=0; discard=false; }
    else if(command=='t') {
      sensor.offline(); demo=false; alert=Measurement::Alert(); clearMeasurement();
      Serial.println("SELFTEST start; Messung pausiert");
      PotSelfTest::run(); potBreathing.reset(); havePot=false;
      sensor.begin(); lastData=lastPoll=millis(); maxPollGap=0;
    } else if(command=='v') {
      demo=true; demoStarted=millis(); alert=Measurement::Alert();
      Serial.println("DISPLAYTEST: 5s halten, 4s blinken, 60s Atemhilfe");
    } else if(command=='x') {
      demo=false; alert=Measurement::Alert(); Serial.println("DISPLAYTEST beendet");
    }
  }
}

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  pinMode(Config::potPin, INPUT);
  pinMode(D2, OUTPUT); digitalWrite(D2, HIGH); // SD-Karten-CS deaktivieren.
  display.init(); display.setRotation(0);
  pinMode(TFT_BL, OUTPUT); digitalWrite(TFT_BL, TFT_BACKLIGHT_ON);
  display.fillScreen(TFT_BLACK);
  bluetooth.begin();
  frame.setColorDepth(16); // RGB565 bewahrt die dunklen Farbabstufungen.
  haveFrame = frame.createSprite(240, 240) != nullptr;
  if (!haveFrame) {
    // Bei knappem zusammenhaengendem Heap bleibt eine reduzierte Farbtiefe nutzbar.
    frame.setColorDepth(8);
    haveFrame = frame.createSprite(240, 240) != nullptr;
  }
  if (!haveFrame) {
    display.setTextColor(TFT_RED, TFT_BLACK);
    display.drawCentreString("Display-Speicherfehler", 120, 110, 2);
  }
  Wire.begin(Config::sdaPin, Config::sclPin, Config::i2cHz);
  Wire.setTimeOut(20);
  clockService.begin();
  sensor.begin();
  lastData = lastPoll = lastRetry = lastReport = millis();
  drawScreen(millis());
}

void loop() {
  bluetooth.poll();
  uint32_t epoch; int16_t offset;
  if(bluetooth.takeClock(epoch,offset)) setClock(epoch,offset);
  servicePot();
  serviceSensor();
  uint32_t now = millis();
  if (sensor.ready() && now - lastData >= Config::noDataMs) {
    sensor.offline(); clearMeasurement();
  }
  if (!sensor.ready() && now - lastRetry >= 2000) {
    lastRetry = now; clearMeasurement();
    sensor.begin(); lastData = lastPoll = millis();
  }
  if (sensor.ready() && now - lastVerify >= 5000) {
    lastVerify = now;
    if (!sensor.verifyRegisters()) { sensor.offline(); clearMeasurement(); }
  }
  if (haveBeat && now - lastBeat >= Config::noBeatMs) {
    pipeline.reset(); haveBeat = false;
  }
  serviceSensor();
  now = millis();
  servicePot();
  now = millis();
  if (demo && now - demoStarted >= Config::thresholdHoldMs + Config::warningDurationMs + Config::guideDurationMs + 500) {
    demo = false; alert = Measurement::Alert();
  }
  alert.update(now, demo ? Config::warningPulse + 10 : currentPulse(now),
               demo ? Config::warningBreathing + 5 : currentBreathing(now),
               demo || (dataFresh(now) && Measurement::finite(currentBreathing(now))));
  if (now - lastFrame >= 100) { lastFrame = now; drawScreen(now); }
  serviceSensor();
  report(millis());
  handleCommands();
  delay(1); // RTOS/USB bedienen, Warnung/Atemanleitung laufen ohne Warte-Schleifen.
}
