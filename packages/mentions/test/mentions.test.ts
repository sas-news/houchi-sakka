import { describe, expect, it } from "vitest";
import { detectEntityMentionHits, detectEntityMentions } from "../src/index.js";

const akira = { id: "e1", name: "アキラ", aliases: ["暁", "アキ"] };
const misaki = { id: "e2", name: "美咲", aliases: ["ミサ"] };
const school = { id: "e3", name: "白鷺高校", aliases: [] };

describe("detectEntityMentions", () => {
  it("名前・別名の部分一致で entity_id を返す", () => {
    const text = "アキラは美咲に手を振った。";
    expect(detectEntityMentions(text, [akira, misaki, school])).toEqual([
      "e1",
      "e2",
    ]);
  });

  it("別名でもヒットする (表記揺れ・愛称)", () => {
    const text = "暁はため息をつき、ミサはうなずいた。";
    expect(detectEntityMentions(text, [akira, misaki])).toEqual(["e1", "e2"]);
  });

  it("全角/半角・記号を正規化して照合する", () => {
    const text = "ＡＫＩＲＡ…そいつは暁と呼ばれる。";
    expect(detectEntityMentions(text, [akira])).toEqual(["e1"]);
  });

  it("重複する言及は1回だけ数える (name+alias 両ヒットでも1件)", () => {
    const text = "アキラ、いや暁と呼ぶべきか。";
    expect(detectEntityMentions(text, [akira])).toEqual(["e1"]);
    const hits = detectEntityMentionHits(text, [akira]);
    expect(hits).toHaveLength(1);
  });

  it("言及がなければ空配列", () => {
    expect(detectEntityMentions("誰もいない部屋。", [akira, school])).toEqual(
      [],
    );
  });

  it("空パターン・空本文は安全に無視する", () => {
    expect(
      detectEntityMentions("アキラ。", [{ id: "x", name: " ", aliases: [] }]),
    ).toEqual([]);
    expect(detectEntityMentions("", [akira])).toEqual([]);
  });
});
