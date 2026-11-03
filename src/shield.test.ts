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
  test("候補ファイル名の判定（secrets*.yaml や *.secrets.yaml）", () => {
    expect(isSopsCandidateFile("secrets.yaml")).toBe(true);
    expect(isSopsCandidateFile("secrets.yml")).toBe(true);
    expect(isSopsCandidateFile("path/to/secrets.yaml")).toBe(true);
    expect(isSopsCandidateFile("secrets-prod.yaml")).toBe(true);
    expect(isSopsCandidateFile("app.secrets.json")).toBe(true);

    // 除外対象: 設定ファイルや一般的な Kubernetes Secret マニフェスト・ダミーファイル
    expect(isSopsCandidateFile(".sops.yaml")).toBe(false);
    expect(isSopsCandidateFile(".sops.yml")).toBe(false);
    expect(isSopsCandidateFile("README.md")).toBe(false);
    expect(isSopsCandidateFile("src/main.ts")).toBe(false);
    expect(isSopsCandidateFile("manifests/apps/autopilot/base/secret.yaml")).toBe(false);
    expect(isSopsCandidateFile("manifests/bootstrap/argocd/notifications-secret.yaml")).toBe(false);
    expect(isSopsCandidateFile("manifests/apps/pechka-preview-secret-appset.yaml")).toBe(false);
    expect(isSopsCandidateFile("local-secrets.yaml")).toBe(false);
  });

  test(".sops.yaml の path_regex を尊重する", () => {
    const tmp = tempDir();
    writeFileSync(
      join(tmp.path, ".sops.yaml"),
      `
creation_rules:
  - path_regex: secrets/.*\\.ya?ml$
    age: age123
`,
    );
    expect(isSopsCandidateFile("secrets/dev.yaml", tmp.path)).toBe(true);
    expect(isSopsCandidateFile("other/secrets.yaml", tmp.path)).toBe(false);
    tmp.cleanup();
  });

  test("暗号化済み SOPS の判定 (sops_mac / mac: ENC[...] / sops:allow)", () => {
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

    const allowedYaml = `
# sops:allow
password: dummy
`;
    expect(isEncryptedSops(allowedYaml)).toBe(true);

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

  test("gh pr review -b, pr comment の -b 引数を抽出", () => {
    const res = extractGhTexts(["pr", "comment", "42", "-b", "Looks good to me"]);
    expect(res.shouldScan).toBe(true);
    expect(res.texts).toContain("Looks good to me");

    const reviewRes = extractGhTexts(["pr", "review", "42", "-b", "Review comment"]);
    expect(reviewRes.shouldScan).toBe(true);
    expect(reviewRes.texts).toContain("Review comment");
  });

  test("短縮オプションの結合形 (-bTEXT, -tTITLE) を抽出", () => {
    const res = extractGhTexts(["pr", "create", "-tMyTitle", "-bMyBody"]);
    expect(res.shouldScan).toBe(true);
    expect(res.texts).toContain("MyTitle");
    expect(res.texts).toContain("MyBody");
  });

  test("gh api の -f body=..., -fkey=val, -F, --raw-field 引数を抽出", () => {
    const res1 = extractGhTexts([
      "api",
      "-X",
      "PATCH",
      "repos/owner/repo/pulls/1",
      "-f",
      "body=updated body content",
    ]);
    expect(res1.shouldScan).toBe(true);
    expect(res1.texts).toContain("body=updated body content");

    const res2 = extractGhTexts([
      "api",
      "-X",
      "POST",
      "repos/owner/repo/pulls/1/comments",
      "-F",
      "body=secret_token_123",
    ]);
    expect(res2.shouldScan).toBe(true);
    expect(res2.texts).toContain("body=secret_token_123");

    const res3 = extractGhTexts([
      "api",
      "-X",
      "POST",
      "repos/owner/repo/issues",
      "-fbody=compact_val",
      "--raw-field",
      "raw_key=raw_val",
    ]);
    expect(res3.shouldScan).toBe(true);
    expect(res3.texts).toContain("body=compact_val");
    expect(res3.texts).toContain("raw_key=raw_val");
  });

  test("gh api -F / --field key=@file からファイル内容を読み込む (must 3)", () => {
    const tmp = tempDir();
    const filePath = join(tmp.path, "secret.txt");
    writeFileSync(filePath, "file content from at");
    const res1 = extractGhTexts(["api", "repos/o/r", "-F", `body=@${filePath}`]);
    expect(res1.shouldScan).toBe(true);
    expect(res1.texts).toContain("file content from at");

    const res2 = extractGhTexts(["api", "repos/o/r", "--field", `body=@${filePath}`]);
    expect(res2.shouldScan).toBe(true);
    expect(res2.texts).toContain("file content from at");
    tmp.cleanup();
  });

  test("gh api --field key=@- または -F key=@- のとき needsStdin: true (must 3)", () => {
    const res1 = extractGhTexts(["api", "repos/o/r", "--field", "body=@-"], "stdin secret");
    expect(res1.shouldScan).toBe(true);
    expect(res1.needsStdin).toBe(true);
    expect(res1.texts).toContain("stdin secret");

    const res2 = extractGhTexts(["api", "repos/o/r", "-F", "body=@-"], "stdin secret");
    expect(res2.shouldScan).toBe(true);
    expect(res2.needsStdin).toBe(true);
    expect(res2.texts).toContain("stdin secret");
  });

  test("--body-file - または --input - があるときだけ needsStdin: true", () => {
    expect(extractGhTexts(["pr", "view"]).needsStdin).toBe(false);
    expect(extractGhTexts(["pr", "create", "-t", "T", "-b", "B"]).needsStdin).toBe(false);
    expect(extractGhTexts(["pr", "create", "-F", "-"]).needsStdin).toBe(true);
    expect(extractGhTexts(["api", "repos/o/r", "--input", "-"]).needsStdin).toBe(true);
    expect(extractGhTexts(["api", "repos/o/r", "-F", "body=@-"]).needsStdin).toBe(true);
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

  test("名前変更 (git mv plain.yaml secrets.yaml) による未暗号化 SOPS の追加もブロックする", async () => {
    tmp = tempDir();
    git(tmp.path, "init", "-b", "main");
    const plainFile = join(tmp.path, "plain.yaml");
    writeFileSync(plainFile, "password: plainpassword1234\n");
    git(tmp.path, "add", "plain.yaml");
    git(tmp.path, "commit", "-qm", "add plain");
    git(tmp.path, "mv", "plain.yaml", "secrets.yaml");

    const sopsRes = await checkUnencryptedSops(tmp.path);
    expect(sopsRes.ok).toBe(false);
    expect(sopsRes.reason).toContain("未暗号化の SOPS ファイル");
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
      expect(existsSync(logFile)).toBe(false);
    } finally {
      if (oldGhReal) process.env.GH_REAL_PATH = oldGhReal;
      else delete process.env.GH_REAL_PATH;
      tmp.cleanup();
    }
  });

  test("gh api -F body=<秘密> も exit 1 でブロックされる", async () => {
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
      const code = await runSafeGh([
        "api",
        "-X",
        "PATCH",
        "repos/o/r/pulls/1",
        "-F",
        `body=${secret}`,
      ]);
      expect(code).toBe(1);
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

  test("読み取り系コマンド (pr view) は stdin に触れず透過転送される", async () => {
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

describe("runPreCommit (ローカルフック連鎖と再帰防止)", () => {
  let tmp: ReturnType<typeof tempDir>;

  test("ローカルフックが存在する場合に連鎖実行し、本来の引数のみを渡す (must 1 & 2)", async () => {
    tmp = tempDir();
    git(tmp.path, "init", "-b", "main");
    const hookDir = join(tmp.path, ".git", "hooks");
    const localHook = join(hookDir, "pre-commit");
    const logFile = join(tmp.path, "hook.log");
    writeFileSync(localHook, `#!/bin/sh\necho "args:$*" >> "${logFile}"\nexit 0\n`);
    chmodSync(localHook, 0o755);

    const { runPreCommit } = await import("./shield.ts");
    // 本来のフック引数（通常は空または特定のフラグ）を渡す
    const code = await runPreCommit(tmp.path, ["--custom-arg"]);
    expect(code).toBe(0);
    expect(existsSync(logFile)).toBe(true);
    // "shield pre-commit" が引数に含まれず、"--custom-arg" のみ渡る
    expect(readFileSync(logFile, "utf8").trim()).toBe("args:--custom-arg");
    tmp.cleanup();
  });

  test("core.hooksPath で自身が呼ばれても無限再帰せず 0 で終わる (must 1)", async () => {
    tmp = tempDir();
    git(tmp.path, "init", "-b", "main");
    // core.hooksPath を一時的に設定
    git(tmp.path, "config", "core.hooksPath", join(tmp.path, "nonexistent-hooks"));

    const { runPreCommit } = await import("./shield.ts");
    const code = await runPreCommit(tmp.path);
    expect(code).toBe(0);
    tmp.cleanup();
  });
});
