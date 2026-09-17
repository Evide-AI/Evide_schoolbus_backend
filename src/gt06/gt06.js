import getCrc16 from "./crc16.js";

const MIN_PACKET_LEN = 10;
const START_BIT = 0x7878;
const END_BIT = 0x0d0a;

class Gt06 {
  constructor() {
    this.msgBufferRaw = Buffer.alloc(0);
    this.msgBuffer = [];
    this.imei = null;
  }

  parse(data) {
    if (this.msgBufferRaw.length === 0) {
      this.msgBufferRaw = data;
    } else {
      this.msgBufferRaw = Buffer.concat([this.msgBufferRaw, data]);
    }

    const parsedMessages = [];
    let position = 0;
    const bufferLength = this.msgBufferRaw.length;

    while (position <= bufferLength - MIN_PACKET_LEN) {
      const startBitPos = this.findStartBit(position);
      if (startBitPos === -1) {
        // No start bit anywhere in the remaining buffer — nothing usable left.
        position = bufferLength;
        break;
      }

      const packetResult = this.verifyAndExtractPacket(startBitPos);

      if (packetResult.status === 'complete') {
        const parsed = this.parsePacket(packetResult.data);
        if (parsed) {
          parsedMessages.push(parsed);
        }
        position = packetResult.nextPosition;
      } else if (packetResult.status === 'incomplete') {
        // Packet has started but hasn't fully arrived yet (split across TCP
        // reads). Stop scanning here and keep everything from the start bit
        // onward for the next chunk — do NOT advance past it, or the start
        // marker gets sliced off and the packet can never reassemble.
        // (This was the bug: the old code advanced position by 1 here, same
        // as the "corrupt packet" case below, silently dropping a byte.)
        position = startBitPos;
        break;
      } else {
        // Genuinely invalid (bad end bit / CRC mismatch) — skip past this
        // start bit and keep scanning for the next real one.
        position = startBitPos + 1;
      }
    }

    // Keep unprocessed data (from `position` onward) for the next call.
    if (position > 0) {
      this.msgBufferRaw = this.msgBufferRaw.slice(position);
    }

    // Add to message buffer
    if (parsedMessages.length > 0) {
      this.msgBuffer.push(...parsedMessages);
    }

    return parsedMessages;
  }

  findStartBit(startPos) {
    const buffer = this.msgBufferRaw;
    const bufferLength = buffer.length;

    for (let i = startPos; i <= bufferLength - 2; i++) {
      if (buffer.readUInt16BE(i) === START_BIT) {
        return i;
      }
    }
    return -1;
  }

  verifyAndExtractPacket(startPos) {
    const buffer = this.msgBufferRaw;
    const bufferLength = buffer.length;

    // Check minimum data for length byte
    if (startPos + 3 > bufferLength) {
      return { status: 'incomplete' };
    }

    const length = buffer.readUInt8(startPos + 2);
    const totalPacketLength = length + 5;

    // Check for complete packet
    if (startPos + totalPacketLength > bufferLength) {
      return { status: 'incomplete' };
    }

    // Extract packet data
    const packetData = buffer.slice(startPos, startPos + totalPacketLength);

    // Verify end bit
    if (packetData.readUInt16BE(packetData.length - 2) !== END_BIT) {
      return { status: 'invalid' };
    }

    // Verify CRC
    if (!validateCrc(packetData)) {
      console.warn("CRC mismatch, skipping packet", packetData.toString("hex"));
      return { status: 'invalid' };
    }

    return {
      status: 'complete',
      data: packetData,
      nextPosition: startPos + totalPacketLength,
    };
  }

