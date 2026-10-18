import { describe, expect, it } from "vitest";
import { isPrivateBaseUrl } from "../src/base-url.js";

describe("isPrivateBaseUrl", () => {
  it("パブリックな https エンドポイントは許可", () => {
    for (const u of [
      "https://api.orcarouter.ai/v1",
      "https://api.openai.com/v1",
      "https://8.8.8.8/v1",
      "https://203.0.114.0/v1", // TEST-NET-3 の外側
      "http://example.com:8080/v1", // http でも public なら可 (BYOプロキシ)
    ]) {
      expect(isPrivateBaseUrl(u), u).toBe(false);
    }
  });

  it("localhost・ローカルTLD は拒否", () => {
    for (const u of [
      "http://localhost:11434/v1",
      "https://foo.localhost/v1",
      "http://nas.local/v1",
      "http://gw.internal/v1",
      "http://ap.lan/v1",
    ]) {
      expect(isPrivateBaseUrl(u), u).toBe(true);
    }
  });

  it("IPv4 プライベート/予約レンジは拒否", () => {
    for (const u of [
      "http://127.0.0.1:11434/v1",
      "http://127.1/v1", // WHATWG が 127.0.0.1 に正規化
      "http://0x7f.0.0.1/v1", // 同上
      "http://10.0.0.5/v1",
      "http://172.16.0.1/v1",
      "http://172.31.255.255/v1",
      "http://192.168.1.1/v1",
      "http://169.254.169.254/latest", // cloud metadata
      "http://100.64.0.1/v1", // CGNAT
      "http://0.0.0.0/v1",
      "http://224.0.0.1/v1",
      "http://255.255.255.255/v1",
      "http://192.0.2.1/v1", // TEST-NET-1
      "http://198.51.100.1/v1", // TEST-NET-2
      "http://203.0.113.1/v1", // TEST-NET-3
    ]) {
      expect(isPrivateBaseUrl(u), u).toBe(true);
    }
  });

  it("境界の public IPv4 は許可", () => {
    for (const u of [
      "http://172.32.0.1/v1", // 172.16/12 の外
      "http://100.128.0.1/v1", // CGNAT の外
      "http://11.0.0.1/v1",
      "http://192.169.0.1/v1",
    ]) {
      expect(isPrivateBaseUrl(u), u).toBe(false);
    }
  });

  it("IPv6 プライベートは拒否", () => {
    for (const u of [
      "http://[::1]:11434/v1",
      "http://[::]/v1",
      "http://[fe80::1]/v1",
      "http://[fd00::1]/v1",
      "http://[fc12:3456::1]/v1",
      "http://[ff02::1]/v1",
      "http://[::ffff:127.0.0.1]/v1", // mapped v4 (正規化後 ::ffff:7f00:1)
      "http://[::ffff:10.0.0.1]/v1",
      "http://[2001:db8::1]/v1",
    ]) {
      expect(isPrivateBaseUrl(u), u).toBe(true);
    }
  });

  it("public IPv6 は許可", () => {
    expect(isPrivateBaseUrl("http://[2606:4700:4700::1111]/v1")).toBe(false);
  });

  it("http/https 以外のスキーム・パース不能は拒否", () => {
    for (const u of [
      "file:///etc/passwd",
      "ftp://example.com/v1",
      "gopher://127.0.0.1/",
      "not-a-url",
      "",
    ]) {
      expect(isPrivateBaseUrl(u), JSON.stringify(u)).toBe(true);
    }
  });
});
