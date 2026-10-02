import crypto from "crypto";
import dgram from "dgram";
import os from "os";

/**
 * Minimal Broadlink client for Hysen based thermostats (HY02/HY03, Computherm E series).
 *
 * Only what this app needs, implemented with Node built-ins. Protocol reference:
 * https://github.com/mjg59/python-broadlink (device.py, climate.py)
 */

// 0x4ead: [Hysen, 'HY02/HY03', 'Hysen']
export const HYSEN_DEVICE_TYPE = 0x4ead;

export const PORT = 80;
export const INITIAL_KEY = Buffer.from("097628343fe99e23765c1513accf8b02", "hex");
export const IV = Buffer.from("562e17996d093d28ddb3ba695a2e6f58", "hex");
const PACKET_MAGIC = Buffer.from("5aa5aa555aa5aa55", "hex");

export const COMMAND_AUTH = 0x65;
export const COMMAND_REQUEST = 0x6a;

interface DayModel {
  startHour: number;
  startMinute: number;
  temp: number;
}

export interface HysenClimateStatus {
  remoteLock: number;
  power: number;
  active: number;
  tempManual: number;
  roomTemp: number;
  thermostatTemp: number;
  autoMode: number;
  loopMode: number;
  sensor: number;
  osv: number;
  dif: number;
  svh: number;
  svl: number;
  roomTempAdj: number;
  fre: number;
  poweron: number;
  unknown: number;
  externalTemp: number;
  hour: number;
  min: number;
  sec: number;
  dayofweek: number;
  weekDay: DayModel[];
  weekEnd: DayModel[];
}

export interface DiscoveredDevice {
  deviceType: number;
  name: string;
  mac: string;
  address: string;
}

export function checksum(data: Buffer): number {
  let sum = 0xbeaf;
  for (const byte of data) sum += byte;
  return sum & 0xffff;
}

const CRC16_TABLE = Array.from({ length: 256 }, (_, i) => {
  let crc = i;
  for (let bit = 0; bit < 8; bit++) {
    crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return crc;
});

/**
 * CRC-16/MODBUS
 */
export function crc16(data: Buffer): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc = (crc >> 8) ^ CRC16_TABLE[(crc ^ byte) & 0xff];
  }
  return crc;
}

export function formatMac(mac: Buffer | number[]): string {
  return [...mac].map((part) => part.toString(16).padStart(2, "0")).join(":");
}

export function parseMac(mac: string): Buffer {
  return Buffer.from(mac.split(":").map((part) => parseInt(part, 16)));
}

/**
 * Parse the response of the "read 0x16 registers" request
 */
export function parseStatus(payload: Buffer): HysenClimateStatus {
  const week = Array.from({ length: 8 }, (_, i) => ({
    startHour: payload[2 * i + 23],
    startMinute: payload[2 * i + 24],
    temp: payload[i + 39] / 2,
  }));

  return {
    remoteLock: payload[3] & 1,
    power: payload[4] & 1,
    active: (payload[4] >> 4) & 1,
    tempManual: (payload[4] >> 6) & 1,
    roomTemp: payload[5] / 2,
    thermostatTemp: payload[6] / 2,
    autoMode: payload[7] & 15,
    loopMode: (payload[7] >> 4) & 15,
    sensor: payload[8],
    osv: payload[9],
    dif: payload[10],
    svh: payload[11],
    svl: payload[12],
    // Signed, in 0.5 degree steps
    roomTempAdj: payload.readInt16BE(13) / 2,
    fre: payload[15],
    poweron: payload[16],
    unknown: payload[17],
    externalTemp: payload[18] / 2,
    hour: payload[19],
    min: payload[20],
    sec: payload[21],
    dayofweek: payload[22],
    weekDay: week.slice(0, 6),
    weekEnd: week.slice(6),
  };
}

export class HysenThermostat {

  readonly address: string;

  private readonly mac: Buffer;
  private readonly timeout: number;
  private readonly port: number;
  private readonly socket: dgram.Socket;
  private key: Buffer = INITIAL_KEY;
  private id: Buffer = Buffer.alloc(4);
  private count = crypto.randomInt(0x10000);
  private pending: { receive: (message: Buffer) => void; fail: (error: Error) => void } | null = null;
  private closed = false;

