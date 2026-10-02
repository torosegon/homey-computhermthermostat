import Homey from "homey";
import { DiscoveryResultMAC } from "homey/lib/DiscoveryStrategy";
import { HysenClimateStatus, HysenThermostat } from "../../lib/broadlink";

type ThermostatMode = "auto" | "heat" | "cool" | "off";

interface ThermostatAddress {
  mac: string;
  address: string;
}

interface ThermostatDriver {
  scanNetwork(): Promise<ThermostatAddress[]>;
}

const STATUS_POLL_INTERVAL = 60 * 1000;

const REQUEST_TIMEOUT = 10 * 1000;

function statusToThermostatMode(status: HysenClimateStatus): ThermostatMode {
  if (status.power !== 1) return "off";
  return status.autoMode === 1 ? "auto" : "heat";
}

class ThermostatDevice extends Homey.Device {

  /**
   * Instance of Device
   *
   * @private
   */
  _hysenDevice: HysenThermostat | null = null;

  /**
   * Where the thermostat was last seen, used to (re)connect
   */
  _target: ThermostatAddress | null = null;

  /**
   * Reconnect in progress, only one runs at a time
   */
  _reconnecting: Promise<void> | null = null;

  /**
   * The target changed while a reconnect was running
   */
  _reconnectAgain = false;

  /**
   * Requests are sent one at a time: the thermostat answers one request at a
   * time, and multi-step actions (read status, then write) must not interleave.
   */
  _requestQueue: Promise<unknown> = Promise.resolve();

  /**
   * Status timer
   */
  _statusTimer: NodeJS.Timeout | null = null;

  /**
   * Mark the device as offline in Homey
   *
   * @private
   */
  _markOffline() {
    this.log("[offline] mark device offline");
    this.setUnavailable(this.homey.__("error.offline")).catch(this.error);
  }

  onDiscoveryResult(discoveryResult: DiscoveryResultMAC) {
    // Return a truthy value here if the discovery result matches your device.
    return discoveryResult.id === this.getData().id;
  }

  /**
   * // This method will be executed once when the device has been found (onDiscoveryResult returned true)
   *
   * @param {DiscoveryResultMAC} discoveryResult result of the MAC discovery action
   */
  async onDiscoveryAvailable(discoveryResult: DiscoveryResultMAC) {
    this.log("ThermostatDevice is available");
    this.log(`Device ID=${discoveryResult.id} MAC=${discoveryResult.mac} address=${discoveryResult.address}`);

    this._target = discoveryResult;
    if (this._hysenDevice?.address === discoveryResult.address) return;

    await this._reconnect();
    this.log(" settings (after init) =   ", this.getSettings());
  }

  async onDiscoveryAddressChanged(discoveryResult: DiscoveryResultMAC) {
    this.log(`Device address changed to ${discoveryResult.address}`);
    this._target = discoveryResult;
    await this._reconnect();
  }

  async onDiscoveryLastSeenChanged(discoveryResult: DiscoveryResultMAC) {
    this._target = discoveryResult;
    // When the device is offline, try to reconnect here
    if (!this.getAvailable()) {
      await this._reconnect();
    }
  }

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log("ThermostatDevice has been initialized");

    // Capability listeners are registered once; they use the current connection
    this._setCapabilityListeners();

