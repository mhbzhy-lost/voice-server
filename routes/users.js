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

    res.json({ user });
  } catch (err) {
    console.error('Update nickname error:', err);
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
