import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * 窓口とのやりとりはすべて worktree 直下の .autopilot/ のファイルで行う。
 *
 *   brief.md      窓口が書く。仕様と合意事項
 *   inbox.md      窓口が書く。実行中に人間から来た追加指示（区切りごとに読む）
 *   status        現在の段階（1 行）。最後は done / needs-human: … / failed: … / stopped: …
 *   run.log       全エージェントの出力
 *   agent-stdout.log  会話を引き継ぐ実行（実装・修正）の生の標準出力。本文は run.log にも書く
 *   run.pid       実行中のプロセス
 *   decisions.md  実装担当が書く。判断とその理由
 *   result.md     最後に実装担当が書く。人間向けの要約
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
