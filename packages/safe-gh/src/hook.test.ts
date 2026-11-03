import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runPreCommit } from "./hook.ts";
import { git, tempDir } from "./testing/helpers.ts";

describe("runPreCommit (ローカルフック連鎖と再帰防止)", () => {
  let tmp: ReturnType<typeof tempDir>;

  test("ローカルフックが存在する場合に連鎖実行し、本来の引数のみを渡す", async () => {
    tmp = tempDir();
    git(tmp.path, "init", "-b", "main");
    const hookDir = join(tmp.path, ".git", "hooks");
    const localHook = join(hookDir, "pre-commit");
    const logFile = join(tmp.path, "hook.log");
    writeFileSync(localHook, `#!/bin/sh\necho "args:$*" >> "${logFile}"\nexit 0\n`);
    chmodSync(localHook, 0o755);

    const code = await runPreCommit(tmp.path, ["--custom-arg"]);
    expect(code).toBe(0);
    expect(existsSync(logFile)).toBe(true);
    expect(readFileSync(logFile, "utf8").trim()).toBe("args:--custom-arg");
    tmp.cleanup();
  });

  test("core.hooksPath で自身が呼ばれても無限再帰せず 0 で終わる", async () => {
    tmp = tempDir();
    git(tmp.path, "init", "-b", "main");
    git(tmp.path, "config", "core.hooksPath", join(tmp.path, "nonexistent-hooks"));

    const code = await runPreCommit(tmp.path);
    expect(code).toBe(0);
    tmp.cleanup();
  });

  test("未暗号化 SOPS がステージされていると exit 1 で阻止する", async () => {
    tmp = tempDir();
    git(tmp.path, "init", "-b", "main");
    const secretFile = join(tmp.path, "secrets.yaml");
    writeFileSync(secretFile, "db_password: plainpassword123\n");
    git(tmp.path, "add", "secrets.yaml");

    const code = await runPreCommit(tmp.path);
    expect(code).toBe(1);
    tmp.cleanup();
  });
});
