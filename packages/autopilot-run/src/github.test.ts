import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  currentBranch,
  defaultBranch,
  findGateFiles,
  gateNameFromPath,
  parseChecks,
  parseFailedRunId,
  parsePrNumber,
  resolveBaseSha,
  uncommittedFiles,
} from "./github.ts";
import { GH_NO_AUTH, GH_NO_PR, git, tempRepo } from "./testing/helpers.ts";

describe("parseChecks", () => {
  test("gh pr checks --json bucket の結果を読む", () => {
    const stdout = JSON.stringify([
      { bucket: "pass" },
      { bucket: "skipping" },
      { bucket: "pending" },
    ]);
    expect(parseChecks({ code: 0, stdout, stderr: "" })).toEqual(["pass", "skipping", "pending"]);
  });

  test("実行中（8）や失敗（1）で終わっても、出力があればそれを読む", () => {
    const pending = JSON.stringify([{ bucket: "pending" }]);
    const failed = JSON.stringify([{ bucket: "fail" }]);
    expect(parseChecks({ code: 8, stdout: pending, stderr: "" })).toEqual(["pending"]);
    expect(parseChecks({ code: 1, stdout: failed, stderr: "" })).toEqual(["fail"]);
  });

  test("CI が 1 件も無いときは、gh が失敗で終わっても空として読む", () => {
    expect(
      parseChecks({ code: 1, stdout: "", stderr: "no checks reported on the 'feat/x' branch" }),
    ).toEqual([]);
  });

  test("それ以外の失敗は握りつぶさない", () => {
    expect(() => parseChecks({ code: 1, stdout: "", stderr: "HTTP 502" })).toThrow(/HTTP 502/);
  });

  test("知らない状態は握りつぶさない（gh の仕様変更に気づくため）", () => {
    expect(() =>
      parseChecks({ code: 0, stdout: JSON.stringify([{ bucket: "weird" }]), stderr: "" }),
    ).toThrow(/weird/);
  });
});

describe("parsePrNumber", () => {
  test("成功なら番号を返す", () => {
    expect(parsePrNumber({ code: 0, stdout: "56", stderr: "" })).toBe(56);
  });

  test("PR が無いときだけ null を返す", () => {
    expect(parsePrNumber({ code: 1, stdout: "", stderr: GH_NO_PR })).toBeNull();
  });

  test("それ以外の失敗は gh の stderr を付けて例外にする", () => {
    expect(() => parsePrNumber({ code: 4, stdout: "", stderr: GH_NO_AUTH })).toThrow(
      /gh auth login/,
    );
    expect(() => parsePrNumber({ code: 1, stdout: "", stderr: "HTTP 502" })).toThrow(/HTTP 502/);
  });

  test("成功でも番号として読めなければ例外にする", () => {
    expect(() => parsePrNumber({ code: 0, stdout: "", stderr: "" })).toThrow(/gh pr view/);
  });
});

describe("parseFailedRunId", () => {
  test("該当する実行があれば ID、無ければ null", () => {
    expect(parseFailedRunId({ code: 0, stdout: "123", stderr: "" })).toBe("123");
    expect(parseFailedRunId({ code: 0, stdout: "", stderr: "" })).toBeNull();
  });

  test("gh の失敗は「見つからなかった」にせず、stderr を付けて例外にする", () => {
    expect(() => parseFailedRunId({ code: 4, stdout: "", stderr: GH_NO_AUTH })).toThrow(
      /gh run list.*gh auth login/s,
    );
  });
});

