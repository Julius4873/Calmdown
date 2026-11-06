# PanicWearable

Plattformübergreifender App-Prototyp für ein ESP32-Wearable. Die App zeigt künstliche Demo-Messwerte und kann per BLE Messwerte vom `StressMonitor` empfangen.

> **Forschungsprototyp:** Diese Software ist kein Medizinprodukt. Messwerte und Hinweise sind weder eine Diagnose noch ein Ersatz für medizinische Beratung. Die Atemfrequenz ist insbesondere experimentell.

Die App tauscht Laufzeitdaten direkt und lokal über BLE aus; sie benötigt weder Konto noch Cloud oder Internetverbindung zum Wearable. Internet wird einmalig für Node.js-Pakete und Entwicklungswerkzeuge benötigt.

## Bestand und Annahmen

- Die App decodiert das 20-Byte-Messprotokoll des ESP32 und kann die Geräteuhr über die dokumentierte BLE-Characteristic stellen.
- Die Ordner `esp32-firmware/`, `android-ios-app/` und `docs/` trennen Firmware, App und Schnittstellendokumentation.
- Die vereinbarten UUIDs und Datenformate sind in `docs/ble-protocol.md` dokumentiert.
- Verwendete stabile Paketversionen sind in `android-ios-app/package.json` fest eingetragen. Für Vite 8 und Capacitor 8 wird Node.js 22.12 oder neuer benötigt.

## Voraussetzungen

- Node.js 22.12+ (enthält npm)
- Für Android: Android Studio mit Android SDK, Platform Tools und einem Gerät mit aktiviertem USB-Debugging
- Für iOS: ein Mac mit Xcode und CocoaPods; iOS-Builds sind unter Windows nicht möglich

Java und das Android-SDK werden für native Android-Builds benötigt und üblicherweise mit Android Studio eingerichtet. Für den reinen Browser-Demomodus genügt Node.js.

