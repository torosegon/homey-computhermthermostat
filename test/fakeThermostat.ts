import crypto from "crypto";
import dgram from "dgram";

/**
 * A fake Hysen thermostat on localhost, written from the protocol description
 * (python-broadlink device.py / climate.py) independently of lib/broadlink.ts,
 * so the tests check the client against the protocol, not against itself.
 */

const INITIAL_KEY = Buffer.from("097628343fe99e23765c1513accf8b02", "hex");
const IV = Buffer.from("562e17996d093d28ddb3ba695a2e6f58", "hex");

export function referenceChecksum(data: Buffer): number {
  return data.reduce((sum, byte) => sum + byte, 0xbeaf) & 0xffff;
}

/**
 * CRC-16/MODBUS, bit by bit (no table) to differ from the implementation
 */
export function referenceCrc16(data: Buffer): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc;
}

function aes(key: Buffer, data: Buffer, encrypt: boolean): Buffer {
  const cipher = encrypt
    ? crypto.createCipheriv("aes-128-cbc", key, IV)
    : crypto.createDecipheriv("aes-128-cbc", key, IV);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

export interface ReceivedPacket {
  raw: Buffer;
  checksumValid: boolean;
  payloadChecksumValid: boolean;
  deviceType: number;
  command: number;
  count: number;
  mac: Buffer;
  id: Buffer;
  payload: Buffer;
  remote: dgram.RemoteInfo;
}

export interface HysenRequest {
  lengthField: number;
  crcValid: boolean;
  request: Buffer;
}

export class FakeThermostat {

  readonly id = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  readonly sessionKey = crypto.randomBytes(16);
  readonly packets: ReceivedPacket[] = [];
  readonly requests: HysenRequest[] = [];

  /** Raw registers returned by "read 0x16 registers" (payload after the length field) */
  statusPayload: Buffer = Buffer.alloc(47);

  /** Override the response for the next request */
  respond: ((packet: ReceivedPacket) => Buffer | null) | null = null;

  private socket = dgram.createSocket("udp4");
  private authenticated = false;

  port = 0;

  async start(): Promise<void> {
    this.socket.on("message", (message, remote) => this.onMessage(message, remote));
    await new Promise<void>((resolve) => {
      this.socket.bind(0, "127.0.0.1", resolve);
    });
    this.port = this.socket.address().port;
  }

  stop() {
    this.socket.close();
  }

  private onMessage(message: Buffer, remote: dgram.RemoteInfo) {
    const header = Buffer.from(message.subarray(0, 0x38));
    const storedChecksum = message.readUInt16LE(0x20);
    const withoutChecksum = Buffer.from(message);
    withoutChecksum.writeUInt16LE(0, 0x20);

    const command = message.readUInt16LE(0x26);
    const key = command === 0x65 ? INITIAL_KEY : this.sessionKey;
    const payload = aes(key, message.subarray(0x38), false);

    const packet: ReceivedPacket = {
      raw: message,
      checksumValid: storedChecksum === referenceChecksum(withoutChecksum),
      payloadChecksumValid: header.readUInt16LE(0x34) === referenceChecksum(payload),
      deviceType: header.readUInt16LE(0x24),
      command,
      count: header.readUInt16LE(0x28),
      mac: Buffer.from(header.subarray(0x2a, 0x30)),
      id: Buffer.from(header.subarray(0x30, 0x34)),
      payload,
      remote,
    };
    this.packets.push(packet);

    const override = this.respond;
    if (override) {
      this.respond = null;
      const response = override(packet);
      if (response) this.socket.send(response, remote.port, remote.address);
      return;
    }
    this.respondTo(packet);
  }

  /** Answer a packet as a working thermostat would */
  respondTo(packet: ReceivedPacket) {
    const { command, payload, remote } = packet;
    let responsePayload: Buffer;
    if (command === 0x65) {
      responsePayload = Buffer.alloc(0x20);
      this.id.copy(responsePayload, 0x00);
      this.sessionKey.copy(responsePayload, 0x04);
      this.authenticated = true;
    } else if (command === 0x6a && this.authenticated) {
      responsePayload = this.handleRequest(payload);
    } else {
      this.socket.send(this.response(Buffer.alloc(16), INITIAL_KEY, 0xfff9), remote.port, remote.address);
      return;
    }
    const responseKey = command === 0x65 ? INITIAL_KEY : this.sessionKey;
    this.socket.send(this.response(responsePayload, responseKey), remote.port, remote.address);
  }

  private handleRequest(payload: Buffer): Buffer {
    const lengthField = payload.readUInt16LE(0);
    const request = Buffer.from(payload.subarray(2, lengthField));
    const crc = payload.readUInt16LE(lengthField);
    this.requests.push({ lengthField, crcValid: crc === referenceCrc16(request), request });

    // Modbus: 0x03 read registers, 0x06 write register (echoed back)
    const data = request[1] === 0x03
      ? Buffer.concat([Buffer.from([request[0], 0x03, this.statusPayload.length - 3]), this.statusPayload.subarray(3)])
      : request;
    return this.frame(data);
  }

  /** Hysen response framing: length, data, CRC */
  frame(data: Buffer, crc = referenceCrc16(data)): Buffer {
    const framed = Buffer.alloc(data.length + 4);
    framed.writeUInt16LE(data.length + 2, 0);
    data.copy(framed, 2);
    framed.writeUInt16LE(crc, data.length + 2);
    return framed;
  }

  /** Broadlink response packet */
  response(payload: Buffer, key = this.sessionKey, errorCode = 0): Buffer {
    const padded = Buffer.concat([payload, Buffer.alloc((16 - (payload.length % 16)) % 16)]);
    const header = Buffer.alloc(0x38);
    Buffer.from("5aa5aa555aa5aa55", "hex").copy(header);
    header.writeUInt16LE(errorCode, 0x22);
    const packet = Buffer.concat([header, aes(key, padded, true)]);
    packet.writeUInt16LE(referenceChecksum(packet), 0x20);
    return packet;
  }

}
