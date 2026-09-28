'use strict';

const express = require('express');
const pool = require('../db/pool');
const { generateUserId } = require('../lib/userId');
const {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TTL,
} = require('../lib/tokens');
const { sendError } = require('../lib/errors');

const router = express.Router();

router.post('/v1/devices', async (req, res) => {
  const {
    registrationId,
    identityPublicKey,
    signedPreKey,
    oneTimePreKeys,
  } = req.body || {};

  if (!Number.isInteger(registrationId)) {
    return sendError(res, 400, 'registrationId must be an integer');
  }
  if (typeof identityPublicKey !== 'string' || identityPublicKey.length === 0) {
    return sendError(res, 400, 'identityPublicKey is required');
  }
  if (!signedPreKey || typeof signedPreKey !== 'object') {
    return sendError(res, 400, 'signedPreKey is required');
  }
  if (!Array.isArray(oneTimePreKeys)) {
    return sendError(res, 400, 'oneTimePreKeys must be an array');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let userId = null;
    for (let i = 0; i < 10; i++) {
      const candidate = generateUserId();
      const exists = await client.query(
        'SELECT 1 FROM devices WHERE user_id = $1',
        [candidate]
      );
      if (exists.rowCount === 0) { userId = candidate; break; }
    }
    if (!userId) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'could not allocate userId');
    }

    const deviceId = 'device_1';

    await client.query(
      `INSERT INTO devices
         (user_id, device_id, registration_id, identity_public_key, signed_prekey)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, deviceId, registrationId, identityPublicKey, signedPreKey]
    );

    for (const k of oneTimePreKeys) {
      if (!Number.isInteger(k && k.keyId) || typeof (k && k.publicKey) !== 'string') continue;
      await client.query(
        `INSERT INTO one_time_prekeys (user_id, key_id, public_key)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, key_id)
         DO UPDATE SET public_key = EXCLUDED.public_key`,
        [userId, k.keyId, k.publicKey]
      );
    }

    const { token: refreshToken } = generateRefreshToken();
    const tokenHash = hashRefreshToken(refreshToken);
    await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
      [userId, tokenHash, REFRESH_TTL]
    );

    const accessToken = signAccessToken(userId);

    await client.query('COMMIT');

    return res.status(201).json({
      userId,
      deviceId,
      accessToken,
      refreshToken,
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /v1/devices failed:', e);
    return sendError(res, 400, e.message || 'bad request');
  } finally {
    client.release();
  }
});

module.exports = router;
