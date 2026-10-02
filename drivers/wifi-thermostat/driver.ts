import Homey from "homey";
import { DiscoveryResultMAC } from "homey/lib/DiscoveryStrategy";
import { discover, HYSEN_DEVICE_TYPE } from "../../lib/broadlink";

const BROADLINK_DISCOVERY_TIMEOUT = 2 * 1000;
const BROADLINK_DISCOVERY_ATTEMPTS = 3;

interface FoundThermostat {
  mac: string;
  address: string;
}

class ThermostatDriver extends Homey.Driver {

  _scan: Promise<FoundThermostat[]> | null = null;

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log("ThermostatDriver has been initialized");

    // Homey's MAC discovery only sees devices in its ARP table, which a quiet
    // thermostat is not. A Broadlink broadcast makes them answer, so they show up.
    this.scanNetwork().catch(this.error);
  }

  /**
   * Find thermostats with a Broadlink broadcast. Concurrent calls share one scan.
   */
  scanNetwork(): Promise<FoundThermostat[]> {
    if (!this._scan) {
      this._scan = this._scanNetwork().finally(() => {
        this._scan = null;
      });
    }
    return this._scan;
  }

  private async _scanNetwork(): Promise<FoundThermostat[]> {
    const found = new Map<string, FoundThermostat>();

    // A single broadcast is sometimes lost, so send a few
    for (let attempt = 0; attempt < BROADLINK_DISCOVERY_ATTEMPTS; attempt++) {
      const devices = await discover(BROADLINK_DISCOVERY_TIMEOUT);
      for (const device of devices) {
        if (device.deviceType === HYSEN_DEVICE_TYPE) {
          found.set(device.mac, { mac: device.mac, address: device.address });
        }
      }
    }

    const thermostats = [...found.values()];
    this.log(`Broadlink scan found ${thermostats.length} thermostat(s)`, thermostats);
    return thermostats;
  }

  /**
   * onPairListDevices is called when a user is adding a device and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPairListDevices() {
    const found = new Map<string, FoundThermostat>();

    try {
      for (const thermostat of await this.scanNetwork()) {
        found.set(thermostat.mac, thermostat);
      }
    } catch (error) {
      this.error("Broadlink scan failed", error);
    }

    const discoveryResults = this.getDiscoveryStrategy().getDiscoveryResults();
    for (const discoveryResult of Object.values(discoveryResults) as DiscoveryResultMAC[]) {
      found.set(discoveryResult.mac.toLowerCase(), { mac: discoveryResult.mac, address: discoveryResult.address });
    }

    // The data id must match the MAC discovery result id (the lowercase MAC)
    return [...found.values()].map((thermostat) => ({
      name: "Computherm Wifi Thermostat",
      data: {
        id: thermostat.mac.toLowerCase(),
        mac: thermostat.mac,
        address: thermostat.address,
      },
    }));
  }

}

module.exports = ThermostatDriver;
