const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const { SUPERADMIN_PASSWORD } = require('./db');
const auth = require('./auth');
const authRoutes = require('./routes/auth');
const roomRoutes = require('./routes/rooms');
const userRoutes = require('./routes/users');
const invitesRoutes = require('./routes/invites');
const { initSignaling, connections, rooms } = require('./ws/signaling');
const startStunServer = require('./stun/server');

const app = express();
const PORT = process.env.PORT || 3000;
const STUN_PORT = process.env.STUN_PORT || 3478;

// Parse JSON bodies
app.use(express.json());

// Mount routes
app.use('/api/auth', authRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/users', userRoutes);
app.use('/api/invites', invitesRoutes);

// Inject connection tracking into room routes for participant counting
roomRoutes.setRoomConnections(connections, rooms);

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public')));

// Fallback: serve index.html for any unmatched GET (SPA routing)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Create HTTP or HTTPS server depending on env-provided TLS material.
// When both TLS_CERT_PATH and TLS_KEY_PATH are set and readable, the
// server listens with TLS so browsers treat the origin as a Secure
// Context (required to expose navigator.mediaDevices over a non-localhost
// origin). Otherwise fall back to plain HTTP (handy for local dev).
const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;
let server;
let usingTls = false;
if (TLS_CERT_PATH && TLS_KEY_PATH) {
  try {
    const cert = fs.readFileSync(TLS_CERT_PATH);
    const key = fs.readFileSync(TLS_KEY_PATH);
    server = https.createServer({ cert, key }, app);
    usingTls = true;
  } catch (err) {
    console.error(
      `TLS material configured but unreadable (cert=${TLS_CERT_PATH}, key=${TLS_KEY_PATH}): ${err.message}`
    );
    console.error('Falling back to plain HTTP.');
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
}

// Initialize WebSocket server (noServer mode)
const wss = new WebSocketServer({ noServer: true });

// Initialize signaling
initSignaling(wss);

// Handle HTTP upgrade for WebSocket connections
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;

  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Start STUN server (bind is async; startup message logged by stun/server.js)
startStunServer(STUN_PORT);

// Start the server (HTTP or HTTPS depending on TLS_* env vars above)
server.listen(PORT, () => {
  const proto = usingTls ? 'https' : 'http';
  console.log(`${usingTls ? 'HTTPS' : 'HTTP'} server listening on ${proto}://0.0.0.0:${PORT}`);
  console.log(`Superadmin account: superadmin / ${SUPERADMIN_PASSWORD}`);
  console.log('Voice server ready');
});
