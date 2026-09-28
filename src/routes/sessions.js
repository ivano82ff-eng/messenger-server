'use strict';

const express = require('express');
const pool = require('../db/pool');
const {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TTL,
} = require('../lib/tokens');
const { sendError, Errors } = require('../lib/errors');

const router = express.Router();

router.post('/v1/sessions/refresh', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    return sendError(res, 401, Errors.invalidRefreshToken);
  }

  const oldHash = hashRefreshToken(refreshToken);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const found = await client.query(
      `SELECT id, user_id, expires_at
         FROM refresh_tokens
        WHERE token_hash = $1
        FOR UPDATE`,
      [oldHash]
    );

    if (found.rowCount === 0) {
      await client.query('ROLLBACK');
      return sendError(res, 401, Errors.invalidRefreshToken);
    }

    const row = found.rows[0];

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query('DELETE FROM refresh_tokens WHERE id = $1', [row.id]);
      await client.query('COMMIT');
      return sendError(res, 401, Errors.invalidRefreshToken);
    }

    await client.query('DELETE FROM refresh_tokens WHERE id = $1', [row.id]);

    const { token: newRefresh } = generateRefreshToken();
    const newHash = hashRefreshToken(newRefresh);
    await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
      [row.user_id, newHash, REFRESH_TTL]
    );

    const accessToken = signAccessToken(row.user_id);

    await client.query('COMMIT');

    return res.status(200).json({
      accessToken,
      refreshToken: newRefresh,
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /v1/sessions/refresh failed:', e);
    return sendError(res, 400, e.message || 'bad request');
  } finally {
    client.release();
  }
});

module.exports = router;
