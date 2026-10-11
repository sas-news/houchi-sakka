-- spec gap-fill: charter/policy を変える update_work op 適用時に、
-- 適用前の works.charter/policy を {charter, policy} の JSON で退避する
-- (docs/gaps.md「変更前スナップショットの保持」)。
ALTER TABLE change_sets ADD COLUMN prev_settings TEXT;
