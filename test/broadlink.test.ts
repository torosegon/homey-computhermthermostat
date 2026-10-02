import assert from "assert/strict";
import dgram from "dgram";
import {
  after, before, beforeEach, describe, it,
} from "node:test";

import {
  checksum,
  COMMAND_AUTH,
  COMMAND_REQUEST,
  crc16,
  discover,
  discoveryPacket,
  formatMac,
  HYSEN_DEVICE_TYPE,
  HysenThermostat,
  parseDiscoveryResponse,
  parseMac,
  parseStatus,
} from "../lib/broadlink";
import { FakeThermostat, referenceChecksum, referenceCrc16 } from "./fakeThermostat";

const MAC = "e8:16:56:7f:83:21";
const TIMEOUT = 300;

describe("checksum", () => {
  it("starts from 0xbeaf", () => {
    assert.equal(checksum(Buffer.alloc(0)), 0xbeaf);
  });

  it("adds every byte and wraps at 16 bits", () => {
    assert.equal(checksum(Buffer.from([1, 2, 3])), 0xbeaf + 6);
    const data = Buffer.alloc(0x200, 0xff);
    assert.equal(checksum(data), (0xbeaf + 0x200 * 0xff) & 0xffff);
  });
});

describe("crc16", () => {
  it("matches the CRC-16/MODBUS check value", () => {
    assert.equal(crc16(Buffer.from("123456789", "ascii")), 0x4b37);
  });

  it("matches the reference implementation on random data", () => {
    for (let i = 0; i < 50; i++) {
      const data = Buffer.from(Array.from({ length: i + 1 }, () => Math.floor(Math.random() * 256)));
      assert.equal(crc16(data), referenceCrc16(data));
    }
  });
});

describe("MAC addresses", () => {
  it("formats bytes as lowercase colon separated hex", () => {
    assert.equal(formatMac([0xe8, 0x16, 0x56, 0x7f, 0x83, 0x21]), MAC);
    assert.equal(formatMac([0, 1, 2, 3, 4, 5]), "00:01:02:03:04:05");
  });

  it("parses back to the same bytes", () => {
    assert.deepEqual([...parseMac(MAC)], [0xe8, 0x16, 0x56, 0x7f, 0x83, 0x21]);
    assert.equal(formatMac(parseMac("E8:16:56:7F:83:21")), MAC);
  });
});

/**
 * Status payload as the thermostat sends it: [address, 0x03, byte count, registers...]
 */
function statusPayload(values: Record<number, number>): Buffer {
  const payload = Buffer.alloc(47);
  payload[0] = 0x01;
  payload[1] = 0x03;
  payload[2] = 44;
  for (const [index, value] of Object.entries(values)) payload[Number(index)] = value;
  return payload;
}

