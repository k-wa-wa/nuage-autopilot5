import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkUnencryptedSops,
  extractGhTexts,
  isEncryptedSops,
  isSopsCandidateFile,
  scanStaged,
  scanText,
} from "./shield.ts";
import { git, tempDir } from "./testing/helpers.ts";

describe("SOPS 暗号化ファイル判定", () => {
  test("候補ファイル名の判定", () => {
    expect(isSopsCandidateFile("secrets.yaml")).toBe(true);
    expect(isSopsCandidateFile("secrets.yml")).toBe(true);
    expect(isSopsCandidateFile("path/to/secrets.yaml")).toBe(true);
    expect(isSopsCandidateFile("secrets-prod.yaml")).toBe(true);
    expect(isSopsCandidateFile("app.secrets.json")).toBe(true);
    expect(isSopsCandidateFile("secret_config.yaml")).toBe(true);

    // 除外対象
    expect(isSopsCandidateFile(".sops.yaml")).toBe(false);
    expect(isSopsCandidateFile(".sops.yml")).toBe(false);
    expect(isSopsCandidateFile("README.md")).toBe(false);
    expect(isSopsCandidateFile("src/main.ts")).toBe(false);
  });

  test("暗号化済み SOPS の判定 (sops_mac / mac: ENC[...])", () => {
    const encryptedYaml = `
data: ENC[AES256_GCM,data:xyz,iv:abc,tag:123]
sops:
    mac: ENC[AES256_GCM,data:macdata,iv:abc,tag:123]
    version: 3.9.0
`;
    expect(isEncryptedSops(encryptedYaml)).toBe(true);

    const legacyEncrypted = `
sops_mac: ENC[AES256_GCM,data:macdata]
`;
    expect(isEncryptedSops(legacyEncrypted)).toBe(true);

    const plainYaml = `
password: supersecretpassword123
api_key: somekey
`;
    expect(isEncryptedSops(plainYaml)).toBe(false);
  });
});

describe("extractGhTexts", () => {
  test("対象外のコマンドは shouldScan: false", () => {
    expect(extractGhTexts(["pr", "view"]).shouldScan).toBe(false);
    expect(extractGhTexts(["pr", "checks", "123"]).shouldScan).toBe(false);
    expect(extractGhTexts(["issue", "view", "45"]).shouldScan).toBe(false);
    expect(extractGhTexts(["repo", "view"]).shouldScan).toBe(false);
    expect(extractGhTexts(["run", "list"]).shouldScan).toBe(false);
  });

  test("gh pr create / edit の -t, -b, --body-file 引数を抽出", () => {
    const res = extractGhTexts([
      "pr",
      "create",
      "--title",
      "feat: add feature",
      "-b",
      "PR description with details",
    ]);
    expect(res.shouldScan).toBe(true);
    expect(res.texts).toContain("feat: add feature");
    expect(res.texts).toContain("PR description with details");
  });

  test("gh pr comment の -b 引数を抽出", () => {
    const res = extractGhTexts(["pr", "comment", "42", "-b", "Looks good to me"]);
    expect(res.shouldScan).toBe(true);
    expect(res.texts).toContain("Looks good to me");
  });

  test("gh issue create / comment の引数を抽出", () => {
    const res = extractGhTexts([
      "issue",
      "create",
      "-t",
      "Bug report",
      "--body=Detailed bug description",
    ]);
    expect(res.shouldScan).toBe(true);
    expect(res.texts).toContain("Bug report");
    expect(res.texts).toContain("Detailed bug description");
  });

  test("gh api の -f body=..., -F, --input 引数を抽出", () => {
    const res = extractGhTexts([
      "api",
      "-X",
      "PATCH",
      "repos/owner/repo/pulls/1",
      "-f",
      "body=updated body content",
    ]);
    expect(res.shouldScan).toBe(true);
    expect(res.texts).toContain("updated body content");
  });

  test("--body-file - または stdinText が渡された場合に抽出", () => {
    const res = extractGhTexts(["pr", "create", "-F", "-"], "stdin body content");
    expect(res.shouldScan).toBe(true);
    expect(res.texts).toContain("stdin body content");
  });
});

describe("scanText (gitleaks 連携)", () => {
  test("安全なテキストは pass する", async () => {
    const res = await scanText("This is a normal commit message without secrets.");
    expect(res.ok).toBe(true);
  });

  test("機密情報（GitHub PAT）を含むテキストはブロックする", async () => {
    const secret = "ghp_xK9pL2mQ8vR4tY7wZ1bN5cF3hJ6sD0gA9eC4";
    const res = await scanText(`Here is my token: ${secret}`);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("機密情報");
  });

  test("機密情報（SSH 秘密鍵）を含むテキストはブロックする", async () => {
    const privateKey = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
      "QyNTUxOQAAACD1234567890123456789012345678901234567890123AAAJsAAAAAAAA",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const res = await scanText(privateKey);
    expect(res.ok).toBe(false);
  });
});

