// ---------------------------------------------------------------------------
// @houchi/mentions — エンティティ言及の決定的検出 (spec §6.6 副経路)。
// エイリアス辞書で本文を走査し、言及されたエンティティの id を返す。
// 日本語テキストの単純部分一致 (正規化済み) で、長い別名を優先し、
// 重複する言及は1回だけ数える。
// ---------------------------------------------------------------------------

import { normalizeText } from "@houchi/validators";

/** 言及検出の対象エンティティ (id=安定ID, name+別名で本文照合)。 */
export interface MentionEntity {
  id: string;
  name: string;
  /** 別名・表記揺れ・愛称。 */
  aliases?: readonly string[];
}

export interface MentionHit {
  /** 言及されたエンティティの id (MentionEntity.id)。 */
  entity_id: string;
  /** 本文中に出た表記 (正規化後の照合パターン)。 */
  surface: string;
}

/**
 * 本文中のエンティティ言及を検出する。
 * - 各エンティティの name + aliases を正規化して部分一致判定
 * - 長い別名を先に試す (短い別名が長い表記の一部に被る誤検出を避ける)
 * - 同一エンティティの複数表記は最初にヒットしたものだけ記録する
 *
 * 戻り値: ヒットしたエンティティの id 一覧 (出現順・重複なし)。
 */
export function detectEntityMentions(
  text: string,
  entities: readonly MentionEntity[],
): string[] {
  return detectEntityMentionHits(text, entities).map((h) => h.entity_id);
}

/** detectEntityMentions の詳細版 (どの表記でヒットしたかも返す)。 */
export function detectEntityMentionHits(
  text: string,
  entities: readonly MentionEntity[],
): MentionHit[] {
  const normalizedText = normalizeText(text);
  if (normalizedText.length === 0) return [];
  const hits: MentionHit[] = [];
  for (const entity of entities) {
    const patterns = [entity.name, ...(entity.aliases ?? [])]
      .map((p) => ({ raw: p, normalized: normalizeText(p) }))
      .filter((p) => p.normalized.length > 0)
      // 長い別名を優先 (短い別名が長い表記の一部に被るのを防ぐ)。
      .sort((a, b) => b.normalized.length - a.normalized.length);
    const seen = new Set<string>();
    for (const p of patterns) {
      if (seen.has(p.normalized)) continue;
      seen.add(p.normalized);
      if (normalizedText.includes(p.normalized)) {
        hits.push({ entity_id: entity.id, surface: p.raw });
        break;
      }
    }
  }
  return hits;
}