  constructor(address: string, mac: string, timeout: number, port = PORT) {
    this.address = address;
    this.mac = parseMac(mac);
    this.timeout = timeout;
    this.port = port;
    this.socket = dgram.createSocket("udp4");
    this.socket.on("message", (message, remote) => {
      if (remote.address === this.address && this.pending) {
        this.pending.receive(message);
      }
    });
    // A socket error would otherwise crash the app
    this.socket.on("error", (error) => {
      this.pending?.fail(error);
      this.close();
    });
  }

  /**
   * Close the socket, a request in progress is rejected
   */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.pending?.fail(new Error("Connection closed"));
    this.socket.close();
  }

  async auth() {
    const payload = Buffer.alloc(0x50);
    payload.fill(0x31, 0x04, 0x14);
    payload[0x1e] = 0x01;
    payload[0x2d] = 0x01;
    payload.write("Test 1", 0x30, "ascii");

    const response = this.decrypt(await this.sendPacket(COMMAND_AUTH, payload));
    this.id = response.subarray(0x00, 0x04);
    this.key = response.subarray(0x04, 0x14);
  }

  async getFullStatus(): Promise<HysenClimateStatus> {
    const payload = await this.sendRequest([0x01, 0x03, 0x00, 0x00, 0x00, 0x16]);
    return parseStatus(payload);
  }

  async setPower(power: number, remoteLock: number) {
    await this.sendRequest([0x01, 0x06, 0x00, 0x00, remoteLock, power]);
  }

  /**
   * The thermostat stores the target temperature in 0.5 degree steps
   */
  async setTemp(temp: number) {
    const value = Math.round(temp * 2);
    if (!(value >= 0 && value <= 0xff)) {
      throw new RangeError(`Temperature out of range: ${temp}`);
    }
    await this.sendRequest([0x01, 0x06, 0x00, 0x01, 0x00, value]);
  }

  /**
   * setMode writes (loopMode + 1) into the nibble getFullStatus reads loopMode
   * from, so pass loopMode - 1 to keep the current loop mode.
   */
  async setMode(autoMode: number, loopMode: number, sensor: number) {
    await this.sendRequest([0x01, 0x06, 0x00, 0x02, ((loopMode + 1) << 4) + autoMode, sensor]);
  }

  private async sendRequest(request: number[]): Promise<Buffer> {
    const data = Buffer.from(request);
    const packet = Buffer.alloc(data.length + 4);
    packet.writeUInt16LE(data.length + 2, 0);
    data.copy(packet, 2);
    packet.writeUInt16LE(crc16(data), data.length + 2);

    const response = this.decrypt(await this.sendPacket(COMMAND_REQUEST, packet));
    const length = response.readUInt16LE(0);
    if (length + 2 > response.length) {
      throw new Error("Invalid response length");
    }
    if (response.readUInt16LE(length) !== crc16(response.subarray(2, length))) {
      throw new Error("Invalid response CRC");
    }
    return response.subarray(2, length);
  }

  private sendPacket(command: number, data: Buffer): Promise<Buffer> {
    if (this.closed) {
      return Promise.reject(new Error("Connection closed"));
    }
    if (this.pending) {
      return Promise.reject(new Error("Another request is in progress"));
    }

    this.count = (this.count + 1) & 0xffff;
    const payload = Buffer.concat([data, Buffer.alloc((16 - (data.length % 16)) % 16)]);

    const header = Buffer.alloc(0x38);
    PACKET_MAGIC.copy(header, 0x00);
    header.writeUInt16LE(HYSEN_DEVICE_TYPE, 0x24);
    header.writeUInt16LE(command, 0x26);
    header.writeUInt16LE(this.count, 0x28);
    Buffer.from(this.mac).reverse().copy(header, 0x2a);
    this.id.copy(header, 0x30);
    header.writeUInt16LE(checksum(payload), 0x34);

    const packet = Buffer.concat([header, this.encrypt(payload)]);
    packet.writeUInt16LE(checksum(packet), 0x20);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`Request timed out after ${this.timeout} ms`));
      }, this.timeout);
      const finish = () => {
        clearTimeout(timer);
        this.pending = null;
      };

      this.pending = {
        receive: (response) => {
          finish();
          const errorCode = response.length >= 0x38 ? response.readUInt16LE(0x22) : -1;
          if (errorCode === 0) {
            resolve(response);
          } else {
            reject(new Error(`Device error ${errorCode}`));
          }
        },
        fail: (error) => {
          finish();
          reject(error);
        },
      };

      this.socket.send(packet, this.port, this.address, (error) => {
        if (error) this.pending?.fail(error);
      });
    });
  }

  private encrypt(payload: Buffer): Buffer {
    const cipher = crypto.createCipheriv("aes-128-cbc", this.key, IV).setAutoPadding(false);
    return Buffer.concat([cipher.update(payload), cipher.final()]);
  }

  private decrypt(response: Buffer): Buffer {
    const decipher = crypto.createDecipheriv("aes-128-cbc", this.key, IV).setAutoPadding(false);
    return Buffer.concat([decipher.update(response.subarray(0x38)), decipher.final()]);
  }

}

