const { Router } = require('express');
const { db } = require('../db');
const { requireAuth, requireSuperAdmin } = require('../auth');
const { kickUserFromRoom } = require('../ws/signaling');

// These are set by initSignaling via setRoomConnections
let getConnections = () => new Map();
let getRooms = () => new Map();

// Allow signaling module to inject connection tracking
function setRoomConnections(connectionsMap, roomsMap) {
  getConnections = () => connectionsMap;
  getRooms = () => roomsMap;
}

const router = Router();

// Auth required for all room routes
router.use(requireAuth);

// Helper: count participants in a room
function countParticipants(roomId) {
  const connections = getConnections();
  let count = 0;
  for (const [, conn] of connections) {
    if (conn.roomId === roomId) count++;
  }
  return count;
}

// Helper: get participants in a room
function getParticipants(roomId) {
  const connections = getConnections();
  const participants = [];
  for (const [id, conn] of connections) {
    if (conn.roomId === roomId) {
      participants.push({ id, username: conn.username, nickname: conn.nickname });
    }
  }
  return participants;
}

// GET /api/rooms — list all rooms
router.get('/', (req, res) => {
  try {
    const rooms = db.prepare(`
      SELECT r.id, r.name, r.owner_id, r.created_at, u.username as owner_username
      FROM rooms r
      JOIN users u ON r.owner_id = u.id
      ORDER BY r.created_at DESC
    `).all();

    const result = rooms.map(room => ({
      id: room.id,
      name: room.name,
      owner_id: room.owner_id,
      owner_username: room.owner_username,
      participant_count: countParticipants(room.id),
      created_at: room.created_at
    }));

    res.json(result);
  } catch (err) {
    console.error('List rooms error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/rooms — create a room
router.post('/', (req, res) => {
  try {
    const { name } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Room name is required' });
    }
    if (name.length > 50) {
      return res.status(400).json({ error: 'Room name must be 50 characters or less' });
    }

    const result = db.prepare('INSERT INTO rooms (name, owner_id) VALUES (?, ?)').run(name.trim(), req.user.id);
    const room = db.prepare('SELECT id, name, owner_id, created_at FROM rooms WHERE id = ?').get(result.lastInsertRowid);

    res.status(201).json({ room });
  } catch (err) {
    console.error('Create room error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/rooms/:id — room details
router.get('/:id', (req, res) => {
  try {
    const room = db.prepare(`
      SELECT r.id, r.name, r.owner_id, r.created_at, u.username as owner_username
      FROM rooms r
      JOIN users u ON r.owner_id = u.id
      WHERE r.id = ?
    `).get(req.params.id);

    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    const participants = getParticipants(room.id);

    res.json({
      room: {
        id: room.id,
        name: room.name,
        owner_id: room.owner_id,
        owner_username: room.owner_username,
        created_at: room.created_at
      },
      participants
    });
  } catch (err) {
    console.error('Get room error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/rooms/:id — delete a room
router.delete('/:id', (req, res) => {
  try {
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    // Only owner or admin can delete (superadmin also counts as admin)
    if (room.owner_id !== req.user.id && req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Not authorized to delete this room' });
    }

    db.prepare('DELETE FROM rooms WHERE id = ?').run(req.params.id);

    // Notify all WebSocket connections in this room that it was deleted
    const connections = getConnections();
    for (const [userId, conn] of connections) {
      if (conn.roomId === Number(req.params.id) && conn.ws.readyState === 1) {
        try {
          conn.ws.send(JSON.stringify({ type: 'room-deleted', roomId: Number(req.params.id) }));
        } catch (e) {
          // ignore send errors
        }
        // Remove from room tracking
        conn.roomId = null;
      }
    }

    // Clean up room entry in rooms map
    const rooms = getRooms();
    rooms.delete(Number(req.params.id));

    res.json({ ok: true });
  } catch (err) {
    console.error('Delete room error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/rooms/:id/kick — superadmin kicks a user out of a room
router.post('/:id/kick', requireSuperAdmin, (req, res) => {
  try {
    const roomId = Number(req.params.id);
    const userId = Number(req.body && req.body.userId);

    if (!Number.isInteger(roomId) || roomId <= 0) {
      return res.status(400).json({ error: 'Invalid room id' });
    }
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(roomId);
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    const ok = kickUserFromRoom(roomId, userId);
    if (!ok) {
      return res.status(404).json({ error: '用户不在该房间' });
    }

    res.json({ ok: true, kickedUserId: userId });
  } catch (err) {
    console.error('Kick user error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
module.exports.setRoomConnections = setRoomConnections;
