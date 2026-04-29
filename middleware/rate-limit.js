const rateLimit = require('express-rate-limit');

// Skip rate limiting for localhost (deploy.sh remote verify hits via curl from
// the host itself; we don't want self-checks to trip limits).
const skipLocalhost = (req) =>
  req.ip === '::1' ||
  req.ip === '127.0.0.1' ||
  (typeof req.ip === 'string' && req.ip.startsWith('::ffff:127.'));

const commonOptions = {
  standardHeaders: true,
  legacyHeaders: false,
  statusCode: 429,
  message: { error: '请求过于频繁，请稍后再试' },
  skip: skipLocalhost,
  // Server runs directly on a public IP without a reverse proxy. Explicitly
  // declare we do not trust proxy headers so express-rate-limit v7 doesn't
  // emit the trust-proxy security warning.
  validate: { trustProxy: false },
};

// Auth endpoints (login/register): brute-force resistant.
const authLimiter = rateLimit({
  ...commonOptions,
  windowMs: 15 * 60 * 1000,
  max: 10,
});

// Invite token check: prevent enumeration of invite tokens.
const inviteCheckLimiter = rateLimit({
  ...commonOptions,
  windowMs: 60 * 1000,
  max: 30,
});

// General /api/* fallback to mitigate undifferentiated DoS.
const apiGeneralLimiter = rateLimit({
  ...commonOptions,
  windowMs: 60 * 1000,
  max: 120,
});

module.exports = {
  authLimiter,
  inviteCheckLimiter,
  apiGeneralLimiter,
};
