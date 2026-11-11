# Prüfbericht – 06.11.2026

- Vollständiger Build von StressMonitorBLE für `esp32:esp32:XIAO_ESP32C6:CDCOnBoot=cdc` erfolgreich, Exitcode 0; ESP32-Core 3.3.12 / Seeed_GFX 2.0.3.
- Endgültige Firmware einschließlich 16-Bit-Anzeige und 8-Bit-Speicherfallback: 836124 Byte Programmspeicher (63 %), 21240 Byte statische globale Daten (6 %). BLE und Display reservieren zusätzlich Speicher zur Laufzeit; die statischen Angaben belegen keinen freien Laufzeit-Heap.
- Keine Fehler oder Warnungen aus dem Anwendungscode im abschließenden Build. Zwei Hinweise aus Seeed_GFX betreffen fehlendes DMA auf C6 und nicht verwendetes TFT_eSPI-Touch-CS. Der Sketch verwendet keine DMA- oder Touch-Funktion.
- Sieben Node-Tests für Handy-Decoder und Uhrpakete bestanden. Sie prüfen das App-Datenformat, keine echte Funkverbindung.
- PowerShell-Syntaxprüfung von Set-Clock.ps1 erfolgreich; serieller Austausch dieses Skripts wurde nicht auf dem Board durchgeführt.
- Layout-Vorschau mit Bibliotheksschriften visuell geprüft: normale Anzeige, Warnansicht und Atemanleitung. Die Vorschau ist eine Simulation mit Beispielwerten, keine Hardwareaufnahme.
- Die zwölf synthetischen Poti-Tests sind über `t` aufrufbar, wurden in dieser neuen Firmware nicht auf dem Board ausgeführt. Frühere Testergebnisse werden nicht als neuer Hardwaretest gewertet.
- Diese Fassung wurde nicht hochgeladen. Noch am Gerät zu prüfen: Sensor-/Poti-Rohdaten, reale Messwerte, verfügbare Speichermenge, Displayfarben/Flackern, RTC nach Neustart/Stromausfall, Handy-Verbindung samt Notify, Wiederverbinden und Uhrstellen.

Die Prüfsummen beschreiben die ausgelieferten C++-Quelldateien. Weder Kompilierung noch Simulation belegen medizinische Messgenauigkeit.
