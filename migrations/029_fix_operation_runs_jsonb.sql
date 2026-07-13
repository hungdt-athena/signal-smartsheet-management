-- 029_fix_operation_runs_jsonb.sql
-- Repair operation_runs rows whose params/snapshot/result were stored double-encoded.
-- Root cause: the insert/resolve routes bound JSONB with `${JSON.stringify(x)}::jsonb`,
-- but postgres.js already serializes a value bound to a JSONB column — so the value
-- landed as a JSON *string* (jsonb_typeof = 'string') instead of an object. That made
-- snapshot.per_evaluator undefined and crashed the Team Operations "Details" popup.
-- The write sites are fixed to use sql.json(); this repairs the already-stored rows by
-- extracting the inner text (#>> '{}') and re-parsing it as jsonb.

UPDATE operation_runs SET params   = (params   #>> '{}')::jsonb WHERE jsonb_typeof(params)   = 'string';
UPDATE operation_runs SET snapshot = (snapshot #>> '{}')::jsonb WHERE jsonb_typeof(snapshot) = 'string';
UPDATE operation_runs SET result   = (result   #>> '{}')::jsonb WHERE result IS NOT NULL AND jsonb_typeof(result) = 'string';
