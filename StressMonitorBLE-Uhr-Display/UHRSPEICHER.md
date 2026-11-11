# Uhrspeicher und automatischer Kalender-Abgleich

## Aktivieren

1. In Arduino IDE **StressMonitorBLE/StressMonitorBLE.ino in diesem Ordner** öffnen. Nicht die gleichnamige ältere Kopie im Hauptordner verwenden.
2. Board **XIAO_ESP32C6**, USB CDC beim Start aktiviert, Partition Scheme **Default** auswählen. Die vorhandenen Seeed-GFX-Einstellungen beibehalten. **Erase All Flash Before Sketch Upload: Disabled** lassen, damit RTC-Einstellungen und spätere Messdaten erhalten bleiben.
3. Die Firmware selbst per USB aufspielen. Alternativ lässt sich mit `Build-Uhr-Historie.ps1` aus diesem Ordner erneut kompilieren. Das Skript baut nur und lädt nichts auf die Uhr. Es benötigt das vorhandene `.arduino-local` im übergeordneten Projekt und ein freies Laufwerk R:.
4. https://calmdown-bluefy.julko05.chatgpt.site in Bluefy neu laden und verbinden. Beim ersten Verbinden wird die Uhrzeit übertragen. Unter **Gerät → Gerätediagnose** stehen Uhrspeicher, Kapazität und mögliche Fehler. Ohne gültige Uhrzeit werden keine falsch datierten Minuten gespeichert.
5. **Verlauf speichern** in der App einschalten. Bluefy zum Abgleich im Vordergrund geöffnet lassen. Die Meldung „Uhrverlauf abgeglichen“ bestätigt den abgeschlossenen Import der aktuell verfügbaren Minuten.

## Was gespeichert wird

Die Uhr legt abgeschlossene Messminuten für Puls und Atemfrequenz in ihrem internen Flash ab (LittleFS in der Datenpartition). Eine Minute enthält Messzeit, UTC-Abweichung, Anzahl gültiger Werte, Summe und Maximum. Damit bleiben Durchschnitt und Maximum korrekt, auch wenn einzelne Werte fehlen. Es werden keine vollständigen optischen Rohkurven gespeichert. Demo-/Testwerte werden ausgeschlossen.

Der Ring hat maximal 12.288 Minutenplätze, entsprechend etwa 8,5 Tagen durchgehender Messung bei einem Datensatz pro Minute. Die tatsächlich eingerichtete Kapazität steht in der App. Wenn ein Segment wiederverwendet wird, entfallen bis zu 192 der ältesten Minuten gleichzeitig. Bereits in die App importierte Daten bleiben dort erhalten. Häufige Zeitkorrekturen oder beschädigte Segmente können die nutzbare Zeitspanne verkürzen.

Abgeschlossene und erfolgreich geschriebene Minuten überstehen einen Neustart. Die gerade laufende Minute und noch nicht geschriebene Warteschlangeneinträge können bei abruptem Stromverlust verloren gehen. CRC-Prüfungen erkennen beschädigte Datensätze; ein beschädigtes Ende wird nicht weiter beschrieben.

Nach jeder Verbindung fordert die App fehlende Minuten automatisch an. Sie speichert Messwerte und Importposition gemeinsam in einer IndexedDB-Transaktion und bestätigt erst danach. Ein erneuter Verbindungsabbruch führt so nicht zu doppelten Einträgen. Die Zuordnung im Kalender verwendet die ursprüngliche Messzeit und die damals auf der Uhr gespeicherte UTC-Abweichung. Eine Sommerzeitumstellung oder ein Zeitzonenwechsel wird beim nächsten Verbinden aktualisiert, nicht autonom während einer langen Offlinephase.

Die Uhr behält ihre Daten bis zur Wiederverwendung des Ringsegments auch nach erfolgreichem Import. „Verlauf speichern“ schaltet nur die Übernahme in diese App ab; die Uhr speichert weiter. Das Löschen eines Tages in der App löscht nicht den Flash auf der Uhr; der Importzeiger verhindert das erneute Einlesen bereits übernommener Datensätze in denselben Browser. Werden Browserdaten vollständig gelöscht oder ein anderes Gerät genutzt, kann der noch vorhandene Uhrverlauf erneut importiert werden. Eine Cloud ist nicht eingerichtet.

## Verbindungstest nach dem Aufspielen

1. Uhr verbinden, gültige Messwerte und synchronisierte Zeit prüfen. Mindestens zwei Minuten messen.
2. Bluetooth-Verbindung für drei bis fünf Minuten trennen, Uhr eingeschaltet lassen und weiter messen.
3. Erneut verbinden und Bluefy geöffnet lassen, bis der Abgleich beendet ist.
4. Im Kalender prüfen, dass die Offline-Minuten unter ihren ursprünglichen Uhrzeiten erscheinen und Tagesdurchschnitt/Maximum aktualisiert wurden.
5. Nochmals trennen/verbinden: Bereits übernommene Werte dürfen sich nicht verdoppeln.
6. Optional nach abgeschlossener Minute die Uhr neu starten und den erhaltenen Speicher prüfen. Die laufende Minute ist nicht gegen Stromverlust abgesichert.

## Fehler erkennen

USB-Seriell mit `h` liefert `HISTORY` mit Flags, Fehlercode, Anzahl, Kapazität und Sequenzen. Fehlercodes: 1 Partition fehlt, 2 unbekanntes oder nicht mountbares Dateisystem, 3 Metadaten beschädigt, 4 zu wenig Platz, 5 Dateizugriff, 6 Warteschlange voll, 7 beschädigtes Ende erkannt, 8 Speicher-Task konnte nicht starten. Eine bestehende unbekannte Datenpartition wird absichtlich nicht automatisch formatiert. Nicht vorschnell den ganzen Flash löschen: Das würde Messdaten und Einstellungen entfernen.

## Prüfung

Am 10.11.2026 bestanden alle 68 App-Tests und der Vite-Produktionsbuild. Die kanonische Firmware wurde mit ESP32 Arduino Core 3.3.12 erfolgreich gebaut: 879.992 Bytes Programmspeicher (67 %), 22.128 Bytes statische globale Daten. Binärdateien liegen in `artifacts`, das Protokoll in `Uhr-Historie-build.log`. Die üblichen Warnungen der vorhandenen Seeed-GFX-Bibliothek bleiben bestehen.

Automatisierte App-Tests prüfen unter anderem Import nach Abbruch, CRC, ursprüngliche Kalendertage, atomare Speicherung und Duplikatschutz. `StressMonitorBLE/tests/history-core.cpp` enthält zusätzliche C++-Tests für Ringüberlauf und Wiederherstellung; diese wurden mit dem ESP32-Compiler syntaxgeprüft, mangels lokalem Host-C++-Compiler aber nicht ausgeführt. Speicherstatus und Kalender wurden in der lokalen Browser-Vorschau geöffnet. Ein erfolgreicher Firmware-Build ist kein Nachweis für Flash-Timing, Sensorsampling oder die tatsächliche Bluetooth-Verbindung mit dem iPhone; dafür dient der obige Gerätetest. Die Uhr wurde nicht geflasht.

Die App wurde als Sites-Version 7 veröffentlicht. Beim Aufspielen über die Arduino IDE den normalen Sketch-Upload verwenden. Das zusätzlich erzeugte `merged.bin` umfasst den gesamten Flashbereich und soll nicht zum Erhalt eines bereits gefüllten Uhrspeichers verwendet werden.
