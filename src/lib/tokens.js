'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const ACCESS_TTL = parseInt(process.env.ACCESS_TTL || '900', 10);
const REFRESH_TTL = parseInt(process.env.REFRESH_TTL || '2592000', 10);

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set');
}

function signAccessToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: ACCESS_TTL,
  });
}

function verifyAccessToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}

function generateRefreshToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  return { token: 'rfr_' + raw, ttlSeconds: REFRESH_TTL };
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  ACCESS_TTL,
  REFRESH_TTL,
};
