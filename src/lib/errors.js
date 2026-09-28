'use strict';

// Базовый ответ-ошибка. Стек-трейсы не отдаём.
function sendError(res, status, message) {
  res.status(status).json({ error: message });
}

// Уже зафиксированные тексты из контракта.
const Errors = {
  invalidRefreshToken: 'invalid refresh token',
  oneTimePrekeysExhausted: 'one-time prekeys exhausted',
  invalidAccessToken: 'invalid access token',
};

module.exports = { sendError, Errors };
