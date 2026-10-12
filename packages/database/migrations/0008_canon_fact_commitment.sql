-- spec §4.3: コミットメント状態 (確度) と開示ポリシーを canon_facts に追加。
-- commitment/disclosure はリビジョン行の一部なので既存行は既定値で埋める。
ALTER TABLE canon_facts ADD COLUMN commitment TEXT NOT NULL DEFAULT 'fixed';
--> statement-breakpoint
ALTER TABLE canon_facts ADD COLUMN disclosure TEXT NOT NULL DEFAULT 'normal';
--> statement-breakpoint
-- 互換: 旧来の provenance='secret' 約束を disclosure カラムへ移す。
UPDATE canon_facts SET disclosure = 'secret' WHERE provenance = 'secret';
