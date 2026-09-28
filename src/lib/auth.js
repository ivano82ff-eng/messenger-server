'use strict';

const { verifyAccessToken } = require('./tokens');

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return res.status(401).json({ error: 'invalid access token' });
  }
  const payload = verifyAccessToken(m[1]);
  if (!payload || typeof payload.sub !== 'string') {
    return res.status(401).json({ error: 'invalid access token' });
  }
  req.userId = payload.sub;
  next();
}

module.exports = { requireAuth };