describe("git の読み取り", () => {
  let repo: ReturnType<typeof tempRepo>;
  afterEach(() => repo.cleanup());

  test("--local の既定ブランチは origin/HEAD から読む", async () => {
    repo = tempRepo();
    expect(await defaultBranch(repo.work, true)).toBe("main");
    expect(await currentBranch(repo.work)).toBe("feat/x");
  });

  test("PR モードで gh repo view が失敗したら、origin/HEAD に落とさず stderr を付けて例外にする", async () => {
    repo = tempRepo();
    const bin = join(repo.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), `#!/bin/sh\ncat >&2 <<'EOF'\n${GH_NO_AUTH}\nEOF\nexit 4\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      await expect(defaultBranch(repo.work, false)).rejects.toThrow(/exit 4.*gh auth login/s);
    } finally {
      process.env.PATH = path;
    }
  });

  test("差分の起点は既定ブランチとの分岐点（作業ブランチの commit を含まない）", async () => {
    repo = tempRepo();
    const fork = git(repo.work, "rev-parse", "HEAD");
    writeFileSync(join(repo.work, "a.txt"), "a\n");
    git(repo.work, "add", "-A");
    git(repo.work, "commit", "-qm", "a");
    expect(await resolveBaseSha(repo.work, "main")).toBe(fork);
  });

  test("既定ブランチが分からなくても origin/HEAD などで起点を探す", async () => {
    repo = tempRepo();
    expect(await resolveBaseSha(repo.work, null)).toBe(git(repo.work, "rev-parse", "HEAD"));
  });

  test("uncommittedFiles: 変更・未追跡のファイルを並べ、ignore に当たるものと .autopilot/ は含めない", async () => {
    repo = tempRepo();
    expect(await uncommittedFiles(repo.work)).toEqual([]);
    writeFileSync(join(repo.work, ".gitignore"), "ignored/\n");
    git(repo.work, "add", ".gitignore");
    git(repo.work, "commit", "-qm", "ignore");
    writeFileSync(join(repo.work, ".git", "info", "exclude"), ".autopilot/\n");
    mkdirSync(join(repo.work, "ignored"));
    writeFileSync(join(repo.work, "ignored", "x.log"), "x\n");
    mkdirSync(join(repo.work, ".autopilot"));
    writeFileSync(join(repo.work, ".autopilot", "needs-human.md"), "x\n");
    expect(await uncommittedFiles(repo.work)).toEqual([]);
    writeFileSync(join(repo.work, "README.md"), "changed\n");
    mkdirSync(join(repo.work, "out", "deep"), { recursive: true });
    writeFileSync(join(repo.work, "out", "deep", "new.txt"), "new\n");
    // 先頭の空白（作業ツリーだけの変更）も保つ。
    expect(await uncommittedFiles(repo.work)).toEqual([" M README.md", "?? out/deep/new.txt"]);
  });

  test("uncommittedFiles: git が失敗したら綺麗とみなさず例外にする", async () => {
    repo = tempRepo();
    await expect(uncommittedFiles(repo.root)).rejects.toThrow("git status が失敗した");
  });

  test("gateNameFromPath: ファイル名からゲート名を決める", () => {
    expect(gateNameFromPath(".agents/autopilot-gate.md")).toBe("default");
    expect(gateNameFromPath("autopilot-gate.md")).toBe("default");
    expect(gateNameFromPath(".agents/autopilot-gate-e2e.md")).toBe("e2e");
    expect(gateNameFromPath(".agents/autopilot-gate-perf.md")).toBe("perf");
    expect(gateNameFromPath(".agents/autopilot-gate_custom.md")).toBe("custom");
  });

  test("存在しない基点をゲートなしと扱わない", async () => {
    repo = tempRepo();
    await expect(findGateFiles(repo.work, "missing-base")).rejects.toThrow("ゲート一覧を読めない");
    expect(await findGateFiles(repo.work, "HEAD")).toEqual([]);
  });

  test("特殊文字の名前も拾い、同名の手順書が衝突せず、サブディレクトリは含めない", async () => {
    repo = tempRepo();
    const agents = join(repo.work, ".agents");
    mkdirSync(join(agents, "autopilot-gate-dir"), { recursive: true });
    const names = ["", "-default", "_default", "-日本語", "-空 白", "-a\nb"];
    for (const name of names) {
      writeFileSync(join(agents, `autopilot-gate${name}.md`), `手順 ${name}`);
    }
    writeFileSync(join(agents, "autopilot-gate-dir", "nested.md"), "対象外");
    git(repo.work, "add", ".agents");
    git(repo.work, "commit", "-qm", "gates");
    const gates = await findGateFiles(repo.work, "HEAD");
    expect(gates).toHaveLength(names.length);
    expect(new Set(gates.map((g) => g.name)).size).toBe(names.length);
    for (const gate of gates) expect(gate.name).toMatch(/^[A-Za-z0-9._%-]+$/);
    expect(gates.some((g) => g.content === "手順 -日本語")).toBe(true);
  });

  test("findGateFiles: 基点からゲートを見つけて読む（作業ツリーの変更や新規ファイルは使われない）", async () => {
    repo = tempRepo();
    // 基点にゲートファイルをコミットする
    const agentsDir = join(repo.work, ".agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "autopilot-gate.md"), "# 元のゲート\n");
    writeFileSync(join(agentsDir, "autopilot-gate-e2e.md"), "# E2E ゲート\n");
    git(repo.work, "add", "-A");
    git(repo.work, "commit", "-qm", "add base gates");
    const baseSha = git(repo.work, "rev-parse", "HEAD");

    // 作業ツリーで既存のゲートを緩め（書き換え）、新しいゲートを追加する
    writeFileSync(join(agentsDir, "autopilot-gate.md"), "# 緩めたゲート\n");
    writeFileSync(join(agentsDir, "autopilot-gate-new.md"), "# 新規ゲート\n");

    const gates = await findGateFiles(repo.work, baseSha);
    expect(gates).toHaveLength(2);
    expect(gates.map((g) => g.name).sort()).toEqual(["default", "e2e"]);
    expect(gates.find((g) => g.name === "default")?.content).toBe("# 元のゲート\n");
    expect(gates.find((g) => g.name === "e2e")?.content).toBe("# E2E ゲート\n");
  });
});
