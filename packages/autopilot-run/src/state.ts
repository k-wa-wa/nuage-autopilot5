import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * 窓口とのやりとりはすべて worktree 直下の .autopilot/ のファイルで行う。
 *
 *   request.md    窓口が書く。依頼と仕様（丸投げなら合意仕様は空）
 *   spec.md       検討担当が書く。確定した仕様（--from spec のとき）
 *   spec-prev.md  前回の spec.md（再実行時の下書き用）
 *   inbox.md      窓口が書く。実行中に人間から来た追加指示（区切りごとに読む）
 *   status        現在の段階（1 行）。最後は done / needs-human: … / failed: … / stopped: …
 *   run.log       全エージェントの出力
 *   agent-stdout.log  会話を引き継ぐ実行（検討・修正）の生の標準出力。本文は run.log にも書く
 *   run.pid       実行中のプロセス
 *   decisions.md  実装・検討担当が書く。判断とその理由
 *   needs-human.md 修正・検討担当が書く。コードや仕様で片付かず人間に返す理由
 *   spec-review-N-<担当>.md  仕様レビュー担当が書く。N 周目の仕様レビュー結果と判定
 *   review-N-<担当>.md  レビュー担当が書く。N 周目のコードレビュー結果と判定
 *   gate-src-<名前>.md  autopilot が基点から取り出したゲートの手順書
 *   gate-N-<名前>.md  ゲート検証担当が書く。N 周目の手順の実行結果と合否
 *   result.md     最後に要約担当が書く。人間向けの要約
 */

export const STATE_DIR = ".autopilot";

export class State {
  readonly dir: string;

  constructor(root: string) {
    this.dir = join(root, STATE_DIR);
    mkdirSync(this.dir, { recursive: true });
  }

  /** 絶対パス（このプロセスが書くとき用）。 */
  file(name: string): string {
    return join(this.dir, name);
  }

  /** worktree からの相対パス（プロンプトに書くとき用）。 */
  rel(name: string): string {
    return `${STATE_DIR}/${name}`;
  }

  log(msg: string): void {
    const time = new Date().toTimeString().slice(0, 8);
    appendFileSync(this.file("run.log"), `[${time}] ${msg}\n`);
  }

  stage(stage: string): void {
    writeFileSync(this.file("status"), `${stage}\n`);
    this.log(`== ${stage}`);
  }

  status(): string {
    return this.read("status")?.trim() ?? "-";
  }

  read(name: string): string | null {
    const path = this.file(name);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }

  write(name: string, text: string): void {
    writeFileSync(this.file(name), text);
  }

  append(name: string, text: string): void {
    appendFileSync(this.file(name), text);
  }

  remove(name: string): void {
    rmSync(this.file(name), { force: true });
  }

  rename(from: string, to: string): void {
    renameSync(this.file(from), this.file(to));
  }

  /** 追加指示があれば round 用に退避し、その名前を返す。 */
  takeInbox(round: number): string | null {
    const path = this.file("inbox.md");
    if (!existsSync(path) || statSync(path).size === 0) return null;
    const name = `inbox-${round}.md`;
    renameSync(path, this.file(name));
    return name;
  }

  runningPid(): number | null {
    const pid = Number(this.read("run.pid"));
    if (!pid) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      return null;
    }
  }
}