describe("parseStatus", () => {
  it("reads every field from its protocol position", () => {
    const status = parseStatus(statusPayload({
      3: 0b1, // remote lock
      4: 0b0101_0001, // tempManual (bit 6), active (bit 4), power (bit 0)
      5: 45, // room temp 22.5
      6: 43, // target 21.5
      7: 0x31, // loop mode 3, auto mode 1
      8: 2, // sensor
      9: 42, // osv
      10: 2, // dif
      11: 27, // svh
      12: 5, // svl
      13: 0x00,
      14: 0x03, // room temp adjust +1.5
      15: 1, // fre
      16: 1, // poweron
      17: 10, // unknown
      18: 40, // external temp 20
      19: 9, // hour
      20: 59, // min
      21: 54, // sec
      22: 5, // day of week
    }));

    assert.deepEqual(
      { ...status, weekDay: undefined, weekEnd: undefined },
      {
        remoteLock: 1,
        power: 1,
        active: 1,
        tempManual: 1,
        roomTemp: 22.5,
        thermostatTemp: 21.5,
        autoMode: 1,
        loopMode: 3,
        sensor: 2,
        osv: 42,
        dif: 2,
        svh: 27,
        svl: 5,
        roomTempAdj: 1.5,
        fre: 1,
        poweron: 1,
        unknown: 10,
        externalTemp: 20,
        hour: 9,
        min: 59,
        sec: 54,
        dayofweek: 5,
        weekDay: undefined,
        weekEnd: undefined,
      },
    );
  });

  it("reads power, lock and active as single bits", () => {
    const status = parseStatus(statusPayload({ 3: 0b1111_1110, 4: 0b1010_1110 }));
    assert.equal(status.remoteLock, 0);
    assert.equal(status.power, 0);
    assert.equal(status.active, 0);
    assert.equal(status.tempManual, 0);
  });

  it("reads a negative room temperature adjustment as signed", () => {
    assert.equal(parseStatus(statusPayload({ 13: 0xff, 14: 0xfe })).roomTempAdj, -1);
    assert.equal(parseStatus(statusPayload({ 13: 0xff, 14: 0xf6 })).roomTempAdj, -5);
  });

  it("reads the schedule: 6 weekday and 2 weekend periods", () => {
    const values: Record<number, number> = {};
    for (let i = 0; i < 8; i++) {
      values[2 * i + 23] = i + 6; // start hour
      values[2 * i + 24] = i * 5; // start minute
      values[i + 39] = 30 + i; // temp 15 + i/2
    }
    const status = parseStatus(statusPayload(values));

    assert.equal(status.weekDay.length, 6);
    assert.equal(status.weekEnd.length, 2);
    assert.deepEqual(status.weekDay[0], { startHour: 6, startMinute: 0, temp: 15 });
    assert.deepEqual(status.weekDay[5], { startHour: 11, startMinute: 25, temp: 17.5 });
    assert.deepEqual(status.weekEnd[1], { startHour: 13, startMinute: 35, temp: 18.5 });
  });
});

