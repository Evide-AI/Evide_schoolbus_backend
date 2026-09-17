// AIS-140 (ROADRPA) parser — ASCII sentence protocol, distinct from GT06's
// binary protocol. Ported from the existing Evide backend (tcp/server.js).
//
// Not wired into the live ingestion path yet — GT06 is what's in hand today.
// To enable this once AIS-140 devices are purchased: in tcpServer.js, check
// incoming data for the "$ALT"/"$NRM" prefix (see isRoadrpaSentence below)
// before handing it to the GT06 parser, exactly as the existing Evide
// tcp/server.js does.

export function isRoadrpaSentence(data) {
  const raw = data.toString('ascii').trim();
  return raw.startsWith('$ALT') || raw.startsWith('$NRM');
}

export function parseRoadrpa(data) {
  const raw = data.toString('ascii').trim();
  if (!raw.startsWith('$ALT') && !raw.startsWith('$NRM')) return null;

  const withoutChecksum = raw.replace(/\*[0-9A-Fa-f]+$/, '');
  const fields = withoutChecksum.split(',');

  if (fields.length < 17) return null;

  const imei = fields[6];
  const valid = fields[8] === '1';
  const dateStr = fields[9];
  const timeStr = fields[10];
  const lat = parseFloat(fields[11]) * (fields[12] === 'S' ? -1 : 1);
  const lon = parseFloat(fields[13]) * (fields[14] === 'W' ? -1 : 1);
  const speed = parseFloat(fields[15]);
  const heading = parseFloat(fields[16]);
  const msgType = fields[0].replace('$', '');

  if (!imei || isNaN(lat) || isNaN(lon)) return null;

  const day = dateStr.slice(0, 2), mon = dateStr.slice(2, 4), yr = dateStr.slice(4, 8);
  const hh = timeStr.slice(0, 2), mm = timeStr.slice(2, 4), ss = timeStr.slice(4, 6);
  const timestamp = new Date(`${yr}-${mon}-${day}T${hh}:${mm}:${ss}Z`);

  return { imei, valid, lat, lon, speed, heading, timestamp, msgType };
}
