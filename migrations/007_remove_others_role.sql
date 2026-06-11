-- Migration 007: Remove the 'others' role
-- Recorders are now either moderators or evaluators. Demote any existing
-- 'others' users to 'evaluator' (the lower-privilege of the two).

UPDATE dashboard_users SET role = 'evaluator' WHERE role = 'others';
