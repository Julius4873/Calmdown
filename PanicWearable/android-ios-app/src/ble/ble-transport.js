import { BleClient } from '@capacitor-community/bluetooth-le';
import {
  BLE_SERVICE_UUID,
  CLOCK_UUID,
  MEASUREMENT_UUID,
  decodeMeasurement,
  encodeClock,
} from '../protocol.js';

export class BleTransport {
  deviceId = null;
  handlers = null;

  async connect(handlers) {
    await BleClient.initialize({ androidNeverForLocation: true });

    const device = await BleClient.requestDevice({
      services: [BLE_SERVICE_UUID],
    });
    this.deviceId = device.deviceId;
    this.handlers = handlers;

    try {
      await BleClient.connect(device.deviceId, (disconnectedDeviceId) => {
        if (this.deviceId !== disconnectedDeviceId) return;
        this.deviceId = null;
        this.handlers?.onDisconnected();
      });

      await BleClient.startNotifications(
        device.deviceId,
        BLE_SERVICE_UUID,
        MEASUREMENT_UUID,
        (value) => {
          try {
            this.handlers?.onMeasurement(decodeMeasurement(value));
          } catch (error) {
            this.handlers?.onProtocolError(error);
          }
        },
      );

      return device.name || 'PanicWearable';
    } catch (error) {
      this.deviceId = null;
      try {
        await BleClient.disconnect(device.deviceId);
      } catch (disconnectError) {
        handlers.onProtocolError(disconnectError);
      }
      throw error;
    }
  }

  async disconnect() {
    if (this.deviceId === null) return;
    const deviceId = this.deviceId;
    await BleClient.disconnect(deviceId);
    if (this.deviceId === deviceId) this.deviceId = null;
  }

  async syncClock(date = new Date()) {
    if (this.deviceId === null) {
      throw new Error('Kein BLE-Gerät verbunden.');
    }

    await BleClient.write(
      this.deviceId,
      BLE_SERVICE_UUID,
      CLOCK_UUID,
      encodeClock(date),
    );
  }
}
