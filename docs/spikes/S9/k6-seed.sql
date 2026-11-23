-- Synthetic rows for the S9 SESSIONS_SQL check. Applied ONLY to a .backup copy
-- (/tmp/lz-s9/state-copy.db) of ~/.hermes/state.db, never to the live DB.
-- Ids end in the case they cover; 06 (malformed model_config) is k6-seed-malformed.sql.
INSERT INTO sessions (id, source, model, model_config, started_at, message_count, input_tokens, output_tokens, estimated_cost_usd, cost_status, api_call_count, title, archived, parent_session_id, end_reason, ended_at) VALUES
 ('aaaaaaaa-0000-4000-8000-000000000001','acp','gpt-5.5','{"cwd": "/tmp/lz-s9-folder", "provider": "openai-codex"}',1795000000,2,100,50,0.01,'estimated',1,NULL,0,NULL,NULL,NULL),
 ('aaaaaaaa-0000-4000-8000-000000000002','acp','gpt-5.5','{"cwd": "/tmp/lz-s9-folder/"}',1795000100,1,0,0,NULL,NULL,0,'Named session',0,NULL,NULL,NULL),
 ('aaaaaaaa-0000-4000-8000-000000000003','acp','gpt-5.5','{"cwd": "/tmp/lz-s9-folder", "_delegate_from": "aaaaaaaa-0000-4000-8000-000000000001"}',1795000200,1,0,0,NULL,NULL,0,NULL,0,'aaaaaaaa-0000-4000-8000-000000000001',NULL,NULL),
 ('aaaaaaaa-0000-4000-8000-000000000004','acp','gpt-5.5','{"cwd": "/tmp/lz-s9-folder", "_branched_from": "aaaaaaaa-0000-4000-8000-000000000001"}',1795000300,1,0,0,NULL,NULL,0,NULL,0,'aaaaaaaa-0000-4000-8000-000000000001',NULL,NULL),
 ('aaaaaaaa-0000-4000-8000-000000000005','acp','gpt-5.5','{"cwd": "/tmp/lz-s9-folder"}',1795000400,1,0,0,NULL,NULL,0,NULL,1,NULL,NULL,NULL),
 ('aaaaaaaa-0000-4000-8000-000000000007','cli','gpt-5.5','{"cwd": "/tmp/lz-s9-folder"}',1795000600,1,0,0,NULL,NULL,0,NULL,0,NULL,NULL,NULL),
 ('aaaaaaaa-0000-4000-8000-000000000008','acp','gpt-5.5','{"cwd": "/tmp/lz-s9-folder"}',1795000700,1,0,0,NULL,NULL,0,NULL,0,NULL,NULL,NULL),
 ('aaaaaaaa-0000-4000-8000-000000000009','acp','gpt-5.5','{"cwd": "/tmp/lz-s9-folder"}',1795000800,0,0,0,NULL,NULL,0,NULL,0,NULL,NULL,NULL),
 ('aaaaaaaa-0000-4000-8000-00000000000a','acp','gpt-5.5','{"cwd": "/tmp/lz-s9-folder"}',1795000900,2,0,0,NULL,NULL,0,'Compressed root',0,NULL,'compression',1795000950),
 ('aaaaaaaa-0000-4000-8000-00000000000b','acp','gpt-5.5','{"cwd": "/tmp/lz-s9-folder"}',1795000960,1,0,0,NULL,NULL,0,'Compression tip',0,'aaaaaaaa-0000-4000-8000-00000000000a',NULL,NULL),
 ('aaaaaaaa-0000-4000-8000-00000000000c','acp','gpt-5.5','{"cwd": "/tmp/other-folder"}',1795001000,1,0,0,NULL,NULL,0,NULL,0,NULL,NULL,NULL);
INSERT INTO messages (session_id, role, content, timestamp) VALUES
 ('aaaaaaaa-0000-4000-8000-000000000001','user','first line' || char(10) || 'second line of a first user message that is longer than sixty characters',1795000010),
 ('aaaaaaaa-0000-4000-8000-000000000001','assistant','answer',1795000020),
 ('aaaaaaaa-0000-4000-8000-000000000002','user','hello named',1795000110),
 ('aaaaaaaa-0000-4000-8000-000000000003','user','delegate',1795000210),
 ('aaaaaaaa-0000-4000-8000-000000000004','user','branch',1795000310),
 ('aaaaaaaa-0000-4000-8000-000000000005','user','archived',1795000410),
 ('aaaaaaaa-0000-4000-8000-000000000007','user','cli',1795000610),
 ('aaaaaaaa-0000-4000-8000-000000000008','assistant','assistant only',1795000710),
 ('aaaaaaaa-0000-4000-8000-00000000000a','user','root',1795000910),
 ('aaaaaaaa-0000-4000-8000-00000000000a','assistant','root answer',1795000920),
 ('aaaaaaaa-0000-4000-8000-00000000000b','user','tip',1795000970),
 ('aaaaaaaa-0000-4000-8000-00000000000c','user','other folder',1795001010);