describe("HysenThermostat against a fake thermostat", () => {
  let fake: FakeThermostat;
  let client: HysenThermostat;

  before(async () => {
    fake = new FakeThermostat();
    await fake.start();
  });

  after(() => fake.stop());

  beforeEach(() => {
    fake.packets.length = 0;
    fake.requests.length = 0;
    fake.respond = null;
    client?.close();
    client = new HysenThermostat("127.0.0.1", MAC, TIMEOUT, fake.port);
  });

  after(() => client?.close());

  describe("packet format", () => {
    it("sends a valid auth packet", async () => {
      await client.auth();
      const [packet] = fake.packets;

      assert.equal(packet.raw.subarray(0, 8).toString("hex"), "5aa5aa555aa5aa55");
      assert.ok(packet.checksumValid, "packet checksum at 0x20");
      assert.ok(packet.payloadChecksumValid, "payload checksum at 0x34");
      assert.equal(packet.deviceType, HYSEN_DEVICE_TYPE);
      assert.equal(packet.command, COMMAND_AUTH);
      assert.equal(packet.mac.toString("hex"), "21837f5616e8", "MAC is reversed");
      assert.equal(packet.id.toString("hex"), "00000000", "no device id before auth");
      assert.equal((packet.raw.length - 0x38) % 16, 0, "encrypted payload is padded to 16 bytes");
    });

    it("sends the auth payload from the protocol", async () => {
      await client.auth();
      const { payload } = fake.packets[0];

      assert.equal(payload.length, 0x50);
      assert.ok(payload.subarray(0x04, 0x14).equals(Buffer.alloc(16, 0x31)));
      assert.equal(payload[0x1e], 0x01);
      assert.equal(payload[0x2d], 0x01);
      assert.equal(payload.subarray(0x30, 0x36).toString("ascii"), "Test 1");
    });

    it("uses the device id and session key from auth for requests", async () => {
      await client.auth();
      await client.getFullStatus(); // the fake decrypts with its session key
      const request = fake.packets[1];

      assert.equal(request.command, COMMAND_REQUEST);
      assert.ok(request.id.equals(fake.id));
      assert.ok(request.checksumValid);
      assert.ok(request.payloadChecksumValid);
    });

    it("increments the packet counter by one", async () => {
      await client.auth();
      await client.getFullStatus();
      await client.getFullStatus();
      const counts = fake.packets.map((packet) => packet.count);

      assert.equal(counts[1], (counts[0] + 1) & 0xffff);
      assert.equal(counts[2], (counts[1] + 1) & 0xffff);
    });
  });

  describe("requests", () => {
    beforeEach(() => client.auth());

    it("frames requests with length and CRC", async () => {
      await client.getFullStatus();
      const [request] = fake.requests;

      assert.equal(request.lengthField, request.request.length + 2);
      assert.ok(request.crcValid);
    });

    it("reads the full status with read registers 0x0000, count 0x16", async () => {
      fake.statusPayload = statusPayload({
        4: 1, 5: 45, 6: 44, 7: 0x30,
      });
      const status = await client.getFullStatus();

      assert.equal(fake.requests[0].request.toString("hex"), "010300000016");
      assert.equal(status.power, 1);
      assert.equal(status.roomTemp, 22.5);
      assert.equal(status.thermostatTemp, 22);
      assert.equal(status.loopMode, 3);
    });

    it("sets power and remote lock with register 0x0000", async () => {
      await client.setPower(1, 0);
      await client.setPower(0, 1);

      assert.equal(fake.requests[0].request.toString("hex"), "010600000001");
      assert.equal(fake.requests[1].request.toString("hex"), "010600000100");
    });

    it("sets the target temperature in 0.5 degree steps with register 0x0001", async () => {
      await client.setTemp(22);
      await client.setTemp(21.5);
      await client.setTemp(21.3); // rounds to 21.5
      await client.setTemp(21.2); // rounds to 21

      assert.deepEqual(
        fake.requests.map((request) => request.request.toString("hex")),
        ["01060001002c", "01060001002b", "01060001002b", "01060001002a"],
      );
    });

    it("rejects a target temperature that does not fit in a byte", async () => {
      await assert.rejects(client.setTemp(128), RangeError);
      await assert.rejects(client.setTemp(-1), RangeError);
      await assert.rejects(client.setTemp(NaN), RangeError);
      assert.equal(fake.requests.length, 0);
    });

    it("sets the mode as ((loopMode + 1) << 4) + autoMode with register 0x0002", async () => {
      await client.setMode(1, 2, 0); // auto, keep loop mode 3
      await client.setMode(0, 0, 1); // manual, loop mode 1, external sensor

      assert.equal(fake.requests[0].request.toString("hex"), "010600023100");
      assert.equal(fake.requests[1].request.toString("hex"), "010600021001");
    });

    it("keeps the loop mode read from the status when passing loopMode - 1", async () => {
      fake.statusPayload = statusPayload({ 7: 0x30 });
      const { loopMode, sensor } = await client.getFullStatus();
      await client.setMode(1, loopMode - 1, sensor);

      assert.equal(fake.requests[1].request[4] >> 4, loopMode);
    });
  });

  describe("errors", () => {
    beforeEach(() => client.auth());

    it("rejects a device error code", async () => {
      fake.respond = () => fake.response(Buffer.alloc(16), undefined, 0xfffb);
      await assert.rejects(client.getFullStatus(), /Device error 65531/);
    });

    it("rejects a response with a wrong CRC", async () => {
      fake.respond = () => fake.response(fake.frame(Buffer.from([1, 3, 0]), 0x1234));
      await assert.rejects(client.getFullStatus(), /CRC/);
    });

    it("rejects a response with a wrong length", async () => {
      const framed = fake.frame(Buffer.from([1, 3, 0]));
      framed.writeUInt16LE(200, 0);
      fake.respond = () => fake.response(framed);
      await assert.rejects(client.getFullStatus(), /length/);
    });

    it("times out when the thermostat does not answer", async () => {
      fake.respond = () => null;
      const start = Date.now();
      await assert.rejects(client.getFullStatus(), /timed out/);
      assert.ok(Date.now() - start >= TIMEOUT - 20);
    });

    it("works again after a timeout", async () => {
      fake.respond = () => null;
      await assert.rejects(client.getFullStatus(), /timed out/);
      await client.getFullStatus();
    });

    it("rejects a second request while one is in progress", async () => {
      const first = client.getFullStatus();
      await assert.rejects(client.getFullStatus(), /in progress/);
      await first;
    });

    it("ignores packets from other addresses", async () => {
      const intruder = dgram.createSocket("udp4");
      await new Promise<void>((resolve) => {
        intruder.bind(0, "127.0.0.2", resolve);
      });
      const clientPort = (client as unknown as { socket: dgram.Socket }).socket.address().port;

      fake.respond = (packet) => {
        // Another device answers first, then the real response arrives
        intruder.send(fake.response(Buffer.alloc(16), undefined, 0xffff), clientPort, "127.0.0.1");
        setTimeout(() => fake.respondTo(packet), 50);
        return null;
      };
      await client.getFullStatus();
      intruder.close();
    });

    it("can be closed more than once", () => {
      client.close();
      client.close();
    });

    it("rejects requests after close instead of hanging", async () => {
      client.close();
      await assert.rejects(client.getFullStatus(), /closed/);
    });

    it("rejects a request in progress immediately on close", async () => {
      fake.respond = () => null;
      const start = Date.now();
      const request = client.getFullStatus();
      client.close();
      await assert.rejects(request, /closed/);
      assert.ok(Date.now() - start < TIMEOUT / 2, "does not wait for the timeout");
    });
  });
});

