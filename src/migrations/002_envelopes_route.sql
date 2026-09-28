-- 002_envelopes_route.sql
-- Добавляем маршрутизацию на устройство получателя.

ALTER TABLE envelopes
  ADD COLUMN IF NOT EXISTS recipient_device_id TEXT NOT NULL DEFAULT 'device_1';