  parsePacket(msg) {
    const event = selectEvent(msg);
    const parsed = {
      expectsResponse: false,
      parseTime: Date.now(),
      event: event,
    };

    try {
      switch (event.number) {
        case 0x01: // login message
          const loginData = parseLogin(msg);
          if (!loginData) {
            console.warn("Invalid login message received.");
            return null;
          }
          Object.assign(parsed, loginData);
          this.imei = parsed.imei;
          parsed.expectsResponse = true;
          parsed.responseMsg = createResponse(msg);
          break;
        case 0x12: // location message
        case 0x22: // extended location message - treat as location
          const locationData = parseLocation(msg);
          if (!locationData) {
            console.warn("Invalid location message received.");
            return null;
          }
          Object.assign(parsed, locationData, { imei: this.imei });
          break;
        case 0x13: // status message
          Object.assign(parsed, parseStatus(msg), { imei: this.imei });
          parsed.expectsResponse = true;
          parsed.responseMsg = createResponse(msg);
          break;
        case 0x16: // alarm message
          Object.assign(parsed, parseAlarm(msg), { imei: this.imei });
          break;
        default:
          console.warn("unknown message type, skipping", event);
          return null;
      }

      // Update instance state
      Object.assign(this, parsed);
      return parsed;
    } catch (error) {
      console.error("Error parsing packet:", error);
      return null;
    }
  }

  clearMsgBuffer() {
    this.msgBuffer.length = 0;
  }
}

function selectEvent(data) {
  const eventMap = {
    0x01: "login",
    0x12: "location",
    0x13: "status",
    0x16: "alarm",
    0x22: "location", // Treat 0x22 as location packet
  };

  const eventNumber = data[3];
  return {
    number: eventNumber,
    string: eventMap[eventNumber] || "unknown",
  };
}

function parseLogin(data) {
  // Accept multiple login packet lengths
  const validLoginLengths = [0x0d, 0x11]; // Standard (13) and Extended (17)
  const packetLength = data[2];

  if (!validLoginLengths.includes(packetLength)) {
    return null;
  }

  // Extract IMEI from bytes 4-11 (8 bytes) - THIS IS ALWAYS THE SAME POSITION
  const imeiBytes = data.slice(4, 12);

  // Convert to 15-digit IMEI string
  let imei = "";
  for (let i = 0; i < 8; i++) {
    // Each byte represents 2 BCD digits
    const byte = imeiBytes[i];
    imei += Math.floor(byte / 16).toString(); // First digit
    imei += (byte % 16).toString(); // Second digit
  }

  // Handle cases where BCD encoding might add leading 0
  // Remove leading 0 if it exists, then ensure we have exactly 15 digits
  if (imei.length === 16 && imei[0] === "0") {
    imei = imei.substring(1); // Remove leading 0 padding
  } else {
    imei = imei.substring(0, 15); // Take first 15 if no leading 0
  }

  // Extract serial number - position depends on packet length
  let serialNumber;
  if (packetLength === 0x0d) {
    // Standard packet: serial number at position 12-13
    serialNumber = data.readUInt16BE(12);
  } else if (packetLength === 0x11) {
    // Extended packet: skip 4 extra bytes, serial number at position 16-17
    serialNumber = data.readUInt16BE(16);

    // Log the extended data for analysis (but we don't need to parse it)
    const extendedData = data.slice(12, 16);
  }

  return {
    imei: imei,
    serialNumber: serialNumber,
    packetLength: packetLength,
  };
}

function parseStatus(data) {
  const statusInfo = data.slice(4, 9);
  const terminalInfo = statusInfo.readUInt8(0);
  const voltageLevel = statusInfo.readUInt8(1);
  const gsmSigStrength = statusInfo.readUInt8(2);

  const alarm = (terminalInfo & 0x38) >> 3;
  const alarmMap = {
    1: "shock",
    2: "power cut",
    3: "low battery",
    4: "sos",
  };

  const termObj = {
    status: !!(terminalInfo & 0x01),
    ignition: !!(terminalInfo & 0x02),
    charging: !!(terminalInfo & 0x04),
    alarmType: alarmMap[alarm] || "normal",
    gpsTracking: !!(terminalInfo & 0x40),
    relayState: !!(terminalInfo & 0x80),
  };

  const voltageMap = {
    1: "extremely low battery",
    2: "very low battery (low battery alarm)",
    3: "low battery (can be used normally)",
    4: "medium",
    5: "high",
    6: "very high",
  };

  const gsmMap = {
    1: "extremely weak signal",
    2: "very weak signal",
    3: "good signal",
    4: "strong signal",
  };

  const parsed = {
    terminalInfo: termObj,
    voltageLevel: voltageMap[voltageLevel] || "no power (shutting down)",
    gsmSigStrength: gsmMap[gsmSigStrength] || "no signal",
  };

  return parsed;
}

