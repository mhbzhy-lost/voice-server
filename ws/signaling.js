const { tokens } = require('../auth');
const { db } = require('../db');

// Connection tracking
const connections = new Map(); // userId -> { ws, username, role, nickname, roomId, muted }
const rooms = new Map();       // roomId -> Set of userIds

// For assigning WS-level IDs (we track users by their DB userId)
// connections map keys are the actual DB userId (Number)

function initSignaling(wss) {
  wss.on('connection', (ws, req) => {
    // Parse token from query string
    const searchParams = new URL(req.url, 'http://localhost').searchParams;
    const token = searchParams.get('token');

    if (!token) {
      ws.close(4001, 'Authentication required');
      return;
    }

    const session = tokens.get(token);
    if (!session) {
      ws.close(4001, 'Invalid or expired token');
      return;
    }

    const userId = session.userId;
    const username = session.username;
    const role = session.role;
    let nickname = session.nickname;
    if (!nickname) {
      try {
        const row = db.prepare('SELECT nickname FROM users WHERE id = ?').get(userId);
        nickname = (row && row.nickname) || username;
      } catch (e) {
        nickname = username;
      }
    }

    // Store connection
    connections.set(userId, { ws, username, role, nickname, roomId: null, muted: false });
    ws.userId = userId;
    ws.username = username;
    ws.role = role;

    console.log(`WebSocket connected: ${username} (${userId})`);

    // Handle messages
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        handleMessage(ws, userId, username, message);
      } catch (err) {
        console.error('Invalid message from', username, err.message);
      }
    });

    // Handle close
    ws.on('close', () => {
      handleDisconnect(userId);
    });

    // Handle errors
    ws.on('error', (err) => {
      console.error(`WebSocket error for ${username}: ${err.message}`);
      handleDisconnect(userId);
    });
  });
}

function handleMessage(ws, userId, username, message) {
  switch (message.type) {
    case 'join-room':
      handleJoinRoom(ws, userId, username, message.roomId);
      break;

    case 'leave-room':
      handleLeaveRoom(userId);
      break;

    case 'offer':
      relayToUser(userId, username, message.targetUserId, {
        type: 'offer',
        sdp: message.sdp,
        fromUserId: userId,
        fromUsername: username
      });
      break;

    case 'answer':
      relayToUser(userId, username, message.targetUserId, {
        type: 'answer',
        sdp: message.sdp,
        fromUserId: userId
      });
      break;

    case 'ice-candidate':
      relayToUser(userId, username, message.targetUserId, {
        type: 'ice-candidate',
        candidate: message.candidate,
        fromUserId: userId
      });
      break;

    case 'mute-changed':
      handleMuteChanged(userId, message.muted);
      break;

    default:
      console.log(`Unknown message type from ${username}: ${message.type}`);
  }
}

function handleJoinRoom(ws, userId, username, roomId) {
  // Leave current room if in one
  if (connections.get(userId) && connections.get(userId).roomId) {
    handleLeaveRoom(userId);
  }

  const roomIdNum = Number(roomId);

  // Update connection
  const conn = connections.get(userId);
  if (conn) {
    conn.roomId = roomIdNum;
  }

  // Add to room
  if (!rooms.has(roomIdNum)) {
    rooms.set(roomIdNum, new Set());
  }
  rooms.get(roomIdNum).add(userId);

  console.log(`${username} joined room ${roomIdNum}`);

  // Get current users in room (excluding the joiner)
  const currentUsers = [];
  for (const uid of rooms.get(roomIdNum)) {
    if (uid !== userId) {
      const c = connections.get(uid);
      if (c) {
        currentUsers.push({ id: uid, username: c.username, nickname: c.nickname, muted: c.muted });
      }
    }
  }

  // Send room state to the joiner
  const allUsers = [];
  for (const uid of rooms.get(roomIdNum)) {
    const c = connections.get(uid);
    if (c) {
      allUsers.push({ id: uid, username: c.username, nickname: c.nickname, muted: c.muted });
    }
  }

  safeSend(ws, {
    type: 'room-state',
    roomId: roomIdNum,
    users: allUsers
  });

  // Broadcast to all OTHER users that someone joined
  for (const uid of rooms.get(roomIdNum)) {
    if (uid !== userId) {
      const c = connections.get(uid);
      if (c && c.ws.readyState === 1) {
        safeSend(c.ws, {
          type: 'user-joined',
          user: { id: userId, username, nickname: (connections.get(userId) && connections.get(userId).nickname) || username }
        });
      }
    }
  }
}

