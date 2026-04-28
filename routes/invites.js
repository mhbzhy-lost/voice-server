const { Router } = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const { requireSuperAdmin } = require('../auth');

const router = Router();

function computeStatus(row) {
  // Compare expires_at against current UTC time. SQLite datetime('now') is UTC.
  const nowRow = db.prepare("SELECT datetime('now') as now").get();
  if (row.expires_at <= nowRow.now) return 'expired';
  return 'pending';
}

// POST /api/invites — superadmin creates an invite
router.post('/', requireSuperAdmin, (req, res) => {
  try {
    let days = Number(req.body && req.body.days);
    if (!Number.isFinite(days) || days <= 0) days = 1;
    days = Math.max(1, Math.min(365, Math.floor(days)));

    const token = crypto.randomBytes(16).toString('hex');
    const stmt = db.prepare(
      `INSERT INTO invites (token, created_by, expires_at) VALUES (?, ?, datetime('now', '+' || ? || ' days'))`
    );
    const result = stmt.run(token, req.user.id, days);

    const row = db.prepare(
      'SELECT id, token, created_at, expires_at FROM invites WHERE id = ?'
    ).get(result.lastInsertRowid);

    const host = req.get('host');
    const url = `${req.protocol}://${host}/#/invite/${token}`;

    res.status(201).json({ invite: row, url });
  } catch (err) {
    console.error('Create invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/invites — superadmin lists all invites
router.get('/', requireSuperAdmin, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT i.id, i.token, i.created_at, i.expires_at,
             COUNT(iu.id) AS use_count
      FROM invites i
      LEFT JOIN invite_uses iu ON iu.invite_id = i.id
      GROUP BY i.id
      ORDER BY i.created_at DESC
    `).all();

    const invites = rows.map(r => ({
      id: r.id,
      token: r.token,
      created_at: r.created_at,
      expires_at: r.expires_at,
      use_count: r.use_count,
      status: computeStatus(r),
    }));

    res.json({ invites });
  } catch (err) {
    console.error('List invites error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/invites/:id — superadmin deletes an invite record
router.delete('/:id', requireSuperAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const deleteUses = db.prepare('DELETE FROM invite_uses WHERE invite_id = ?');
    const deleteInvite = db.prepare('DELETE FROM invites WHERE id = ?');
    const tx = db.transaction((inviteId) => {
      deleteUses.run(inviteId);
      return deleteInvite.run(inviteId);
    });
    const result = tx(id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Invite not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/invites/check/:token — public check
router.get('/check/:token', (req, res) => {
  try {
    const token = req.params.token;
    const row = db.prepare(
      'SELECT id, token, expires_at FROM invites WHERE token = ?'
    ).get(token);
    if (!row) return res.json({ valid: false, reason: 'not-found' });
    const nowRow = db.prepare("SELECT datetime('now') as now").get();
    if (row.expires_at <= nowRow.now) return res.json({ valid: false, reason: 'expired' });
    res.json({ valid: true });
  } catch (err) {
    console.error('Check invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
