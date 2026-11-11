# StressMonitorBLE – XIAO ESP32C6

MAX30100 für Puls, Potentiometer an A0 für Atembewegungen, Seeed Round Display für Anzeige und Uhr, Bluetooth Low Energy für die spätere Handy-App.

## Neue Anzeige

Dunkelblauer Hintergrund, große Uhrzeit und Datum, zwei abgerundete Messwertkarten mit korallfarbenem Puls- und türkisfarbenem Atemakzent. Unten stehen Messstatus und Bluetooth-Verbindung. Fehlende Messwerte erscheinen als `--`. Beim Alarm blinkt die Fläche rot; anschließend zeigt die Atemhilfe Ein-/Ausatmen und einen Countdown. Die Uhr bleibt auch während der Atemhilfe sichtbar.

## Öffnen und kompilieren

Den gesamten Ordner `StressMonitorBLE` zusammenlassen und `StressMonitorBLE.ino` in Arduino IDE öffnen. Board **XIAO_ESP32C6**, ESP32 von Espressif **3.3.12**, USB CDC On Boot **Enabled**. Bibliothek **Seeed_GFX 2.0.3** verwenden; sie stellt TFT_eSPI.h bereit. Eine parallel installierte andere TFT_eSPI-Bibliothek kann die falsche Displaykonfiguration auswählen. `driver.h` muss neben der INO bleiben. BLE, Wire und Preferences sind im ESP32-Paket enthalten, weitere Sensor-/RTC-Bibliotheken werden nicht benötigt.

Im vorhandenen Projekt kann `..\Build-Firmware.ps1 -Sketch StressMonitorBLE` bauen; optional `-Port COM6` lädt zusätzlich hoch. Der Build verwendet vorübergehend Laufwerk R:.

## Anschlüsse

- MAX30100: SDA an D4/GPIO22, SCL an D5/GPIO23 und gemeinsame Masse. Die Versorgung muss zur konkreten Breakout-Platine passen; I2C-Pegel am ESP32 dürfen maximal 3,3 V betragen.
- Potentiometer: Außenanschlüsse 3V3 und GND, Schleifer A0/GPIO0. Ein vollständiges Hin-und-zurück entspricht einem Atemzug. Für echte Atemmessung muss die Bewegung mechanisch mit der Atmung gekoppelt sein.
- Round Display auf den XIAO stecken. **Den A0-Schalter des KE-DIP öffnen**, damit die Display-Batteriemessung A0 nicht beeinflusst. Den D6-Schalter für die Hintergrundbeleuchtung eingeschaltet lassen. Ohne diese Trennung kann Software den A0-Konflikt nicht beseitigen.