function handleLeaveRoom(userId) {
  const conn = connections.get(userId);
  if (!conn || !conn.roomId) return;

  const roomId = conn.roomId;
  const oldRoomId = roomId;

  conn.roomId = null;

  // Remove from room set
  if (rooms.has(roomId)) {
    rooms.get(roomId).delete(userId);
    if (rooms.get(roomId).size === 0) {
      rooms.delete(roomId);
    }
  }

  console.log(`User ${conn.username} left room ${oldRoomId}`);

  // Broadcast to remaining users in the room
  if (rooms.has(roomId)) {
    for (const uid of rooms.get(roomId)) {
      const c = connections.get(uid);
      if (c && c.ws.readyState === 1) {
        safeSend(c.ws, {
          type: 'user-left',
          userId: userId
        });
      }
    }
  }
}

function handleMuteChanged(userId, muted) {
  const conn = connections.get(userId);
  if (!conn) return;

  conn.muted = !!muted;

  // Broadcast to room
  if (conn.roomId && rooms.has(conn.roomId)) {
    for (const uid of rooms.get(conn.roomId)) {
      if (uid !== userId) {
        const c = connections.get(uid);
        if (c && c.ws.readyState === 1) {
          safeSend(c.ws, {
            type: 'user-muted',
            userId: userId,
            muted: conn.muted
          });
        }
      }
    }
  }
}

function handleDisconnect(userId) {
  const conn = connections.get(userId);
  if (!conn) return;

  // Leave room first
  if (conn.roomId) {
    const roomId = conn.roomId;
    conn.roomId = null;

    if (rooms.has(roomId)) {
      rooms.get(roomId).delete(userId);
      if (rooms.get(roomId).size === 0) {
        rooms.delete(roomId);
      }

      // Broadcast user-left
      for (const uid of rooms.get(roomId) || []) {
        const c = connections.get(uid);
        if (c && c.ws.readyState === 1) {
          safeSend(c.ws, {
            type: 'user-left',
            userId: userId
          });
        }
      }
    }
  }

  console.log(`WebSocket disconnected: ${conn.username} (${userId})`);
  connections.delete(userId);
}

function relayToUser(fromUserId, fromUsername, targetUserId, message) {
  const targetConn = connections.get(targetUserId);
  if (!targetConn || !targetConn.ws || targetConn.ws.readyState !== 1) {
    // Target not connected, ignore silently
    return;
  }

  safeSend(targetConn.ws, message);
}

function safeSend(ws, data) {
  if (ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(data));
    } catch (err) {
      console.error('Send error:', err.message);
    }
  }
}

// Kick a user out of a specific room. Returns true if the user was in the
// room and was kicked, false otherwise. Sends `kicked` to the target,
// then reuses handleLeaveRoom to clean state and broadcast `user-left`.
function kickUserFromRoom(roomId, targetUserId) {
  const roomIdNum = Number(roomId);
  const uid = Number(targetUserId);
  const conn = connections.get(uid);
  if (!conn || conn.roomId !== roomIdNum) {
    return false;
  }

  // Notify the target before tearing down its room state
  if (conn.ws && conn.ws.readyState === 1) {
    safeSend(conn.ws, { type: 'kicked', roomId: roomIdNum });
  }

  // Reuse standard leave flow: clears conn.roomId, removes from rooms set,
  // and broadcasts user-left to remaining peers.
  handleLeaveRoom(uid);
  return true;
}

module.exports = { initSignaling, connections, rooms, kickUserFromRoom };
