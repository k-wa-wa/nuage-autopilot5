import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSafeGh } from "./main.ts";
import { tempDir } from "./testing/helpers.ts";

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