Node.js kann kostenlos über [nodejs.org](https://nodejs.org/) installiert werden. Android Studio und das SDK gibt es kostenlos unter [developer.android.com/studio](https://developer.android.com/studio). Danach ein neues PowerShell-Fenster öffnen und `node --version` sowie `npm --version` ausführen.

## Installieren und starten

In PowerShell:

```powershell
cd .\android-ios-app
npm install
npm run dev
```

Die lokale Vite-Adresse im Browser öffnen (gewöhnlich `http://localhost:5173`). Der Demomodus startet automatisch. „Simulation“ pausiert/aktiviert die Demo; „BLE verbinden“ öffnet die Geräteauswahl des Browsers bzw. Betriebssystems. BLE im Browser ist nur in kompatiblen Browsern und sicheren Kontexten wie `localhost` verfügbar.

## Android-App erzeugen (Windows)

Nach Installation von Android Studio, Android SDK und Node.js:

```powershell
cd .\android-ios-app
npm install
npx cap add android
npx cap sync android
npx cap open android
```

In Android Studio ein Gerät auswählen und starten. Alternativ kann ein verbundenes Gerät mit USB-Debugging verwendet werden:

```powershell
npx cap run android
```

Für eine APK: In Android Studio **Build > Build Bundle(s) / APK(s) > Build APK(s)** wählen. Nach Änderungen am Web-Code immer `npm run build` und `npx cap sync android` ausführen.

Das BLE-Plugin verwaltet die Android-Bluetooth-Berechtigungen. Android 12 (API 31) und neuer verwenden `BLUETOOTH_SCAN` und `BLUETOOTH_CONNECT`; die App leitet aus Scan-Ergebnissen keinen Standort ab. Die BLE-Initialisierung setzt daher `androidNeverForLocation: true`. Falls das Betriebssystem bestimmte Geräte aus dem Scan herausfiltert, muss diese Einstellung samt Manifest-Flag überprüft werden. Auf älteren Android-Versionen können Standortberechtigungen für BLE-Scans erforderlich sein.

## iOS vorbereiten (nur auf einem Mac)

Auf einem Mac im Ordner `android-ios-app`:

```sh
npm install
npx cap add ios
npx cap sync ios
npx cap open ios
```

In Xcode im App-Target unter **Info** den Eintrag **Privacy - Bluetooth Always Usage Description** (`NSBluetoothAlwaysUsageDescription`) mit einer verständlichen Begründung ergänzen, zum Beispiel: „Bluetooth wird verwendet, um eine Verbindung zum PanicWearable-Prototyp herzustellen.“ Danach Team/Signing konfigurieren und auf einem **echten iPhone** starten. Der iOS-Simulator hat kein BLE. Hintergrund-BLE ist nicht implementiert; `bluetooth-central` deshalb nicht als Hintergrundmodus hinzufügen.

Nach Änderungen am Web-Code `npm run build` und `npx cap sync ios` auf dem Mac ausführen. Hier wurden keine iOS-Builds oder iPhone-Tests durchgeführt.

## Bedienung

- **Simulation:** erzeugt sichtbar gekennzeichnete Testwerte und einen Beispielverlauf. Sie stellt keine Sensorfunktion dar.
- **BLE verbinden:** sucht den `StressMonitor`, abonniert dessen Messwert-Notifications und sendet die aktuelle Uhrzeit.
- **Uhr synchronisieren:** sendet die Uhrzeit manuell oder bei Verbindung/Zeitzonenwechsel. Ein BLE-Schreib-Erfolg bestätigt nicht, dass die Firmware die Uhrzeit in der RTC gespeichert hat.
- **Messwerte:** zeigt Puls, Atemfrequenz, ADC-/IR-/Rot-Rohwerte und die übertragenen Zustandsflags an. Im Demo-Modus bleiben alle Werte künstlich.
- **Sicherheit:** die Entwicklungs-BLE-Schnittstelle ist ungepaart und unverschlüsselt; keine personenbezogenen Daten übertragen.
- Bei Verbindungsverlust werden BLE-Werte nicht weiter aktualisiert. Erneut verbinden oder die Simulation manuell aktivieren.
- Ungültige Pakete werden verworfen und als Protokollfehler angezeigt; unbekannte/fehlende Einzelmesswerte werden als „—“ angezeigt.

### Schneller Selbsttest ohne Hardware

1. `npm run dev` starten und die lokale Adresse in einem Browser öffnen.
2. Prüfen, dass Demo-Herzfrequenz, geschätzte Atemfrequenz und Diagramm aktualisiert werden und der Demo-Hinweis sichtbar bleibt.
3. „Simulation pausieren“ klicken; die Werte und der Verlauf bleiben stehen. Mit „Simulation starten“ wird der Verlauf neu begonnen.
4. Die angezeigten Rohwerte und Demo-Status prüfen; sie müssen ausdrücklich als künstlich erzeugt erkennbar sein.
5. „BLE verbinden“ ohne Gerät testen; der Verbindungsdialog bzw. eine aussagekräftige Browser-/Bluetooth-Meldung sollte erscheinen. BLE-Funktion erfordert ein Protokoll-konformes Gerät.

## Schnittstelle und nächste Firmware-Schritte

Das Protokoll ist in [`docs/ble-protocol.md`](docs/ble-protocol.md) beschrieben. Nächste Schritte für die Firmware:

1. BLE-GATT-Service, 20-Byte-Messwertpaket und 8-Byte-Uhrpaket wie in `docs/ble-protocol.md` implementieren.
2. Den RTC-Schreibstatus im USB-Protokoll verifizieren; ein BLE-Write allein bestätigt nur den Empfang des Pakets.
3. Vor Produktverwendung BLE-Zugriffsschutz mit Authentifizierung und Verschlüsselung ergänzen.
4. BLE-Payloads zuerst mit einem BLE-Scanner und anschließend mit der App testen; keine klinischen Warnschwellen ohne fachliche Validierung verwenden.

## Entwicklungsbefehle

```powershell
npm run dev       # Web-App mit Hot Reload
npm run build     # Produktionsdateien nach dist/
npm run preview   # Produktions-Build lokal ansehen
npm test          # BLE-Protokolltests (Node.js)
```

Für Android-Builds werden Java und Android SDK benötigt. BLE muss mit der realen ESP32-Firmware auf einem kompatiblen Gerät getestet werden.