function broadcastTargets(): { address: string; broadcast: string }[] {
  const targets: { address: string; broadcast: string }[] = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const info of addresses ?? []) {
      if (info.family === "IPv4" && !info.internal) {
        const ip = info.address.split(".").map(Number);
        const mask = info.netmask.split(".").map(Number);
        const broadcast = ip.map((part, i) => (part | (~mask[i] & 0xff))).join(".");
        targets.push({ address: info.address, broadcast });
      }
    }
  }
  return targets;
}

/**
 * Discovery ("hello") packet, see python-broadlink hello()
 */
export function discoveryPacket(localAddress: string, localPort: number, now = new Date()): Buffer {
  const packet = Buffer.alloc(0x30);
  packet.writeInt32LE(Math.trunc(-now.getTimezoneOffset() / 60), 0x08);
  packet.writeUInt16LE(now.getFullYear(), 0x0c);
  packet[0x0e] = now.getMinutes();
  packet[0x0f] = now.getHours();
  packet[0x10] = now.getFullYear() % 100;
  packet[0x11] = now.getDay() || 7; // ISO weekday, Monday = 1
  packet[0x12] = now.getDate();
  packet[0x13] = now.getMonth() + 1;
  localAddress.split(".").forEach((part, i) => {
    packet[0x18 + i] = Number(part);
  });
  packet.writeUInt16LE(localPort, 0x1c);
  packet[0x26] = 6;
  packet.writeUInt16LE(checksum(packet), 0x20);
  return packet;
}

/**
 * Parse a discovery response, null if it is not a Broadlink device response
 */
export function parseDiscoveryResponse(message: Buffer, address: string): DiscoveredDevice | null {
  if (message.length < 0x80) return null;
  const nameBytes = message.subarray(0x40, 0x7e);
  const nameEnd = nameBytes.indexOf(0);
  return {
    deviceType: message.readUInt16LE(0x34),
    name: nameBytes.subarray(0, nameEnd < 0 ? undefined : nameEnd).toString("utf8"),
    mac: formatMac(Buffer.from(message.subarray(0x3a, 0x40)).reverse()),
    address,
  };
}

/**
 * Find Broadlink devices on the local network with a broadcast
 */
export function discover(
  timeout: number,
  targets = broadcastTargets(),
  port = PORT,
): Promise<DiscoveredDevice[]> {
  const found = new Map<string, DiscoveredDevice>();

  const sockets = targets.map(({ address, broadcast }) => {
    const socket = dgram.createSocket("udp4");
    socket.on("error", () => socket.close());
    socket.on("message", (message, remote) => {
      const device = parseDiscoveryResponse(message, remote.address);
      if (device) found.set(device.mac, device);
    });
    socket.bind({ address }, () => {
      socket.setBroadcast(true);
      socket.send(discoveryPacket(address, socket.address().port), port, broadcast);
    });
    return socket;
  });

  return new Promise((resolve) => {
    setTimeout(() => {
      for (const socket of sockets) {
        try {
          socket.close();
        } catch (error) {
          // Already closed after an error
        }
      }
      resolve([...found.values()]);
    }, timeout);
  });
}
