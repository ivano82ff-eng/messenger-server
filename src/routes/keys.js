'use strict';

const express = require('express');
const pool = require('../db/pool');
const { canonicalizeUserId } = require('../lib/userId');
const { requireAuth } = require('../lib/auth');
const { sendError, Errors } = require('../lib/errors');

const router = express.Router();

router.put('/v1/keys/one-time', requireAuth, async (req, res) => {
  const { oneTimePreKeys } = req.body || {};
  if (!Array.isArray(oneTimePreKeys)) {
    return sendError(res, 400, 'oneTimePreKeys must be an array');
  }

  let stored = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const k of oneTimePreKeys) {
      if (!k || !Number.isInteger(k.keyId) || typeof k.publicKey !== 'string') {
        continue;
      }
      await client.query(
        `INSERT INTO one_time_prekeys (user_id, key_id, public_key)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, key_id)
         DO UPDATE SET public_key = EXCLUDED.public_key`,
        [req.userId, k.keyId, k.publicKey]
      );
      stored++;
    }
    await client.query('COMMIT');
    return res.status(200).json({ stored });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PUT /v1/keys/one-time failed:', e);
    return sendError(res, 400, e.message || 'bad request');
  } finally {
    client.release();
  }
});

router.get('/v1/keys/bundle/:userId', requireAuth, async (req, res) => {
  const canonical = canonicalizeUserId(req.params.userId);
  if (!canonical) {
    return sendError(res, 400, 'invalid userId');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const dev = await client.query(
      `SELECT user_id, device_id, registration_id, identity_public_key, signed_prekey
         FROM devices
        WHERE user_id = $1`,
      [canonical]
    );
    if (dev.rowCount === 0) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'unknown userId');
    }
    const d = dev.rows[0];

    const otp = await client.query(
      `UPDATE one_time_prekeys
          SET used_at = now()
        WHERE id = (
          SELECT id
            FROM one_time_prekeys
           WHERE user_id = $1 AND used_at IS NULL
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        RETURNING key_id, public_key`,
      [canonical]
    );

    if (otp.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: Errors.oneTimePrekeysExhausted });
    }

    await client.query('COMMIT');

    return res.status(200).json({
      userId: d.user_id,
      deviceId: d.device_id,
      registrationId: d.registration_id,
      identityPublicKey: d.identity_public_key,
      signedPreKey: d.signed_prekey,
      oneTimePreKey: {
        keyId: otp.rows[0].key_id,
        publicKey: otp.rows[0].public_key,
      },
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('GET /v1/keys/bundle failed:', e);
    return sendError(res, 400, e.message || 'bad request');
  } finally {
    client.release();
  }
});

module.exports = router;
