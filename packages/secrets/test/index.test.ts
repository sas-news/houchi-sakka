import { describe, expect, it } from "vitest";
import {
  DecryptError,
  InvalidKeyError,
  decrypt,
  encrypt,
  secretsEqual,
} from "../src/index.js";

const KEY = btoa("0123456789abcdef0123456789abcdef"); // 32 bytes
const KEY2 = btoa("fedcba9876543210fedcba9876543210");

describe("secrets", () => {
  it("encrypt/decrypt が往復する", async () => {
    const ct = await encrypt("sk-live-secret", KEY);
    expect(ct).toMatch(/^[^.]+\.[^.]+$/);
    expect(await decrypt(ct, KEY)).toBe("sk-live-secret");
  });

  it("同じ平文でも IV が違うので暗号文が違う", async () => {
    const a = await encrypt("same", KEY);
    const b = await encrypt("same", KEY);
    expect(a).not.toBe(b);
    expect(a.split(".")[0]).not.toBe(b.split(".")[0]);
  });

  it("改ざんを検出する", async () => {
    const ct = await encrypt("secret", KEY);
    const [iv, data] = ct.split(".");
    const raw = atob(data!);
    const tampered = `${iv}.${btoa(`${raw.slice(0, -2)}${raw.endsWith("a") ? "b" : "a"}a`)}`;
    await expect(decrypt(tampered, KEY)).rejects.toBeInstanceOf(DecryptError);
  });

  it("別鍵での復号は DecryptError", async () => {
    const ct = await encrypt("secret", KEY);
    await expect(decrypt(ct, KEY2)).rejects.toBeInstanceOf(DecryptError);
  });

  it("形式不正は DecryptError", async () => {
    await expect(decrypt("not-base64-blob", KEY)).rejects.toBeInstanceOf(
      DecryptError,
    );
  });

  it("鍵が 32 バイトでなければ InvalidKeyError。平文や鍵値を含まない", async () => {
    const short = btoa("short");
    try {
      await encrypt("x", short);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidKeyError);
      expect((e as Error).message).not.toContain(short);
    }
  });

  it("DecryptError のメッセージに秘密情報を含まない", async () => {
    const ct = await encrypt("topsecretvalue", KEY);
    try {
      await decrypt(ct, KEY2);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("topsecretvalue");
    }
  });

  it("secretsEqual は一致/不一致を返す", async () => {
    expect(await secretsEqual("abc", "abc")).toBe(true);
    expect(await secretsEqual("abc", "abd")).toBe(false);
    expect(await secretsEqual("abc", "abcd")).toBe(false);
  });
});
