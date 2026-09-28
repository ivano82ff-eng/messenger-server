'use strict';

// Приводит строку к каноническому виду userId.
// Возвращает канон или null, если строка каноном быть не может.
function canonicalizeUserId(input) {
  if (typeof input !== 'string') return null;

  const collapsed = input.trim().replace(/\s+/g, ' ').toUpperCase();
  if (!/^[0-9]{3} [A-Z] [0-9]{3}$/.test(collapsed)) return null;

  return collapsed;
}

// Генератор новых userId: три цифры, пробел, буква A-Z, пробел, три цифры.
function generateUserId() {
  const digits1 = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  const letter  = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  const digits2 = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  return `${digits1} ${letter} ${digits2}`;
}

module.exports = { canonicalizeUserId, generateUserId };