function parseLocation(data) {
  const protocolNumber = data[3];

  // Handle different packet structures based on protocol number
  if (protocolNumber === 0x22) {
    return parseExtendedLocation(data);
  } else {
    return parseStandardLocation(data);
  }
}

function parseStandardLocation(data) {
  // Validate minimum length for location packet
  if (data.length < 35) {
    // Minimum location packet size
    return null;
  }

  // Parse according to documentation (Page 13-15)
  const datasheet = {
    startBit: data.readUInt16BE(0),
    protocolLength: data.readUInt8(2),
    protocolNumber: data.readUInt8(3),
    dateTime: data.slice(4, 10),
    quantity: data.readUInt8(10),
    lat: data.readUInt32BE(11),
    lon: data.readUInt32BE(15),
    speed: data.readUInt8(19),
    course: data.readUInt16BE(20),
    mcc: data.readUInt16BE(22),
    mnc: data.readUInt8(24),
    lac: data.readUInt16BE(25),
    cellId: data.readUIntBE(27, 3), // 3 bytes for Cell ID
    serialNr: data.readUInt16BE(30),
    errorCheck: data.readUInt16BE(32),
  };

  // Extract satellite information
  const satCnt = (datasheet.quantity & 0xf0) >> 4; // Upper 4 bits = total satellites
  const satCntActive = datasheet.quantity & 0x0f; // Lower 4 bits = active satellites

  // Extract course status flags
  const courseValue = datasheet.course;
  const realTimeGps = !!(courseValue & 0x2000);
  const gpsPositioned = !!(courseValue & 0x1000);
  const eastLongitude = !(courseValue & 0x0800);
  const northLatitude = !!(courseValue & 0x0400);
  const actualCourse = courseValue & 0x03ff; // Lower 10 bits for course

  // Parse date time
  const dt = datasheet.dateTime;
  // GPS device sends UTC time
  const fixTime = new Date(
    Date.UTC(dt[0] + 2000, dt[1] - 1, dt[2], dt[3], dt[4], dt[5])
  );

  // Decode latitude and longitude
  const lat = decodeGt06Lat(datasheet.lat, datasheet.course);
  const lon = decodeGt06Lon(datasheet.lon, datasheet.course);

  const parsed = {
    fixTime: fixTime.toISOString(),
    fixTimestamp: Math.floor(fixTime.getTime() / 1000),
    satCnt: satCnt,
    satCntActive: satCntActive,
    lat: lat,
    lon: lon,
    speed: datasheet.speed,
    speedUnit: "km/h",
    realTimeGps: realTimeGps,
    gpsPositioned: gpsPositioned,
    eastLongitude: eastLongitude,
    northLatitude: northLatitude,
    course: actualCourse,
    mcc: datasheet.mcc,
    mnc: datasheet.mnc,
    lac: datasheet.lac,
    cellId: datasheet.cellId,
    serialNr: datasheet.serialNr,
  };

  return parsed;
}

