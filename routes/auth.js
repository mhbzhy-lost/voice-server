const { Router } = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { tokens, generateToken } = require('../auth');

const router = Router();

// POST /api/auth/register
router.post('/register', (req, res) => {
  try {
    const { username, password } = req.body;

    // Validate username
    if (!username || typeof username !== 'string') {
      return res.status(400).json({ error: 'Username is required' });
    }
    if (!/^[a-zA-Z0-9]{3,20}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-20 alphanumeric characters' });
    }

    // Validate password
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Password is required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check if username already taken, or reserved
    if (username.toLowerCase() === 'superadmin') {
      return res.status(400).json({ error: 'This username is reserved' });
    }
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    // Check if this is the first user (will become admin)
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
    const role = userCount.count === 0 ? 'admin' : 'user';

    // Hash password and create user
    const hashedPassword = bcrypt.hashSync(password, 10);
    const result = db.prepare('INSERT INTO users (username, password, role, nickname) VALUES (?, ?, ?, ?)').run(username, hashedPassword, role, username);

    const userId = result.lastInsertRowid;
    const nickname = username;

    // Generate token
    const token = generateToken();
    tokens.set(token, { userId, username, role, nickname });

    res.status(201).json({
      token,
      user: { id: userId, username, role, nickname }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/login
router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = db.prepare('SELECT id, username, password, role, nickname FROM users WHERE username = ?').get(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const validPassword = bcrypt.compareSync(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const nickname = user.nickname || user.username;
    const token = generateToken();
    tokens.set(token, { userId: user.id, username: user.username, role: user.role, nickname });

    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role, nickname }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      tokens.delete(token);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.slice(7);
  const session = tokens.get(token);
  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  res.json({
    user: { id: session.userId, username: session.username, role: session.role, nickname: session.nickname }
  });
});

module.exports = router;
