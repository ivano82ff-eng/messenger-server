'use strict';

const BASE = 'http://localhost:3000';
const WS_URL = 'ws://localhost:3000/v1/ws';

const RUN = Date.now().toString(36);
const ID = (base) => base + '_' + RUN;

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

async function createDevice(regId, keyPrefix) {
  const body = {
    registrationId: regId,
    identityPublicKey: keyPrefix + '-identity',
    signedPreKey: { keyId: 1, publicKey: keyPrefix + '-spk', signature: keyPrefix + '-sig' },
    oneTimePreKeys: [{ keyId: 1, publicKey: keyPrefix + '-k1' }],
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
    const frameWaiters = [];
    let closeEvent = null;
    const closeWaiters = [];

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      for (let i = 0; i < frameWaiters.length; i++) {
        const w = frameWaiters[i];
        if (w.predicate(msg)) {
          frameWaiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(msg);
          return;
        }
      }
      frames.push(msg);
    });

    ws.addEventListener('close', (ev) => {
      closeEvent = ev;
      while (closeWaiters.length) {
        const w = closeWaiters.shift();
        clearTimeout(w.timer);
        w.resolve(ev);
      }
    });

    function waitFrame(predicate, timeoutMs = 5000) {
      for (let i = 0; i < frames.length; i++) {
        if (predicate(frames[i])) return Promise.resolve(frames.splice(i, 1)[0]);
      }
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          const idx = frameWaiters.findIndex(w => w.resolve === res);
          if (idx >= 0) frameWaiters.splice(idx, 1);
          rej(new Error('timeout waiting for frame'));
        }, timeoutMs);
        frameWaiters.push({ predicate, resolve: res, reject: rej, timer });
      });
    }

    function waitClose(timeoutMs = 5000) {
      if (closeEvent) return Promise.resolve(closeEvent);
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('timeout waiting for close')), timeoutMs);
        closeWaiters.push({ resolve: res, reject: rej, timer });
      });
    }

    ws.onopen = () => {
      if (sendAuthFrame) {
        ws.send(JSON.stringify({ type: 'auth', accessToken: sendAuthFrame }));
      }
      resolve({ ws, waitFrame, waitClose, frames, get closeEvent() { return closeEvent; } });
    };
    ws.onerror = () => reject(new Error('ws error on open'));
  });
}

(async () => {
  console.log('RUN =', RUN);

  const A = await createDevice(4001, 'a');
  const B = await createDevice(4002, 'b');
  console.log('A =', A.userId, '| B =', B.userId);

  console.log('\n--- 1) bad Bearer on upgrade -> expect reject ---');
  try {
    await openWs('bad-token');
    console.log('FAIL: connected with bad token');
  } catch {
    console.log('OK: rejected');
  }

  console.log('\n--- 2) good Bearer on upgrade -> connect ---');
  const connA = await openWs(A.accessToken);
  console.log('OK: A connected');

  console.log('\n--- 3) no Bearer, first frame auth (good) -> connect ---');
  const connB = await openWs(null, B.accessToken);
  const env_b_to_a_1 = ID('env_b_to_a_1');
  connB.ws.send(JSON.stringify({
    type: 'envelope', id: env_b_to_a_1,
    recipientUserId: A.userId, ciphertext: 'aGVsbG8=',
    sentAt: new Date().toISOString(),
  }));
  const ackB = await connB.waitFrame(m => m.type === 'ack' && m.id === env_b_to_a_1);
  console.log('OK: B connected and got ack:', JSON.stringify(ackB));

  console.log('\n--- 4) no Bearer, first frame auth (bad) -> error + close ---');
  const connBad = await openWs(null, 'nonsense');
  const errFrame = await connBad.waitFrame(m => m.type === 'error', 5000);
  console.log('OK: got error frame:', JSON.stringify(errFrame));
  const closeEv = await connBad.waitClose(10000);
  console.log('OK: closed with code', closeEv.code);

  console.log('\n--- 5) envelope A->B (B online) ---');
  const env_a_to_b_online = ID('env_a_to_b_online');
  connA.ws.send(JSON.stringify({
    type: 'envelope', id: env_a_to_b_online,
    recipientUserId: B.userId, ciphertext: 'd29ybGQ=',
    sentAt: new Date().toISOString(),
  }));
  const ackA = await connA.waitFrame(m => m.type === 'ack' && m.id === env_a_to_b_online);
  console.log('OK: A got ack:', JSON.stringify(ackA));
  const envB = await connB.waitFrame(m => m.type === 'envelope' && m.id === env_a_to_b_online);
  console.log('OK: B received envelope:', JSON.stringify(envB));

  console.log('\n--- 6) envelope A->B (B offline) ---');
  connB.ws.close();
  await connB.waitClose();
  await new Promise(r => setTimeout(r, 300));

  const env_a_to_b_offline = ID('env_a_to_b_offline');
  connA.ws.send(JSON.stringify({
    type: 'envelope', id: env_a_to_b_offline,
    recipientUserId: B.userId, ciphertext: 'b2ZmbGluZQ==',
    sentAt: new Date().toISOString(),
  }));
  const ackA2 = await connA.waitFrame(m => m.type === 'ack' && m.id === env_a_to_b_offline);
  console.log('OK: A got ack (B offline):', JSON.stringify(ackA2));

  console.log('\n--- 7) B reconnects -> should get queued envelope ---');
  const connB2 = await openWs(B.accessToken);
  const envB2 = await connB2.waitFrame(m => m.type === 'envelope' && m.id === env_a_to_b_offline, 5000);
  console.log('OK: B received queued envelope:', JSON.stringify(envB2));

  console.log('\n--- 8) duplicate id from same sender ---');
  connA.ws.send(JSON.stringify({
    type: 'envelope', id: env_a_to_b_online,
    recipientUserId: B.userId, ciphertext: 'ZA==',
    sentAt: new Date().toISOString(),
  }));
  const ackDup = await connA.waitFrame(m => m.type === 'ack' && m.id === env_a_to_b_online);
  console.log('OK: duplicate got ack:', JSON.stringify(ackDup));

  console.log('\n--- 9) invalid recipientUserId (not canonical) ---');
  const env_bad_recipient = ID('env_bad_recipient');
  connA.ws.send(JSON.stringify({
    type: 'envelope', id: env_bad_recipient,
    recipientUserId: '456N634', ciphertext: 'ZA==',
    sentAt: new Date().toISOString(),
  }));
  const errBad = await connA.waitFrame(m => m.type === 'error');
  console.log('OK: got error frame:', JSON.stringify(errBad));

  console.log('\n--- 10) unknown recipient ---');
  const env_unknown_recipient = ID('env_unknown_recipient');
  connA.ws.send(JSON.stringify({
    type: 'envelope', id: env_unknown_recipient,
    recipientUserId: '999 Z 999', ciphertext: 'ZA==',
    sentAt: new Date().toISOString(),
  }));
  const errUnknown = await connA.waitFrame(m => m.type === 'error');
  console.log('OK: got error frame:', JSON.stringify(errUnknown));

  connA.ws.close();
  connB2.ws.close();
  console.log('\nALL TESTS DONE');
  setTimeout(() => process.exit(0), 500);
})().catch(e => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
