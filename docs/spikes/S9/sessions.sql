SELECT
  s.id AS id,
  s.title AS title,
  COALESCE((SELECT SUBSTR(REPLACE(REPLACE(m.content, X'0A', ' '), X'0D', ' '), 1, 63)
            FROM messages m
            WHERE m.session_id = s.id AND m.role = 'user' AND m.content IS NOT NULL
            ORDER BY m.timestamp, m.id LIMIT 1), '') AS preview,
  CASE WHEN json_valid(s.model_config) THEN json_extract(s.model_config, '$.cwd') END AS cwd,
  s.model AS model,
  s.message_count AS message_count,
  s.started_at AS started_at,
  COALESCE((SELECT MAX(m2.timestamp) FROM messages m2 WHERE m2.session_id = s.id), s.started_at) AS last_active,
  s.input_tokens AS input_tokens,
  s.output_tokens AS output_tokens,
  s.cache_read_tokens AS cache_read_tokens,
  s.cache_write_tokens AS cache_write_tokens,
  s.reasoning_tokens AS reasoning_tokens,
  s.estimated_cost_usd AS estimated_cost_usd,
  s.actual_cost_usd AS actual_cost_usd,
  s.cost_status AS cost_status,
  s.api_call_count AS api_call_count
FROM sessions s
WHERE s.source = 'acp'
  AND s.message_count > 0
  AND s.archived = 0
  AND (s.parent_session_id IS NULL
       OR (json_valid(s.model_config) AND json_extract(s.model_config, '$._branched_from') IS NOT NULL)
       OR EXISTS (SELECT 1 FROM sessions p
                  WHERE p.id = s.parent_session_id AND p.end_reason = 'branched'
                    AND s.started_at >= p.ended_at))
  AND NOT (json_valid(s.model_config) AND json_extract(s.model_config, '$._delegate_from') IS NOT NULL)
ORDER BY last_active DESC, s.id DESC
LIMIT 1000;
