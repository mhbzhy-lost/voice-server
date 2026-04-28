const dgram = require('dgram');

// STUN message types
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS_RESPONSE = 0x0101;
const MAGIC_COOKIE = 0x2112A442;
const MAGIC_COOKIE_BUF = Buffer.alloc(4);
MAGIC_COOKIE_BUF.writeUInt32BE(MAGIC_COOKIE, 0);

// Attribute types
const XOR_MAPPED_ADDRESS = 0x0020;

function startStunServer(port = 3478) {
  const server = dgram.createSocket('udp4');
  let bound = false;

  server.on('message', (msg, rinfo) => {
    try {
      // Need at least 20 bytes for STUN header
      if (msg.length < 20) return;

      // Check first 2 bits are 0b00
      if ((msg[0] & 0xC0) !== 0) return;

      // Read message type (14 bits: first 2 bytes with top 2 bits cleared)
      const messageType = msg.readUInt16BE(0) & 0x3FFF;

      // Only handle Binding Requests
      if (messageType !== BINDING_REQUEST) return;

      // Check magic cookie
      const cookie = msg.readUInt32BE(4);
      if (cookie !== MAGIC_COOKIE) return;

      // Extract transaction ID (bytes 8-19, 12 bytes)
      const transactionId = msg.slice(8, 20);

      // Build response
      const response = buildBindingResponse(transactionId, rinfo);
      server.send(response, rinfo.port, rinfo.address);
    } catch (err) {
      // Silently ignore malformed packets
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Cannot start STUN server on port ${port}: Address already in use`);
    } else {
      console.error(`STUN server error: ${err.message}`);
    }
  });

  server.on('listening', () => {
    bound = true;
    const addr = server.address();
    console.log(`STUN server listening on udp://0.0.0.0:${addr.port}`);
  });

  // Bind with a flag that we check later
  server.bind(port);

  // Return server immediately (bind happens async)
  return server;
}

function buildBindingResponse(transactionId, rinfo) {
  const port = rinfo.port;
  const address = rinfo.address;

  // Build XOR-MAPPED-ADDRESS attribute
  // Family: 0x01 for IPv4
  // X-Port: port XOR (magic cookie >> 16)
  // X-Address: IP address XOR magic cookie

  const xPort = port ^ 0x2112; // XOR with high 16 bits of magic cookie

  // Parse IP address into bytes and XOR with magic cookie
  const ipParts = address.split('.').map(Number);
  const cookieBytes = [
    (MAGIC_COOKIE >> 24) & 0xFF,
    (MAGIC_COOKIE >> 16) & 0xFF,
    (MAGIC_COOKIE >> 8) & 0xFF,
    MAGIC_COOKIE & 0xFF
  ];

  const xAddress = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    xAddress[i] = ipParts[i] ^ cookieBytes[i];
  }

  // XOR-MAPPED-ADDRESS attribute value (8 bytes)
  // Byte 0: 0x00 (reserved)
  // Byte 1: 0x01 (IPv4)
  // Bytes 2-3: X-Port (big endian, each byte XOR'd with 0x21 and 0x12 respectively)
  // Bytes 4-7: X-Address (XOR'd with magic cookie)
  const attrValue = Buffer.alloc(8);
  attrValue[0] = 0x00;
  attrValue[1] = 0x01; // IPv4
  attrValue.writeUInt16BE(xPort, 2);
  xAddress.copy(attrValue, 4);

  // Build STUN header (20 bytes) + attribute (8 bytes header + 8 bytes value = 16)
  // Attribute header: type (2) + length (2) = 4 bytes
  // Attribute value: 8 bytes
  // Total attribute: 12 bytes, but padded to 4-byte boundary — already aligned

  const attrHeader = Buffer.alloc(4);
  attrHeader.writeUInt16BE(XOR_MAPPED_ADDRESS, 0);
  attrHeader.writeUInt16BE(8, 2); // length of value

  const length = attrHeader.length + attrValue.length; // 12

  // Header: type (2) + length (2) + cookie (4) + transaction id (12)
  const header = Buffer.alloc(20);
  header.writeUInt16BE(BINDING_SUCCESS_RESPONSE, 0);
  header.writeUInt16BE(length, 2);
  MAGIC_COOKIE_BUF.copy(header, 4);
  transactionId.copy(header, 8);

  return Buffer.concat([header, attrHeader, attrValue]);
}

module.exports = startStunServer;
