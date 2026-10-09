/**
 * packages/secrets — BYO API キーの暗号化境界層 (spec §9, AGENTS.md)。
 * AES-256-GCM。出力形式: base64(iv).base64(ciphertext+tag)。
 * Web Crypto を使うので Node.js / Cloudflare Workers 両方で動く。
 *
 * 注意: 平文キーを Error メッセージやログに含めないこと。
 */

export class SecretsError extends Error {
  override name = "SecretsError";
}

/** 復号失敗 (改ざん・鍵不一致・形式不正)。型付きエラーで返す。 */
export class DecryptError extends SecretsError {
  override name = "DecryptError";
}

/** 環境変数の鍵が不正 (base64 でない / 32 バイトでない)。 */
export class InvalidKeyError extends SecretsError {
  override name = "InvalidKeyError";
}

const KEY_BYTES = 32;
const IV_BYTES = 12;

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Node/Workers 両対応のため CryptoKey 名には依存せず importKey の戻り型を使う。 */
type ImportedKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** 鍵を例外メッセージに含めないよう、値ではなく長さのみ検証結果に反映する。 */
async function importKey(keyBase64: string): Promise<ImportedKey> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(keyBase64);
  } catch {
    throw new InvalidKeyError(
      "APP_SECRET_KEY must be a base64-encoded 32-byte key",
    );
  }
  if (bytes.length !== KEY_BYTES) {
    throw new InvalidKeyError(
      "APP_SECRET_KEY must be a base64-encoded 32-byte key",
    );
  }
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encrypt(
  plaintext: string,
  keyBase64: string,
): Promise<string> {
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  return `${toBase64(iv)}.${toBase64(ct)}`;
}

export async function decrypt(
  encoded: string,
  keyBase64: string,
): Promise<string> {
  const key = await importKey(keyBase64);
  const parts = encoded.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new DecryptError("malformed ciphertext");
  }
  let iv: Uint8Array<ArrayBuffer>;
  let data: Uint8Array<ArrayBuffer>;
  try {
    iv = fromBase64(parts[0]);
    data = fromBase64(parts[1]);
  } catch {
    throw new DecryptError("malformed ciphertext");
  }
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      data,
    );
    return new TextDecoder().decode(pt);
  } catch {
    // GCM タグ検証失敗など。内容は漏らさない。
    throw new DecryptError("decryption failed");
  }
}

/**
 * 共有シークレットの比較。長さ情報しか漏らさないよう SHA-256 同士を
 * 定数時間比較する (EXECUTOR_TOKEN の検証用)。
 */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(a)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = va.length ^ vb.length;
  const n = Math.max(va.length, vb.length);
  for (let i = 0; i < n; i++) {
    diff |= (va[i] ?? 0) ^ (vb[i] ?? 0);
  }
  return diff === 0;
}
