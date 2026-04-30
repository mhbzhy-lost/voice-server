const { Router } = require('express');
const { db } = require('../db');
const { tokens, requireAuth, requireSuperAdmin } = require('../auth');

const router = Router();

// Nickname validator: trim length 1-30; allow Chinese, letters, digits, space, _-.
function validateNickname(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 30) return null;
  if (!/^[一-龥A-Za-z0-9 _\-.]+$/.test(trimmed)) return null;
  return trimmed;
}

// PATCH /api/users/me — update own nickname (any authenticated user)
router.patch('/me', requireAuth, (req, res) => {
  try {
    const nickname = validateNickname(req.body && req.body.nickname);
    if (!nickname) {
      return res.status(400).json({ error: '昵称格式不合法' });
    }

    const userId = req.user.id;
    const result = db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nickname, userId);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = db.prepare('SELECT id, username, role, nickname FROM users WHERE id = ?').get(userId);

    // Sync nickname into all live token sessions for this user
    for (const [, session] of tokens) {
      if (session.userId === userId) {
        session.nickname = user.nickname;
      }
    }

    // Notify peers in the user's current room (if any). Lazy-required to
    // avoid any potential circular import between routes ↔ ws/signaling.
    try {
      const { broadcastNicknameChanged } = require('../ws/signaling');
      broadcastNicknameChanged(userId, user.nickname);
    } catch (e) {
      console.error('broadcastNicknameChanged failed:', e.message);
    }

    res.json({ user });
  } catch (err) {
    console.error('Update nickname error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- User preferences (KV) ---
const PREF_KEY_WHITELIST = new Set([
  'voice_input_volume',
  'voice_output_volume',
  'voice_peer_volumes',
  'voice_audio_prefs',
]);
const PREF_VALUE_MAX_LEN = 4096;

// GET /api/users/me/preferences — fetch all preferences for current user
router.get('/me/preferences', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT key, value FROM user_preferences WHERE user_id = ?'
    ).all(req.user.id);
    const preferences = {};
    for (const row of rows) {
      preferences[row.key] = row.value;
    }
    res.json({ preferences });
  } catch (err) {
    console.error('Get preferences error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/users/me/preferences/:key — upsert a single preference
router.put('/me/preferences/:key', requireAuth, (req, res) => {
  try {
    const key = req.params.key;
    if (!PREF_KEY_WHITELIST.has(key)) {
      return res.status(400).json({ error: '不支持的偏好键' });
    }
    const value = req.body && req.body.value;
    if (typeof value !== 'string') {
      return res.status(400).json({ error: 'value 必须为字符串' });
    }
    if (value.length > PREF_VALUE_MAX_LEN) {
      return res.status(400).json({ error: 'value 长度超过限制' });
    }

    const info = db.prepare(
      `INSERT INTO user_preferences (user_id, key, value, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, key) DO UPDATE SET
         value = excluded.value,
         updated_at = datetime('now')`
    ).run(req.user.id, key, value);

    const row = db.prepare(
      'SELECT updated_at FROM user_preferences WHERE user_id = ? AND key = ?'
    ).get(req.user.id, key);

    res.json({ ok: true, updated_at: row ? row.updated_at : null });
  } catch (err) {
    console.error('Put preference error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// All routes below require superadmin
router.use(requireSuperAdmin);

// GET /api/users — list all users
router.get('/', (req, res) => {
  try {
    const users = db.prepare('SELECT id, username, role, nickname, created_at FROM users ORDER BY id').all();
    res.json(users);
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/users/:id/role — change a user's role (superadmin only)
router.put('/:id/role', (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { role } = req.body;

    if (!role || !['user', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Role must be "user" or "admin"' });
    }

    const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Cannot change superadmin's role
    if (target.role === 'superadmin') {
      return res.status(403).json({ error: 'Cannot modify superadmin role' });
    }

    // Cannot self-demote
    if (target.id === req.user.id) {
      return res.status(403).json({ error: 'Cannot change your own role' });
    }

    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);

    res.json({ ok: true, user: { id: userId, username: target.username, role } });
  } catch (err) {
    console.error('Update role error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
