-- Phase spec gap-fill: 強制適用の理由記録 (spec §5.4) と
-- 楽観的競合検出用の base_rev (spec §8.3)。
ALTER TABLE change_sets ADD COLUMN force_reason TEXT;
ALTER TABLE change_sets ADD COLUMN base_rev INTEGER;
