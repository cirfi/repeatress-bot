CREATE DATABASE repeatress;

\c repeatress;

CREATE TABLE config (
  id SERIAL PRIMARY KEY,
  chat_id VARCHAR(32),
  threshold smallint,
  timeout smallint,
  timezone VARCHAR(32) DEFAULT 'Asia/Shanghai'
);
CREATE UNIQUE INDEX ON config (chat_id);

CREATE TABLE message (
  id SERIAL PRIMARY KEY,
  chat_id VARCHAR(32),
  msg_id bigint,
  content VARCHAR(4096),
  create_time TIMESTAMPTZ
);
CREATE INDEX ON message (chat_id);
CREATE UNIQUE INDEX ON message (chat_id, msg_id);
CREATE INDEX ON message (chat_id, create_time);
