# StressMonitor BLE-Protokoll

Das Telefon ist BLE-Central/GATT-Client; der ESP32 ist BLE-Peripheral/GATT-Server. Die Verbindung arbeitet lokal ohne Cloud.

## GATT UUIDs

| Element | UUID | Eigenschaften |
| --- | --- | --- |
| Service | `89e10001-3b55-4a92-9b4d-173a6a0d8200` | Primärer GATT-Service |
| Messung | `89e10002-3b55-4a92-9b4d-173a6a0d8200` | `Read` / `Notify` |
| Uhr | `89e10003-3b55-4a92-9b4d-173a6a0d8200` | `Write` mit Antwort |

Das Gerät meldet sich als `StressMonitor`. Notifications werden einmal pro Sekunde gesendet. Mehrbytewerte sind Little Endian; das Messpaket ist genau 20 Byte lang.

## Messpaket: 20 Byte

| Byte(s) | Typ | Bedeutung |
| --- | --- | --- |
| 0 | `uint8` | Protokollversion, aktuell `1` |
| 1 | Bitfeld | Flags gemäß unten |
| 2–3 | `uint16` | Paketzähler, läuft über |
| 4–7 | `uint32` | Laufzeit in Millisekunden, läuft nach ca. 49,7 Tagen über |
| 8–9 | `uint16` | Puls × 10; `65535` bedeutet nicht verfügbar |
| 10–11 | `uint16` | Atmung × 10; `65535` bedeutet nicht verfügbar |
| 12–13 | `uint16` | ADC-Wert `0..4095` |
| 14–15 | `uint16` | Letzter IR-Rohwert; nur bei gesetztem MAX-frisch-Flag aktuell |
| 16–17 | `uint16` | Letzter Rot-Rohwert; nur bei gesetztem MAX-frisch-Flag aktuell |
| 18 | `uint8` | Zustand: `0` Messen, `1` Schwelle halten, `2` Warnung, `3` Atemhilfe |
| 19 | `uint8` | Reserviert, muss `0` sein |

### Flags (Byte 1)

| Bit | Bedeutung |
| --- | --- |
| 0 | MAX-Daten frisch |
| 1 | Puls vorhanden |
| 2 | Atmung vorhanden |
| 3 | Warnung |
| 4 | Atemhilfe |
| 5 | Demo |
| 6–7 | Reserviert, müssen `0` sein |

Puls und Atmung werden nur angezeigt, wenn das zugehörige Vorhanden-Flag gesetzt und der Wert nicht `65535` ist. Der angezeigte Zahlenwert ist der Rohwert geteilt durch 10. Das MAX-frisch-Flag kennzeichnet, ob die IR-/Rot-Rohwerte in diesem Paket aktuell sind. ADC-, IR- und Rot-Werte sind nicht medizinisch interpretierte Messwerte.

## Uhrzeit setzen: 8 Byte

Die App sendet die lokale Gerätezeit beim Verbinden sowie erneut, wenn sich während der Verbindung der UTC-Offset ändert (z. B. durch Zeitzonen- oder Sommerzeitwechsel). Ein manueller Versand ist ebenfalls möglich.

| Byte(s) | Typ | Bedeutung |
| --- | --- | --- |
| 0 | `uint8` | Paketversion `1` |
| 1 | `uint8` | Flags `0` |
| 2–5 | `uint32` | Unix-Zeit in Sekunden (UTC), Little Endian |
| 6–7 | `int16` | UTC-Abweichung in Minuten, Little Endian; zulässig `-720..840` |

Zeitwerte von 2000 bis einschließlich 2099 werden unterstützt. Ein erfolgreicher BLE-Write bestätigt nur den Empfang des Pakets, nicht die Speicherung in der RTC. Die Firmware bestätigt die tatsächliche RTC-Speicherung derzeit über das USB-Protokoll; die App zeigt daher keine RTC-Bestätigung an.

## Sicherheit und Grenzen

Die Entwicklungsschnittstelle verwendet weder Kopplung noch Verschlüsselung. BLE-Geräte in Reichweite können Daten lesen und die Uhr stellen. Keine personenbezogenen Daten mit diesem Prototyp übertragen; vor Produktverwendung ist ein Zugriffskonzept mit authentifizierter/verschlüsselter Verbindung erforderlich.

Die App verwirft Pakete mit falscher Länge, unbekannter Version, reservierten Flags, ADC-Werten über 4095, unbekannten Zuständen oder einem nicht-null reservierten Byte. Verbindungsverlust wird sichtbar angezeigt; es gibt keinen automatischen Reconnect. Der Browser-BLE-Modus erfordert einen kompatiblen Browser und einen sicheren Kontext wie `localhost`; native Android-/iOS-Apps verwenden das Capacitor-BLE-Plugin.
