import { diffLines } from "diff";

/** 差分行の種別。same=共通 / added=比較先で追加 / removed=比較元から削除。 */
export type DiffRowKind = "same" | "added" | "removed";

export interface DiffRow {
  kind: DiffRowKind;
  text: string;
}

/**
 * 段落配列どうしの行単位差分 (本文リビジョン比較用)。
 * 1段落=1行として jsdiff の行単位 diff を取り、表示用の行列に展開する。
 */
export function diffParagraphs(before: string[], after: string[]): DiffRow[] {
  // 末尾に改行を付けて揃える (片側だけ末尾改行が無いと、最終行が
  // 「改行の有無の差」として誤判定される)
  const toText = (paras: string[]) =>
    paras.length === 0 ? "" : `${paras.join("\n")}\n`;
  const parts = diffLines(toText(before), toText(after));
  const rows: DiffRow[] = [];
  for (const part of parts) {
    const kind: DiffRowKind = part.added
      ? "added"
      : part.removed
        ? "removed"
        : "same";
    // 各行は末尾改行つきで入るので split の最後の空要素を捨てる
    const lines = part.value.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (const text of lines) {
      rows.push({ kind, text });
    }
  }
  return rows;
}
