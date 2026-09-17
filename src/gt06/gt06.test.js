import getCrc16 from './crc16.js';
import Gt06 from './gt06.js';

function buildPacket(protocolNumber, content, serial = 0x0001) {
  const serialBuf = Buffer.alloc(2);
  serialBuf.writeUInt16BE(serial, 0);
  const body = Buffer.concat([
    Buffer.from([content.length + 1 + 2 + 2]),
    Buffer.from([protocolNumber]),
    content,
    serialBuf,
  ]);
  const crc = getCrc16(body);
  const crcBuf = Buffer.alloc(2);
  crcBuf.writeUInt16BE(crc, 0);
  return Buffer.concat([Buffer.from([0x78, 0x78]), body, crcBuf, Buffer.from([0x0d, 0x0a])]);
}

// --- Test 1: login (standard 13-byte length) ---
const imeiBcd = Buffer.from('0864404031234567', 'hex');
const loginPacket = buildPacket(0x01, imeiBcd);
const gt06a = new Gt06();
const loginResults = gt06a.parse(loginPacket);
console.log('Test 1 - login parsed:', loginResults.length === 1 ? 'OK' : 'FAIL', loginResults[0]);
console.log('Test 1 - ACK generated:', loginResults[0]?.responseMsg?.toString('hex'));

// --- Test 2: GPS location — Kerala coordinates, moving, north/east ---
// Standard GT06 location packet content: dateTime(6) + satInfo(1) + lat(4) +
// lon(4) + speed(1) + course/status(2) + mcc(2) + mnc(1) + lac(2) + cellId(3)
// = 26 bytes, matching the offsets gt06.js reads from the full packet.
const gpsContent = Buffer.alloc(26);
gpsContent[0] = 26; gpsContent[1] = 9; gpsContent[2] = 12;   // date: 2026-09-12
gpsContent[3] = 10; gpsContent[4] = 30; gpsContent[5] = 0;   // time: 10:30:00
gpsContent[6] = 0xc8;                                        // satellite info
gpsContent.writeUInt32BE(Math.round(10.0 * 60 * 30000), 7);  // lat ~10.0 N
gpsContent.writeUInt32BE(Math.round(76.0 * 60 * 30000), 11); // lon ~76.0 E
gpsContent[15] = 32;                                          // speed 32 km/h
gpsContent.writeUInt16BE(0b0000010000101000, 16);            // course=40, north(bit10 set)/east(bit11 clear)
gpsContent.writeUInt16BE(0x04c8, 18);                         // mcc (dummy)
gpsContent[20] = 0x01;                                        // mnc (dummy)
gpsContent.writeUInt16BE(0x1234, 21);                         // lac (dummy)
gpsContent.writeUIntBE(0x56789a, 23, 3);                      // cellId (dummy)

const gpsPacket = buildPacket(0x12, gpsContent, 0x0002);
const gt06b = new Gt06();
gt06b.imei = '864404031234567'; // simulate having already seen the login on this connection
const gpsResults = gt06b.parse(gpsPacket);
console.log('\nTest 2 - GPS parsed:', gpsResults.length === 1 ? 'OK' : 'FAIL');
console.log('Test 2 - lat/lon/speed/course:', gpsResults[0]?.lat, gpsResults[0]?.lon, gpsResults[0]?.speed, gpsResults[0]?.course);

// --- Test 3: split-packet handling (device data arriving across two TCP reads) ---
const gt06c = new Gt06();
const half = Math.floor(gpsPacket.length / 2);
const firstHalfResults = gt06c.parse(gpsPacket.slice(0, half));
console.log('\nTest 3 - packets from first half:', firstHalfResults.length, '(expect 0)');
const secondHalfResults = gt06c.parse(gpsPacket.slice(half));
console.log('Test 3 - packets after second half:', secondHalfResults.length, '(expect 1)');
