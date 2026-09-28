'use strict';

const sockets = new Map();
const locks   = new Map();

function getUserSockets(userId) {
  return sockets.get(userId) || new Set();
}

function addSocket(userId, ws) {
  let set = sockets.get(userId);
  if (!set) {
    set = new Set();
    sockets.set(userId, set);
  }
  set.add(ws);
  console.log('[hub] addSocket', userId, 'size=', set.size);
}

function removeSocket(userId, ws) {
  const set = sockets.get(userId);
  if (!set) return;
  set.delete(ws);
  console.log('[hub] removeSocket', userId, 'size=', set.size);
  if (set.size === 0) sockets.delete(userId);
}

function withUserLock(userId, fn) {
  const prev = locks.get(userId) || Promise.resolve();
  let release;
  const next = new Promise((res) => { release = res; });
  const waitForPrev = prev.then(() => next);
  locks.set(userId, waitForPrev);
  console.log('[hub] lock ENTER', userId);
  return prev.then(async () => {
    try {
      const r = await fn();
      return r;
    } finally {
      release();
      console.log('[hub] lock EXIT', userId);
      if (locks.get(userId) === waitForPrev) locks.delete(userId);
    }
  });
}

function sendToUser(userId, frame) {
  const set = sockets.get(userId);
  if (!set || set.size === 0) {
    console.log('[hub] sendToUser', userId, 'NO SOCKETS');
    return { ok: false, sent: 0, failed: 0, noSockets: true };
  }
  const payload = JSON.stringify(frame);
  let sent = 0, failed = 0;
  for (const ws of Array.from(set)) {
    try {
      console.log('[hub] sendToUser check', userId,
                  'readyState=', ws.readyState, 'OPEN=', ws.OPEN);
      if (ws.readyState !== ws.OPEN) {
        throw new Error('not open: readyState=' + ws.readyState + ' OPEN=' + ws.OPEN);
      }
      ws.send(payload, (err) => {
        if (err) console.log('[hub] send cb ERR', err.message);
        else console.log('[hub] send cb OK');
      });
      sent++;
    } catch (e) {
      failed++;
      set.delete(ws);
      console.log('[hub] sendToUser FAILED:', e.message);
      try { ws.terminate(); } catch {}
    }
  }
  if (set.size === 0) sockets.delete(userId);
  console.log('[hub] sendToUser result', userId, { sent, failed });
  return { ok: failed === 0 && sent > 0, sent, failed, noSockets: false };
}

module.exports = {
  getUserSockets,
  addSocket,
  removeSocket,
  withUserLock,
  sendToUser,
};