function parseExtendedLocation(data) {
  // Parse 0x22 protocol extended location packets

  if (data.length < 25) {
    return null;
  }

  try {
    const datasheet = {
      startBit: data.readUInt16BE(0),
      protocolLength: data.readUInt8(2),
      protocolNumber: data.readUInt8(3),
      dateTime: data.slice(4, 10),
    };

    // Parse date time
    const dt = datasheet.dateTime;
    // GPS device sends UTC time
    const fixTime = new Date(
      Date.UTC(dt[0] + 2000, dt[1] - 1, dt[2], dt[3], dt[4], dt[5])
    );

    // Extract location data - positions may vary in extended packets
    let lat, lon, speed, course;

    // Try to find location data in common positions
    if (data.length >= 35) {
      // Similar structure to standard location packets
      lat = data.readUInt32BE(11);
      lon = data.readUInt32BE(15);
      speed = data.readUInt8(19);
      course = data.readUInt16BE(20);
    } else if (data.length >= 25) {
      // Alternative structure for shorter packets
      lat = data.readUInt32BE(10);
      lon = data.readUInt32BE(14);
      speed = data.readUInt8(18);
      course = data.readUInt16BE(19);
    } else {
      return null;
    }

    // Extract course status flags
    const realTimeGps = !!(course & 0x2000);
    const gpsPositioned = !!(course & 0x1000);
    const eastLongitude = !(course & 0x0800);
    const northLatitude = !!(course & 0x0400);
    const actualCourse = course & 0x03ff;

    // Decode latitude and longitude
    const decodedLat = decodeGt06Lat(lat, course);
    const decodedLon = decodeGt06Lon(lon, course);

    const parsed = {
      fixTime: fixTime.toISOString(),
      fixTimestamp: Math.floor(fixTime.getTime() / 1000),
      lat: decodedLat,
      lon: decodedLon,
      speed: speed,
      speedUnit: "km/h",
      realTimeGps: realTimeGps,
      gpsPositioned: gpsPositioned,
      eastLongitude: eastLongitude,
      northLatitude: northLatitude,
      course: actualCourse,
      serialNr: data.readUInt16BE(data.length - 6), // Serial number before CRC
      packetType: "extended",
    };

    return parsed;
  } catch (error) {
    return null;
  }
}

function parseAlarm(data) {
  // Validate minimum length for alarm packet
  if (data.length < 40) {
    return null;
  }

  const datasheet = {
    startBit: data.readUInt16BE(0),
    protocolLength: data.readUInt8(2),
    protocolNumber: data.readUInt8(3),
    dateTime: data.slice(4, 10),
    quantity: data.readUInt8(10),
    lat: data.readUInt32BE(11),
    lon: data.readUInt32BE(15),
    speed: data.readUInt8(19),
    course: data.readUInt16BE(20),
    mcc: data.readUInt16BE(22),
    mnc: data.readUInt8(24),
    lac: data.readUInt16BE(25),
    cellId: data.readUIntBE(27, 3),
    terminalInfo: data.readUInt8(30),
    voltageLevel: data.readUInt8(31),
    gsmSignal: data.readUInt8(32),
    alarmLang: data.readUInt16BE(33),
    serialNr: data.readUInt16BE(35),
    errorCheck: data.readUInt16BE(37),
  };

  // Extract satellite information
  const satCnt = (datasheet.quantity & 0xf0) >> 4;
  const satCntActive = datasheet.quantity & 0x0f;

  // Extract course status flags
  const courseValue = datasheet.course;
  const realTimeGps = !!(courseValue & 0x2000);
  const gpsPositioned = !!(courseValue & 0x1000);
  const eastLongitude = !(courseValue & 0x0800);
  const northLatitude = !!(courseValue & 0x0400);
  const actualCourse = courseValue & 0x03ff;

  // Parse date time
  const dt = datasheet.dateTime;
  // GPS device sends UTC time
  const fixTime = new Date(
    Date.UTC(dt[0] + 2000, dt[1] - 1, dt[2], dt[3], dt[4], dt[5])
  );

  // Decode coordinates
  const lat = decodeGt06Lat(datasheet.lat, datasheet.course);
  const lon = decodeGt06Lon(datasheet.lon, datasheet.course);

  // Parse terminal info (from documentation page 17-18)
  const terminalInfo = datasheet.terminalInfo;
  const alarmBits = (terminalInfo & 0x38) >> 3;

  const alarmMap = {
    1: "shock",
    2: "power cut",
    3: "low battery",
    4: "sos",
  };

  const termObj = {
    oilElectricDisconnected: !!(terminalInfo & 0x80),
    gpsTracking: !!(terminalInfo & 0x40),
    alarmType: alarmMap[alarmBits] || "normal",
    charging: !!(terminalInfo & 0x04),
    accHigh: !!(terminalInfo & 0x02),
    activated: !!(terminalInfo & 0x01),
  };

  // Parse voltage level
  const voltageMap = {
    0: "no power (shutting down)",
    1: "extremely low battery",
    2: "very low battery (low battery alarm)",
    3: "low battery (can be used normally)",
    4: "medium",
    5: "high",
    6: "very high",
  };

  // Parse GSM signal
  const gsmMap = {
    0: "no signal",
    1: "extremely weak signal",
    2: "very weak signal",
    3: "good signal",
    4: "strong signal",
  };

  // Parse alarm language
  const alarmType = (datasheet.alarmLang >> 8) & 0xff;
  const language = datasheet.alarmLang & 0xff;

  const alarmTypeMap = {
    0x00: "normal",
    0x01: "SOS",
    0x02: "power cut alarm",
    0x03: "shock alarm",
    0x04: "fence in alarm",
    0x05: "fence out alarm",
  };

  const languageMap = {
    0x01: "chinese",
    0x02: "english",
  };

  const parsed = {
    fixTime: fixTime.toISOString(),
    fixTimestamp: Math.floor(fixTime.getTime() / 1000),
    satCnt: satCnt,
    satCntActive: satCntActive,
    lat: lat,
    lon: lon,
    speed: datasheet.speed,
    speedUnit: "km/h",
    realTimeGps: realTimeGps,
    gpsPositioned: gpsPositioned,
    eastLongitude: eastLongitude,
    northLatitude: northLatitude,
    course: actualCourse,
    mcc: datasheet.mcc,
    mnc: datasheet.mnc,
    lac: datasheet.lac,
    cellId: datasheet.cellId,
    terminalInfo: termObj,
    voltageLevel: voltageMap[datasheet.voltageLevel] || "unknown",
    gsmSignal: gsmMap[datasheet.gsmSignal] || "unknown",
    alarmType: alarmTypeMap[alarmType] || "unknown",
    language: languageMap[language] || "unknown",
    serialNr: datasheet.serialNr,
  };

  return parsed;
}