Die [Seeed-Dokumentation](https://wiki.seeedstudio.com/get_start_round_display/) beschreibt die Pinbelegung und Schalter. Die RTC ist die BM8563 am I2C-Bus (0x51).

## Uhr stellen

Nach dem ersten Start steht `--:--`, bis eine echte Zeit gesetzt wird. USB anschließen, seriellen Monitor schließen und in PowerShell im Sketch-Ordner ausführen:

```powershell
.\Set-Clock.ps1 -Port COM6
```

Das Skript übernimmt die aktuelle PC-Zeit einschließlich UTC-Abweichung. Alternativ im seriellen Monitor (115200 Baud, Zeilenumbruch) `T <UTC-Unixsekunden> <UTC-Abweichung-in-Minuten>` senden. In Deutschland beträgt die Abweichung im Winter 60 und im Sommer 120 Minuten. Beim Wechsel erneut synchronisieren; die Firmware enthält keine automatische Zeitzonenregel.

Die RTC speichert UTC, die Firmware speichert die Anzeigeabweichung. Eine eingelegte RTC-Stützbatterie ermöglicht die Fortsetzung nach Abschalten der Hauptversorgung. Ohne gültige RTC-Zeit wird nach Neustart wieder `--:--` gezeigt. Wenn die RTC nicht erreichbar ist, läuft die Uhr nach dem Stellen für die aktuelle Einschaltdauer dennoch. Die serielle CLOCK-Antwort unterscheidet diese Fälle. Handy-Synchronisierung ist im folgenden BLE-Protokoll vorgesehen.

## Messung und Warnung

Puls: FIFO-Abfrage des MAX30100 bei nominell 100 Hz, Bandpass/Spitzenerkennung, Mittelwert über fünf Schlagabstände plus exponentielle Glättung. Atmung: A0-Abfrage bei 50 Hz, geglättetes Signal, Umkehrpunkterkennung mit Hysterese, Mittelwert über drei Perioden plus exponentielle Glättung. Die alten drei PPG-Atemmethoden sind durch die ausdrücklich gewünschte Poti-Messung ersetzt. Es gibt keinen Qualitäts-Score. Hysterese verhindert, dass jeder ADC-Rauschschritt als Atemzug zählt. Ausgefallene oder veraltete Daten werden nicht als aktuelle Messungen weitergegeben.

Beide Werte müssen gleichzeitig und durchgehend **Puls > 100/min UND Atmung > 20/min für 5 Sekunden** erfüllen. Dann folgen 4 Sekunden rotes Blinken und 60 Sekunden Atemhilfe (4 Sekunden ein, 6 Sekunden aus). Werte sind oben in `Config.h` anpassbar. Dies sind technische Warnschwellen aus dem bisherigen Projekt, keine Diagnose einer Panikattacke und keine klinisch validierte Messung.

## Serielle Diagnose

Einmal pro Sekunde `DATA` mit HR, RRpot, ADC, IR, Rot, Sensortakt, FIFO-/I2C-Fehlern und Zustand. Damit lässt sich unterscheiden, ob der MAX30100 erreichbar ist, Rohdaten liefert und tatsächlich Schläge erkannt werden. Poti-Auswertung läuft bei ausgefallenem Pulssensor weiter.

- `v`: Warnung und Atemhilfe als sichtbaren TESTMODUS auslösen; Messwerte bleiben echt, BLE setzt das Demo-Flag.
- `x`: Displaytest beenden.
- `t`: zwölf synthetische Poti-Tests auf dem Board ausführen, Messung kurz pausieren und neu starten.

## Bluetooth-Schnittstelle für die App

Gerätename **StressMonitor**, Bluetooth Low Energy (kein BluetoothSerial/Classic). Messungen einmal pro Sekunde per Read/Notify, jeweils genau 20 Byte; funktioniert auch mit Standard-MTU 23. Notify muss die App abonnieren. `phone-protocol.mjs` enthält Decoder und Uhrpaketerzeugung; die eigentliche Handy-App ist noch nicht Bestandteil dieses Projekts.

| Element | UUID |
|---|---|
| Service | `89e10001-3b55-4a92-9b4d-173a6a0d8200` |
| Messung READ/NOTIFY | `89e10002-3b55-4a92-9b4d-173a6a0d8200` |
| Uhr WRITE | `89e10003-3b55-4a92-9b4d-173a6a0d8200` |

Alle Mehrbytewerte Little Endian:

| Byte | Inhalt |
|---|---|
| 0 | Protokollversion 1 |
| 1 | Flags: Bit 0 frische MAX-Daten; 1 Puls vorhanden; 2 Atmung vorhanden; 3 Warnung; 4 Atemhilfe; 5 Demo |
| 2–3 | uint16 Paketzähler, läuft über |
| 4–7 | uint32 Laufzeit in Millisekunden, läuft nach rund 49,7 Tagen über |
| 8–9 | uint16 Puls × 10; 65535 = fehlt |
| 10–11 | uint16 Atmung × 10; 65535 = fehlt |
| 12–13 | uint16 ADC (0–4095) |
| 14–15 | uint16 letzter IR-Rohwert, nur bei frischem MAX-Flag aktuell |
| 16–17 | uint16 letzter Rot-Rohwert, nur bei frischem MAX-Flag aktuell |
| 18 | Zustand: 0 Messen, 1 Schwelle halten, 2 Warnung, 3 Atemhilfe |
| 19 | Reserviert 0 |

Uhrpaket: 8 Byte, Byte 0 = 1, Byte 1 = 0, Byte 2–5 = uint32 Unixsekunden UTC, Byte 6–7 = int16 UTC-Abweichung in Minuten. Zulässig sind 2000 bis 2099 und -720 bis +840 Minuten. Beispiel: `encodeClock(new Date())`. Auf jedem Verbinden synchronisieren, außerdem nach Wechsel der Zeitzone/Sommerzeit. Der Schreibvorgang wird in der Hauptschleife verarbeitet; WRITE bestätigt den Empfang, nicht die RTC-Speicherung. Die tatsächliche RTC-Bestätigung steht derzeit im USB-Protokoll.

Die Entwicklungsschnittstelle verwendet keine Kopplung oder Verschlüsselung: Geräte in Reichweite können Daten lesen und die Uhr stellen. Vor einer personenbezogenen Produktanwendung ist ein Zugriffskonzept nötig.

## Prüfungen

`node --test protocol.test.mjs` prüft App-Decoder, Byte-Reihenfolge, fehlende Werte, Statusflags, Zeitpaket und Grenzen. Der Build prüft die Firmware gegen die konkreten installierten Board-/Bibliotheksversionen. Diese Prüfungen ersetzen weder den Test mit echten Sensorsignalen noch die Sichtkontrolle des Displays, die RTC-Prüfung nach Stromunterbrechung oder eine echte BLE-Verbindung zum Handy. Ein erfolgreicher Compilerlauf allein beweist keine Messgenauigkeit.

`Anzeige-Vorschau.png` zeigt die drei Ansichten mit Beispielwerten. Die Vorschau wurde mit den eingebauten Seeed-Schriftbildern erzeugt; sie ist keine Hardwareaufnahme. Der optionale Generator `tools/preview.mjs` verwendet die lokalen Bibliotheksdateien im übergeordneten Projekt.