describe("コミット前検査 (checkUnencryptedSops & scanStaged)", () => {
  let tmp: ReturnType<typeof tempDir>;

  test("暗号化されていない secrets.yaml のステージをブロックする", async () => {
    tmp = tempDir();
    git(tmp.path, "init", "-b", "main");
    const secretYaml = join(tmp.path, "secrets.yaml");
    writeFileSync(secretYaml, "password: plainpassword1234\n");
    git(tmp.path, "add", "secrets.yaml");

    const sopsRes = await checkUnencryptedSops(tmp.path);
    expect(sopsRes.ok).toBe(false);
    expect(sopsRes.reason).toContain("未暗号化の SOPS ファイル");

    const stagedRes = await scanStaged(tmp.path);
    expect(stagedRes.ok).toBe(false);
    tmp.cleanup();
  });

  test("暗号化済み (sops.mac あり) secrets.yaml は pass する", async () => {
    tmp = tempDir();
    git(tmp.path, "init", "-b", "main");
    const secretYaml = join(tmp.path, "secrets.yaml");
    writeFileSync(
      secretYaml,
      `
data: ENC[AES256_GCM,data:abc,iv:123,tag:456]
sops:
    mac: ENC[AES256_GCM,data:mac,iv:123,tag:456]
`,
    );
    git(tmp.path, "add", "secrets.yaml");

    const sopsRes = await checkUnencryptedSops(tmp.path);
    expect(sopsRes.ok).toBe(true);
    tmp.cleanup();
  });

  test("ステージされた変更に機密情報（秘密鍵）が含まれる場合 scanStaged がブロックする", async () => {
    tmp = tempDir();
    git(tmp.path, "init", "-b", "main");
    const keyFile = join(tmp.path, "id_ed25519");
    const privateKey = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
      "QyNTUxOQAAACD1234567890123456789012345678901234567890123AAAJsAAAAAAAA",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    writeFileSync(keyFile, privateKey);
    git(tmp.path, "add", "id_ed25519");

    const stagedRes = await scanStaged(tmp.path);
    expect(stagedRes.ok).toBe(false);
    expect(stagedRes.reason).toContain("機密情報");
    tmp.cleanup();
  });
});

describe("runSafeGh (安全ラッパー)", () => {
  let tmp: ReturnType<typeof tempDir>;

  test("機密情報を含む PR 作成コマンドはブロックされ、本物の gh は呼ばれない", async () => {
    tmp = tempDir();
    const mockGh = join(tmp.path, "mock-gh");
    const logFile = join(tmp.path, "gh.log");
    writeFileSync(mockGh, `#!/bin/sh\necho "$@" >> "${logFile}"\n`);
    chmodSync(mockGh, 0o755);

    const oldGhReal = process.env.GH_REAL_PATH;
    process.env.GH_REAL_PATH = mockGh;
    try {
      const secret = "ghp_xK9pL2mQ8vR4tY7wZ1bN5cF3hJ6sD0gA9eC4";
      const { runSafeGh } = await import("./shield.ts");
      const code = await runSafeGh(["pr", "create", "-t", "feat", "-b", `Token is ${secret}`]);
      expect(code).toBe(1);
      // mock-gh は呼ばれていないはず
      expect(existsSync(logFile)).toBe(false);
    } finally {
      if (oldGhReal) process.env.GH_REAL_PATH = oldGhReal;
      else delete process.env.GH_REAL_PATH;
      tmp.cleanup();
    }
  });

  test("機密情報を含まない PR 作成コマンドは本物の gh に透過転送される", async () => {
    tmp = tempDir();
    const mockGh = join(tmp.path, "mock-gh");
    const logFile = join(tmp.path, "gh.log");
    writeFileSync(mockGh, `#!/bin/sh\necho "$@" >> "${logFile}"\nexit 0\n`);
    chmodSync(mockGh, 0o755);

    const oldGhReal = process.env.GH_REAL_PATH;
    process.env.GH_REAL_PATH = mockGh;
    try {
      const { runSafeGh } = await import("./shield.ts");
      const code = await runSafeGh(["pr", "create", "-t", "feat", "-b", "Normal body"]);
      expect(code).toBe(0);
      expect(existsSync(logFile)).toBe(true);
      expect(readFileSync(logFile, "utf8")).toContain("pr create -t feat -b Normal body");
    } finally {
      if (oldGhReal) process.env.GH_REAL_PATH = oldGhReal;
      else delete process.env.GH_REAL_PATH;
      tmp.cleanup();
    }
  });

  test("読み取り系コマンド (pr view) はスキャンせず透過転送される", async () => {
    tmp = tempDir();
    const mockGh = join(tmp.path, "mock-gh");
    const logFile = join(tmp.path, "gh.log");
    writeFileSync(mockGh, `#!/bin/sh\necho "$@" >> "${logFile}"\nexit 0\n`);
    chmodSync(mockGh, 0o755);

    const oldGhReal = process.env.GH_REAL_PATH;
    process.env.GH_REAL_PATH = mockGh;
    try {
      const { runSafeGh } = await import("./shield.ts");
      const code = await runSafeGh(["pr", "view", "123"]);
      expect(code).toBe(0);
      expect(existsSync(logFile)).toBe(true);
      expect(readFileSync(logFile, "utf8")).toContain("pr view 123");
    } finally {
      if (oldGhReal) process.env.GH_REAL_PATH = oldGhReal;
      else delete process.env.GH_REAL_PATH;
      tmp.cleanup();
    }
  });
});
