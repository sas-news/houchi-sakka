/**
 * カスタム base_url (OpenAI 互換エンドポイント) の SSRF ガード。
 *
 * BYO キーの base_url は runner (= 利用者のLAN内マシン) や Worker から
 * fetch される。登録ユーザーが自由に URL を決められると localhost や
 * プライベートアドレス宛のリクエストを踏み台にできてしまうため、
 * プライベート/ループバック/リンクローカル向けのホストを判定する。
 *
 * 意図的にローカル LLM (Ollama 等) へ向けたい場合は環境変数
 * ALLOW_PRIVATE_BASE_URL=1 で解除する (web・runner それぞれに設定)。
 * なおホスト名 → DNS 解決の経路は検査しない (rebinding は残存リスク)。
 */

/** URL の hostname をパースし、private/reserved 宛なら true。 */
export function isPrivateBaseUrl(urlStr: string): boolean {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  let host = url.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "") return true;

  // IPv6 リテラルは hostname が [..] 付きで返る
  if (host.startsWith("[") && host.endsWith("]")) {
    return isPrivateV6(host.slice(1, -1));
  }
  // ローカル系ホスト名
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home") ||
    host.endsWith(".corp")
  ) {
    return true;
  }
  // WHATWG URL は IPv4 を正規化する (127.1 → 127.0.0.1、0x7f.. → 127.0.0.1)
  // ので、ここでは正規化後の dotted quad だけ見ればよい。
  const v4 = parseV4(host);
  if (v4 !== null) return isPrivateV4(v4);
  return false;
}

function parseV4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (o.some((x) => x > 255)) return null; // ドメイン名扱い (DNS依存)
  return o as [number, number, number, number];
}

function isPrivateV4([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0 || a === 10 || a === 127) return true; // this-net / private / loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local 169.254/16
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
  if (a === 192 && b === 168) return true; // private 192.168/16
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast (224/4) + reserved (240/4)
  return false;
}

function isPrivateV6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true; // unspecified / loopback
  // IPv4-mapped: WHATWG は ::ffff:7f00:1 形式に正規化する
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2]!, 16);
    return isPrivateV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  if (/^fe[89ab]/.test(h)) return true; // link-local fe80::/10
  if (/^f[cd]/.test(h)) return true; // ULA fc00::/7
  if (h.startsWith("ff")) return true; // multicast ff00::/8
  if (h.startsWith("2001:db8")) return true; // documentation prefix
  return false;
}
