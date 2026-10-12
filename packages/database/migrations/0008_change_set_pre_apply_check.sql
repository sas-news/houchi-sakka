-- spec §5.3 step 6-8 適用前検証 (verify-then-commit):
-- 通常承認の直前に走らせた検査の結果を
-- {checked_at, warnings, violations} の JSON で残す。
ALTER TABLE change_sets ADD COLUMN pre_apply_check TEXT;