function createResponse(data) {
  const protocolNumber = data[3];
  const serialNumber = data.readUInt16BE(data.length - 6); // Serial is always before CRC

  // Create response buffer
  const respRaw = Buffer.alloc(10);
  respRaw[0] = 0x78; // Start bit
  respRaw[1] = 0x78;
  respRaw[2] = 0x05; // Packet length (fixed for responses)
  respRaw[3] = protocolNumber; // Same protocol as request
  respRaw[4] = (serialNumber >> 8) & 0xff; // Serial high byte
  respRaw[5] = serialNumber & 0xff; // Serial low byte

  // Calculate CRC for bytes 2-5
  const crcData = respRaw.slice(2, 6);
  const crc = getCrc16(crcData);
  respRaw[6] = (crc >> 8) & 0xff;
  respRaw[7] = crc & 0xff;

  // Stop bit
  respRaw[8] = 0x0d;
  respRaw[9] = 0x0a;

  return respRaw;
}

function parseDatetime(data) {
  return new Date(
    Date.UTC(data[0] + 2000, data[1] - 1, data[2], data[3], data[4], data[5])
  );
}

function decodeGt06Lat(lat, course) {
  let latitude = lat / 60.0 / 30000.0;
  if (!(course & 0x0400)) latitude = -latitude;
  return Math.round(latitude * 1000000) / 1000000;
}

function decodeGt06Lon(lon, course) {
  let longitude = lon / 60.0 / 30000.0;
  if (course & 0x0800) longitude = -longitude;
  return Math.round(longitude * 1000000) / 1000000;
}

function validateCrc(msg) {
  // According to documentation (Page 9, section 4.6):
  // "The check codes of data in the structure of the protocol, from the Packet Length
  // to the Information Serial Number (including 'Packet Length' and 'Information Serial Number')"

  // Data range: from byte 2 (Packet Length) to byte (length - 4) (before CRC)
  const dataToCheck = msg.slice(2, msg.length - 4);
  const receivedCrc = msg.readUInt16BE(msg.length - 4);
  const calculatedCrc = getCrc16(dataToCheck);

  return receivedCrc === calculatedCrc;
}

export default Gt06;