    // Connect to the address stored at pairing, don't wait for Homey's MAC
    // discovery: it only reports devices Homey recently talked to.
    const { mac, address } = this.getData();
    if (mac && address) {
      this._target = { mac, address };
    }
    // Poll even if the first connection fails, the timer retries it
    this._startStatusTimer();
    this._reconnect().catch(this.error);
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log("ThermostatDevice has been added");
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({
    oldSettings,
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    this.log("ThermostatDevice settings where changed");

    for (const key of changedKeys) {
      this.log(` - ${key} changed from ${oldSettings[key]} to ${newSettings[key]}`);
      if (key === "remove_lock") {
        const remoteLockValue = newSettings[key] ? 1 : 0;
        await this._run(async (hysenDevice) => {
          const { power } = await hysenDevice.getFullStatus();
          await hysenDevice.setPower(power, remoteLockValue);
        });
      }
    }
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name: string) {
    this.log("ThermostatDevice was renamed");
  }

  /**
   * onUninit is called when the device is destroyed (e.g. app restart).
   */
  async onUninit() {
    this._stopStatusTimer();
    this._disconnect();
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this._stopStatusTimer();
    this._disconnect();
    this.log("ThermostatDevice has been deleted");
  }

  // Custom actions
  private async _connect() {
    const discoveryResult = this._target;
    if (!discoveryResult) {
      throw new Error(this.homey.__("error.offline"));
    }

    this._disconnect();

    const hysenDevice = new HysenThermostat(discoveryResult.address, discoveryResult.mac, REQUEST_TIMEOUT);
    try {
      await hysenDevice.auth();
    } catch (error) {
      hysenDevice.close();
      throw error;
    }
    this.log(" authed");

    this._hysenDevice = hysenDevice;
    await this.setAvailable();
  }

  /**
   * Close the UDP socket of the current connection
   */
  private _disconnect() {
    if (this._hysenDevice) {
      this._hysenDevice.close();
      this._hysenDevice = null;
    }
  }

  /**
   * Connect to the current target. Only one reconnect runs at a time; if the
   * target changes meanwhile, it runs again for the new target.
   */
  private _reconnect(): Promise<void> {
    if (this._reconnecting) {
      this._reconnectAgain = true;
      return this._reconnecting;
    }

    this._reconnecting = (async () => {
      do {
        this._reconnectAgain = false;
        await this._tryReconnect();
      } while (this._reconnectAgain && this._hysenDevice?.address !== this._target?.address);
    })().finally(() => {
      this._reconnecting = null;
    });
    return this._reconnecting;
  }

  private async _tryReconnect() {
    const failedAddress = this._target?.address;
    try {
      try {
        await this._connect();
      } catch (error) {
        // The thermostat may have a new IP address, look for it on the network
        if (!await this._findNewAddress(failedAddress)) throw error;
        await this._connect();
      }
      await this._refreshStatus();
    } catch (error) {
      this.error("Failed to reconnect", error);
      this._markOffline();
    }
  }

  /**
   * Look for this thermostat with a Broadlink scan, returns true if it is at
   * another address than the one that failed
   */
  private async _findNewAddress(failedAddress: string | undefined): Promise<boolean> {
    const { id } = this.getData();
    const thermostats = await (this.driver as unknown as ThermostatDriver).scanNetwork();
    const found = thermostats.find((thermostat) => thermostat.mac.toLowerCase() === id);
    if (!found || found.address === failedAddress) return false;

    this.log(`Thermostat found at new address ${found.address}`);
    this._target = found;
    return true;
  }

  /**
   * Run requests against the thermostat one at a time, with a timeout.
   * A timed out connection is dropped, the status timer reconnects it.
   */
  private _run<T>(action: (hysenDevice: HysenThermostat) => Promise<T>): Promise<T> {
    const result = this._requestQueue.then(async () => {
      const hysenDevice = this._hysenDevice;
      if (!hysenDevice) {
        throw new Error(this.homey.__("error.offline"));
      }
      try {
        return await action(hysenDevice);
      } catch (error) {
        if (this._hysenDevice === hysenDevice) {
          this._disconnect();
        }
        throw error;
      }
    });
    this._requestQueue = result.catch(() => undefined);
    return result;
  }

  /**
   * Read the full status from the thermostat and sync capabilities and settings
   */
  private async _refreshStatus(): Promise<HysenClimateStatus> {
    const status: HysenClimateStatus = await this._run((hysenDevice) => hysenDevice.getFullStatus());

    await this._setCapabilities(status);

    const remoteLock = status.remoteLock === 1;
    if (status.remoteLock != null && this.getSetting("remove_lock") !== remoteLock) {
      await this.setSettings({ remove_lock: remoteLock });
    }

    return status;
  }

  private _startStatusTimer() {
    if (this._statusTimer) return;

    this._statusTimer = this.homey.setInterval(async () => {
      if (!this._hysenDevice) {
        await this._reconnect();
        return;
      }
      try {
        const status = await this._refreshStatus();
        this.log(" (timer) status =   ", status);
        if (!this.getAvailable()) {
          await this.setAvailable();
        }
      } catch (error) {
        this.error("Failed to get status", error);
        this._markOffline();
      }
    }, STATUS_POLL_INTERVAL);
  }

  private _stopStatusTimer() {
    if (this._statusTimer) {
      this.homey.clearInterval(this._statusTimer);
      this._statusTimer = null;
    }
  }

  private async _setCapabilities(status: HysenClimateStatus) {
    const updates: Promise<void>[] = [];

    if (this.hasCapability("measure_temperature") && status.roomTemp != null) {
      updates.push(this.setCapabilityValue("measure_temperature", status.roomTemp));
    }
    if (this.hasCapability("target_temperature") && status.thermostatTemp != null) {
      updates.push(this.setCapabilityValue("target_temperature", status.thermostatTemp));
    }
    if (this.hasCapability("onoff") && status.power != null) {
      updates.push(this.setCapabilityValue("onoff", status.power === 1));
    }
    if (this.hasCapability("thermostat_mode") && status.power != null) {
      updates.push(this.setCapabilityValue("thermostat_mode", statusToThermostatMode(status)));
    }

    await Promise.all(updates.map((update) => update.catch(this.error)));
  }

  private _setCapabilityListeners() {
    this.registerCapabilityListener("target_temperature", async (value: number) => {
      // The thermostat stores the temperature in 0.5 degree steps
      const temp = Math.round(value * 2) / 2;
      this.log(" SET (TRY) target_temperature =   ", temp);
      await this._run((hysenDevice) => hysenDevice.setTemp(temp));
      this.log(" SET (DONE) target_temperature =   ", temp);
    });

    this.registerCapabilityListener("onoff", async (value: boolean) => {
      this.log(" SET (TRY) onoff =   ", value);
      await this._run(async (hysenDevice) => {
        // setPower also writes the remote lock, so keep its current value
        const { remoteLock } = await hysenDevice.getFullStatus();
        await hysenDevice.setPower(value ? 1 : 0, remoteLock);
      });
      await this._refreshStatus();
      this.log(" SET (DONE) onoff =   ", value);
    });

    if (this.hasCapability("thermostat_mode")) {
      this.registerCapabilityListener("thermostat_mode", async (value: ThermostatMode) => {
        this.log(" SET (TRY) thermostat_mode =   ", value);
        await this._setThermostatMode(value);
        await this._refreshStatus();
        this.log(" SET (DONE) thermostat_mode =   ", value);
      });
    }
  }

  private async _setThermostatMode(mode: ThermostatMode) {
    if (mode === "cool") {
      throw new Error(this.homey.__("error.cool_not_supported"));
    }

    await this._run(async (hysenDevice) => {
      const status: HysenClimateStatus = await hysenDevice.getFullStatus();

      if (mode === "off") {
        await hysenDevice.setPower(0, status.remoteLock);
        return;
      }

      if (status.power !== 1) {
        await hysenDevice.setPower(1, status.remoteLock);
      }

      // Pass loopMode - 1 to keep the current loop mode, see setMode
      await hysenDevice.setMode(mode === "auto" ? 1 : 0, status.loopMode - 1, status.sensor);
    });
  }

}

module.exports = ThermostatDevice;
