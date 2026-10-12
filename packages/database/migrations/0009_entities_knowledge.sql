-- spec §6.3-6.4 ナレッジトラッキング MVP:
-- StoryEntity (人物/場所/組織/物品/概念), EntityAlias (別名・表記揺れ),
-- fact_entities (正典とエンティティのリンク), KnowledgeEvent (誰が何を知った)。
--
-- fact_ref / entity_id は「リビジョン跨ぎの安定ID」:
-- 正典・エンティティは行がリビジョンで閉じ→新行挿入される時系列モデル
-- (valid_from_rev/valid_to_rev) だが、エンティティリンクや知識イベントは
-- 行 id ではなく安定IDを指すことで、文面の改定でリンクが切れないようにする。

-- canon_facts に安定ID fact_ref を追加 (既存行は行 id をそのまま採用)。
ALTER TABLE canon_facts ADD COLUMN fact_ref TEXT;
--> statement-breakpoint
UPDATE canon_facts SET fact_ref = id WHERE fact_ref IS NULL;
--> statement-breakpoint
CREATE INDEX canon_facts_fact_ref_idx ON canon_facts(fact_ref);
--> statement-breakpoint

-- 登場要素 (spec §6.4 StoryEntity)。
-- id はリビジョン行のPK、entity_id はリビジョンを跨ぐ安定ID。
CREATE TABLE story_entities (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  valid_from_rev INTEGER,
  valid_to_rev INTEGER,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX story_entities_work_idx ON story_entities(work_id);
--> statement-breakpoint
CREATE INDEX story_entities_entity_idx ON story_entities(entity_id);
--> statement-breakpoint
CREATE UNIQUE INDEX story_entities_work_kind_name_uq
  ON story_entities(work_id, kind, name) WHERE valid_to_rev IS NULL;
--> statement-breakpoint

-- 別名・表記揺れ・愛称 (EntityAlias)。entity_id (安定ID) 参照。
CREATE TABLE entity_aliases (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX entity_aliases_entity_idx ON entity_aliases(entity_id);
--> statement-breakpoint
CREATE UNIQUE INDEX entity_aliases_entity_alias_uq ON entity_aliases(entity_id, alias);
--> statement-breakpoint

-- 正典とエンティティのリンク (spec §6.4「自然言語文+関連エンティティ」)。
-- fact_ref (安定ID) で結ぶので正典の改定で切れない。
CREATE TABLE fact_entities (
  fact_ref TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (fact_ref, entity_id)
);
--> statement-breakpoint
CREATE INDEX fact_entities_entity_idx ON fact_entities(entity_id);
--> statement-breakpoint

-- 誰が何を・どこから知ったか (spec §6.4 KnowledgeEvent)。
-- entity_id=知った人物, fact_id=fact_ref (何を知った), scene_id=どこで (nullable),
-- source=情報源 (目撃/伝聞/推論/記述)。
CREATE TABLE knowledge_events (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  scene_id TEXT,
  source TEXT NOT NULL DEFAULT '記述',
  valid_from_rev INTEGER,
  valid_to_rev INTEGER,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX knowledge_events_work_idx ON knowledge_events(work_id);
--> statement-breakpoint
CREATE INDEX knowledge_events_entity_idx ON knowledge_events(entity_id);
--> statement-breakpoint
CREATE INDEX knowledge_events_fact_idx ON knowledge_events(fact_id);
