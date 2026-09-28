'use strict';

const { WebSocketServer } = require('ws');
const pool = require('../db/pool');
const { verifyAccessToken } = require('../lib/tokens');
const { canonicalizeUserId } = require('../lib/userId');
const {
  getUserSockets,
  addSocket,
  removeSocket,
  withUserLock,
  sendToUser,
} = require('./hub');

const AUTH_TIMEOUT_MS = 10000;

function closeWithError(ws, status, message) {
  try {
    ws.send(JSON.stringify({ type: 'error', status, error: message }));
  } catch {}
  try { ws.close(4001, 'auth failed'); } catch {}
}

async function deliverQueue(userId) {
  const { rows } = await pool.query(
    `SELECT id, sender_user_id, recipient_user_id, recipient_device_id,
            ciphertext, sent_at
       FROM envelopes
      WHERE recipient_user_id = $1 AND delivered_at IS NULL
      ORDER BY received_at ASC`,
    [userId]
  );

  for (const row of rows) {
    const frame = {
      type: 'envelope',
      id: row.id,
      senderUserId: row.sender_user_id,
      recipientUserId: row.recipient_user_id,
      ciphertext: Buffer.isBuffer(row.ciphertext)
        ? row.ciphertext.toString('base64')
        : row.ciphertext,
      sentAt: row.sent_at.toISOString(),
    };
    const result = sendToUser(userId, frame);
    if (!result.ok) return;
    await pool.query(
      `UPDATE envelopes SET delivered_at = now()
        WHERE id = $1 AND delivered_at IS NULL`,
      [row.id]
    );
  }
}

async function handleEnvelope(ws, userId, msg) {
  const { id, recipientUserId, ciphertext, sentAt } = msg;

  if (typeof id !== 'string' || id.length === 0) {
    return ws.send(JSON.stringify({ type: 'error', status: 400, error: 'invalid id' }));
  }
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
    return ws.send(JSON.stringify({ type: 'error', status: 400, error: 'invalid ciphertext' }));
  }
  if (typeof sentAt !== 'string') {
    return ws.send(JSON.stringify({ type: 'error', status: 400, error: 'invalid sentAt' }));
  }
  const sentAtDate = new Date(sentAt);
  if (isNaN(sentAtDate.getTime())) {
    return ws.send(JSON.stringify({ type: 'error', status: 400, error: 'invalid sentAt' }));
  }

  const recipient = canonicalizeUserId(recipientUserId);
  if (!recipient) {
    return ws.send(JSON.stringify({ type: 'error', status: 400, error: 'invalid recipientUserId' }));
  }

  const ctext = Buffer.from(ciphertext, 'base64');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const dev = await client.query(
      'SELECT device_id FROM devices WHERE user_id = $1',
      [recipient]
    );
    if (dev.rowCount === 0) {
      await client.query('ROLLBACK');
      return ws.send(JSON.stringify({ type: 'error', status: 400, error: 'unknown recipient' }));
    }
    const recipientDeviceId = dev.rows[0].device_id;

    await client.query(
      `INSERT INTO envelopes
         (id, sender_user_id, recipient_user_id, recipient_device_id,
          ciphertext, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [id, userId, recipient, recipientDeviceId, ctext, sentAtDate]
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('WS envelope insert failed:', e);
    return ws.send(JSON.stringify({ type: 'error', status: 400, error: e.message || 'bad request' }));
  } finally {
    client.release();
  }

  try { ws.send(JSON.stringify({ type: 'ack', id })); } catch {}

  await withUserLock(recipient, async () => {
    const set = getUserSockets(recipient);
    console.log('[ws] deliver to', recipient, 'sockets=', set.size);
    if (set.size === 0) return;

    const { rows } = await pool.query(
      `SELECT id, sender_user_id, recipient_user_id, recipient_device_id,
              ciphertext, sent_at
         FROM envelopes
        WHERE id = $1 AND delivered_at IS NULL`,
      [id]
    );
    if (rows.length === 0) return;

    const row = rows[0];
    const frame = {
      type: 'envelope',
      id: row.id,
      senderUserId: row.sender_user_id,
      recipientUserId: row.recipient_user_id,
      ciphertext: Buffer.isBuffer(row.ciphertext)
        ? row.ciphertext.toString('base64')
        : row.ciphertext,
      sentAt: row.sent_at.toISOString(),
    };

    const result = sendToUser(recipient, frame);
    if (result.ok) {
      await pool.query(
        `UPDATE envelopes SET delivered_at = now()
          WHERE id = $1 AND delivered_at IS NULL`,
        [row.id]
      );
    }
  });
}

function attachWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/v1/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const authHeader = req.headers['authorization'] || '';
    const m = authHeader.match(/^Bearer\s+(.+)$/i);

    if (m) {
      const payload = verifyAccessToken(m[1]);
      if (!payload || typeof payload.sub !== 'string') {
        socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n');
        socket.write(JSON.stringify({ type: 'error', status: 401, error: 'invalid access token' }));
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        onAuthed(ws, payload.sub);
      });
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      let authed = false;
      const timer = setTimeout(() => {
        if (!authed) closeWithError(ws, 401, 'invalid access token');
      }, AUTH_TIMEOUT_MS);

      ws.once('message', (data) => {
        if (authed) return;
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type !== 'auth' || typeof msg.accessToken !== 'string') {
            clearTimeout(timer);
            return closeWithError(ws, 401, 'invalid access token');
          }
          const payload = verifyAccessToken(msg.accessToken);
          if (!payload || typeof payload.sub !== 'string') {
            clearTimeout(timer);
            return closeWithError(ws, 401, 'invalid access token');
          }
          authed = true;
          clearTimeout(timer);
          onAuthed(ws, payload.sub);
        } catch {
          clearTimeout(timer);
          closeWithError(ws, 401, 'invalid access token');
        }
      });

      ws.on('close', () => clearTimeout(timer));
    });
  });

  function onAuthed(ws, userId) {
    withUserLock(userId, async () => {
      // Сокет должен быть в Map во время выдачи очереди, чтобы sendToUser его нашёл.
      // Живой рассылки во время выдачи не будет: handleEnvelope для этого userId
      // ждёт на withUserLock.
      addSocket(userId, ws);
      await deliverQueue(userId);
    }).catch((e) => {
      console.error('WS onAuthed failed:', e);
      try { ws.close(1011, 'server error'); } catch {}
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'envelope') {
        handleEnvelope(ws, userId, msg).catch((e) => {
          console.error('WS handleEnvelope failed:', e);
        });
      }
    });

    ws.on('close', () => removeSocket(userId, ws));
    ws.on('error', () => removeSocket(userId, ws));
  }

  return wss;
}

module.exports = { attachWebSocket };
