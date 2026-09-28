'use strict';

require('dotenv').config();

const http = require('http');
const express = require('express');
const { attachWebSocket } = require('./ws');

const devicesRouter = require('./routes/devices');
const sessionsRouter = require('./routes/sessions');
const keysRouter = require('./routes/keys');

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use(devicesRouter);
app.use(sessionsRouter);
app.use(keysRouter);

app.use((_req, res) => res.status(400).json({ error: 'not found' }));

app.use((err, _req, res, _next) => {
  console.error('unhandled:', err);
  res.status(400).json({ error: err.message || 'bad request' });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const server = http.createServer(app);
attachWebSocket(server);

server.listen(PORT, () => {
  console.log('HTTP+WS listening on http://localhost:' + PORT);
});
