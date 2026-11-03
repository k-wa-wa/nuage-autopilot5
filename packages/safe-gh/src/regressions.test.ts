import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractGhTexts, isEncryptedSops, isSopsCandidateFile, scanText } from "./detector.ts";
import { runPreCommit } from "./hook.ts";
import { git, tempDir } from "./testing/helpers.ts";

describe("機密情報や未暗号化 SOPS の誤送信・コミットをブロックする", () => {
  test("PR 作成や API 更新の本文に含まれる機密情報は exit 1 で送信を阻止する", async () => {
    const secret = "ghp_xK9pL2mQ8vR4tY7wZ1bN5cF3hJ6sD0gA9eC4";
    const extracted = extractGhTexts(["pr", "create", "-t", "feat", "-b", `Leaked: ${secret}`]);
    expect(extracted.shouldScan).toBe(true);
    const scanned = await scanText(extracted.texts.join("\n"));
    expect(scanned.ok).toBe(false);
  });

  test("未暗号化の secrets.yaml は sops_mac 不在としてブロックする", () => {
    expect(isSopsCandidateFile("secrets.yaml")).toBe(true);
    expect(isEncryptedSops("password: plain_password\napi_key: 12345\n")).toBe(false);
  });

  test("コンパイル済みバイナリ（argv[1] が実在しない仮想パス）でもローカルフックが連鎖実行される", async () => {
    const tmp = tempDir();
    git(tmp.path, "init", "-b", "main");
    const hookDir = join(tmp.path, ".git", "hooks");
    const localHook = join(hookDir, "pre-commit");
    const logFile = join(tmp.path, "local-hook.log");
    writeFileSync(localHook, `#!/bin/sh\necho "RAN" > "${logFile}"\nexit 0\n`);
    chmodSync(localHook, 0o755);

    // argv[1] をコンパイル済みバイナリの仮想パスに見立てる
    const origArgv1 = process.argv[1] ?? "";
    process.argv[1] = "/$bunfs/root/pre-commit";
    try {
      const code = await runPreCommit(tmp.path);
      expect(code).toBe(0);
      expect(existsSync(logFile)).toBe(true);
      expect(readFileSync(logFile, "utf8").trim()).toBe("RAN");
    } finally {
      process.argv[1] = origArgv1;
      tmp.cleanup();
    }
  });

  test("gh api の --field body=@file でファイル内容が抽出・検査される（--raw-field との取り違え防止）", async () => {
    const tmp = tempDir();
    const leakFile = join(tmp.path, "leak.txt");
    const secret = "ghp_xK9pL2mQ8vR4tY7wZ1bN5cF3hJ6sD0gA9eC4";
    writeFileSync(leakFile, secret);

    const res = extractGhTexts(["api", "repos/o/r/pulls/1", "--field", `body=@${leakFile}`]);
    expect(res.shouldScan).toBe(true);
    expect(res.texts).toContain(secret);
    const scanned = await scanText(res.texts.join("\n"));
    expect(scanned.ok).toBe(false);
    tmp.cleanup();
  });
});
