'use strict';

const BASE = 'http://localhost:3000';
const WS_URL = 'ws://localhost:3000/v1/ws';

const RUN = Date.now().toString(36);
const ID = (base) => base + '_' + RUN;

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('  OK:', msg);
  else { console.error('  FAIL:', msg); failures++; }
}

async function http(path, method = 'GET', body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function createDevice(regId, keyPrefix, prekeyCount = 1) {
  const prekeys = [];
  for (let i = 1; i <= prekeyCount; i++) {
    prekeys.push({ keyId: i, publicKey: keyPrefix + '-k' + i });
  }
  const body = {
    registrationId: regId,
    identityPublicKey: keyPrefix + '-identity',
    signedPreKey: { keyId: 1, publicKey: keyPrefix + '-spk', signature: keyPrefix + '-sig' },
    oneTimePreKeys: prekeys,
  };
  const r = await http('/v1/devices', 'POST', body);
  if (r.status !== 201) throw new Error('createDevice failed: ' + r.text);
  return r.json;
}

function openWs(token, sendAuthFrame) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, {
      headers: token ? { Authorization: 'Bearer ' + token } : undefined,
    });
    const frames = [];
    const waiters = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].predicate(msg)) {
          const w = waiters.splice(i, 1)[0];
          clearTimeout(w.timer);
          w.resolve(msg);
          return;
        }
      }
      frames.push(msg);
    });
    function waitFrame(predicate, timeoutMs = 5000) {
      for (let i = 0; i < frames.length; i++) {
        if (predicate(frames[i])) return Promise.resolve(frames.splice(i, 1)[0]);
      }
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex(w => w.resolve === res);
          if (idx >= 0) waiters.splice(idx, 1);
          rej(new Error('timeout waiting for frame'));
        }, timeoutMs);
        waiters.push({ predicate, resolve: res, reject: rej, timer });
      });
    }
    ws.onopen = () => {
      if (sendAuthFrame) ws.send(JSON.stringify({ type: 'auth', accessToken: sendAuthFrame }));
      resolve({ ws, waitFrame, frames });
    };
    ws.onerror = () => reject(new Error('ws error on open'));
  });
}

async function testParallelBundle() {
  console.log('\n=== B1: parallel GET /v1/keys/bundle ===');
  const N = 5;
  const receiver = await createDevice(5001, 'recv', N);
  const sender = await createDevice(5002, 'send');

  const results = await Promise.all(
    Array.from({ length: N }, () =>
      http('/v1/keys/bundle/' + encodeURIComponent(receiver.userId), 'GET', null, sender.accessToken)
    )
  );

  const statuses = results.map(r => r.status);
  assert(statuses.every(s => s === 200), 'все ' + N + ' запросов — 200 (got: ' + statuses.join(',') + ')');

  const keyIds = results.map(r => r.json && r.json.oneTimePreKey && r.json.oneTimePreKey.keyId);
  const uniqueKeyIds = new Set(keyIds);
  assert(uniqueKeyIds.size === N, 'получено ' + N + ' разных keyId (got: ' + keyIds.join(',') + ')');

  const extra = await http('/v1/keys/bundle/' + encodeURIComponent(receiver.userId), 'GET', null, sender.accessToken);
  assert(extra.status === 409, 'после исчерпания пула — 409 (got: ' + extra.status + ')');
  assert(extra.json && extra.json.error === 'one-time prekeys exhausted', 'error: one-time prekeys exhausted');
}

async function testParallelRefresh() {
  console.log('\n=== B2: parallel POST /v1/sessions/refresh ===');
  const dev = await createDevice(5003, 'rf');
  const oldRefresh = dev.refreshToken;

  const [r1, r2] = await Promise.all([
    http('/v1/sessions/refresh', 'POST', { refreshToken: oldRefresh }),
    http('/v1/sessions/refresh', 'POST', { refreshToken: oldRefresh }),
  ]);

  const statuses = [r1.status, r2.status].sort();
  assert(statuses[0] === 200 && statuses[1] === 401,
         'ровно один 200 и один 401 (got: ' + statuses.join(',') + ')');

  const winner = r1.status === 200 ? r1 : r2;
  const loser  = r1.status === 401 ? r1 : r2;
  assert(loser.json && loser.json.error === 'invalid refresh token',
         'у проигравшего — invalid refresh token');

  const r3 = await http('/v1/sessions/refresh', 'POST', { refreshToken: oldRefresh });
  assert(r3.status === 401, 'повтор старого — 401 (got: ' + r3.status + ')');

  const r4 = await http('/v1/sessions/refresh', 'POST', { refreshToken: winner.json.refreshToken });
  assert(r4.status === 200, 'новый refresh работает (got: ' + r4.status + ')');
}

async function testParallelEnvelope() {
  console.log('\n=== B3: parallel envelope with same id ===');
  const A = await createDevice(5004, 'a');
  const B = await createDevice(5005, 'b');

  const connA = await openWs(A.accessToken);
  const connB = await openWs(B.accessToken);

  const envId = ID('env_dup');
  const frame = {
    type: 'envelope', id: envId,
    recipientUserId: B.userId, ciphertext: 'cGFyYWxsZWw=',
    sentAt: new Date().toISOString(),
  };

  connA.ws.send(JSON.stringify(frame));
  connA.ws.send(JSON.stringify(frame));

  const ack1 = await connA.waitFrame(m => m.type === 'ack' && m.id === envId);
  const ack2 = await connA.waitFrame(m => m.type === 'ack' && m.id === envId);
  assert(!!ack1 && !!ack2, 'A получил два ack');

  const envB = await connB.waitFrame(m => m.type === 'envelope' && m.id === envId);
  assert(!!envB, 'B получил один кадр');

  let secondFrame = null;
  try {
    secondFrame = await connB.waitFrame(m => m.type === 'envelope' && m.id === envId, 500);
  } catch {}
  assert(secondFrame === null, 'B не получил второй кадр');

  connA.ws.close();
  connB.ws.close();
}

(async () => {
  console.log('RUN =', RUN);
  try {
    await testParallelBundle();
    await testParallelRefresh();
    await testParallelEnvelope();
  } catch (e) {
    console.error('TEST CRASHED:', e);
    failures++;
  }

  console.log('\n---');
  if (failures === 0) {
    console.log('ALL CONCURRENCY TESTS PASSED');
    setTimeout(() => process.exit(0), 300);
  } else {
    console.error('FAILURES:', failures);
    setTimeout(() => process.exit(1), 300);
  }
})();
