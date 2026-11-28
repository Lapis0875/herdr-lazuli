-- One ACP row whose model_config is not JSON, applied after k6-seed.sql to a
-- second .backup copy (/tmp/lz-s9/state-copy2.db), never to the live DB.
INSERT INTO sessions (id, source, model, model_config, started_at, message_count, api_call_count, archived)
VALUES ('aaaaaaaa-0000-4000-8000-000000000006','acp','gpt-5.5','not json',1795000500,1,0,0);
INSERT INTO messages (session_id, role, content, timestamp)
VALUES ('aaaaaaaa-0000-4000-8000-000000000006','user','malformed',1795000510);
