const crypto = require('crypto');

// In-memory token store: token -> { userId, username, role }
const tokens = new Map();

function generateToken() {
  return crypto.randomUUID();
}

// Express middleware: checks Authorization header for "Bearer <token>"
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.slice(7);
  const session = tokens.get(token);
  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = { id: session.userId, username: session.username, role: session.role };
  req.token = token;
  next();
}

// Express middleware: requires superadmin role
function requireSuperAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'superadmin') {
      return res.status(403).json({ error: '需要超级管理员权限' });
    }
    next();
  });
}

module.exports = { tokens, generateToken, requireAuth, requireSuperAdmin };