describe("discovery", () => {
  it("builds the hello packet from the protocol", () => {
    const now = new Date(2026, 9, 2, 14, 5); // Friday, 2 October 2026 14:05 local time
    const packet = discoveryPacket("192.168.1.10", 0x1234, now);

    assert.equal(packet.length, 0x30);
    assert.equal(packet.readInt32LE(0x08), -now.getTimezoneOffset() / 60, "UTC offset in hours");
    assert.equal(packet.readUInt16LE(0x0c), 2026);
    assert.equal(packet[0x0e], 5, "minute");
    assert.equal(packet[0x0f], 14, "hour");
    assert.equal(packet[0x10], 26, "two digit year");
    assert.equal(packet[0x11], 5, "ISO weekday");
    assert.equal(packet[0x12], 2, "day of month");
    assert.equal(packet[0x13], 10, "month");
    assert.deepEqual([...packet.subarray(0x18, 0x1c)], [192, 168, 1, 10]);
    assert.equal(packet.readUInt16LE(0x1c), 0x1234);
    assert.equal(packet[0x26], 6);

    const withoutChecksum = Buffer.from(packet);
    withoutChecksum.writeUInt16LE(0, 0x20);
    assert.equal(packet.readUInt16LE(0x20), referenceChecksum(withoutChecksum));
  });

  it("uses 7 for Sunday", () => {
    assert.equal(discoveryPacket("10.0.0.1", 1, new Date(2026, 9, 4))[0x11], 7);
  });

  it("parses a discovery response", () => {
    const message = Buffer.alloc(0x80);
    message.writeUInt16LE(HYSEN_DEVICE_TYPE, 0x34);
    Buffer.from([0x21, 0x83, 0x7f, 0x56, 0x16, 0xe8]).copy(message, 0x3a); // reversed MAC
    message.write("HVAC-HV2", 0x40, "utf8");

    assert.deepEqual(parseDiscoveryResponse(message, "192.168.1.89"), {
      deviceType: HYSEN_DEVICE_TYPE,
      name: "HVAC-HV2",
      mac: MAC,
      address: "192.168.1.89",
    });
  });

  it("ignores short packets", () => {
    assert.equal(parseDiscoveryResponse(Buffer.alloc(0x40), "192.168.1.89"), null);
  });

  it("finds a device that answers the broadcast", async () => {
    const device = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => {
      device.bind(0, "127.0.0.1", resolve);
    });
    const hellos: Buffer[] = [];
    device.on("message", (message, remote) => {
      hellos.push(message);
      const response = Buffer.alloc(0x80);
      response.writeUInt16LE(HYSEN_DEVICE_TYPE, 0x34);
      Buffer.from([0x21, 0x83, 0x7f, 0x56, 0x16, 0xe8]).copy(response, 0x3a);
      response.write("HVAC-HV2", 0x40, "utf8");
      device.send(response, remote.port, remote.address);
    });

    const found = await discover(200, [{ address: "127.0.0.1", broadcast: "127.0.0.1" }], device.address().port);
    device.close();

    assert.equal(hellos.length, 1);
    assert.equal(hellos[0][0x26], 6);
    assert.deepEqual(found, [{
      deviceType: HYSEN_DEVICE_TYPE, name: "HVAC-HV2", mac: MAC, address: "127.0.0.1",
    }]);
  });
});
