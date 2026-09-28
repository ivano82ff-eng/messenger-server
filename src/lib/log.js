'use strict';

const DEBUG_WS = process.env.DEBUG_WS === '1';

function wsLog(...args) {
  if (DEBUG_WS) console.log('[ws]', ...args);
}

function wsError(...args) {
  console.error('[ws]', ...args);
}

module.exports = { wsLog, wsError, DEBUG_WS };
