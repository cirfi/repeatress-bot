CREATE DATABASE repeatress;

\c repeatress;

CREATE TABLE config (
  id SERIAL PRIMARY KEY,
  chat_id VARCHAR(32),
  threshold SMALLINT,
  timeout SMALLINT,
  timezone SMALLINT DEFAULT 0
);
CREATE UNIQUE INDEX ON config (chat_id);

CREATE TABLE message (
  id SERIAL PRIMARY KEY,
  chat_id VARCHAR(32),
  fwd_msg_id BIGINT,
  msg_id BIGINT,
  content VARCHAR(4096),
  create_time TIMESTAMPTZ
);
CREATE INDEX ON message (chat_id);
CREATE UNIQUE INDEX ON message (chat_id, fwd_msg_id);
CREATE UNIQUE INDEX ON message (chat_id, msg_id);
CREATE INDEX ON message (chat_id, create_time);
