# autopilot 開発ガイドライン

設計の前提は [docs/design.md](./docs/design.md) を参照すること。

## 1. 検証（MUST）

コードを変更したら、次をすべて通す。

```bash
bun run check
bun test
```

nix 関連ファイルを変更したら、フォーマットとビルドを確認する。

```bash
nix run nixpkgs#nixfmt-tree -- ./nix ./flake.nix
nix build path:.#autopilot-run
```

## 2. テスト

どこに足すかは次で決める。

| ファイル | 置くもの |
|---|---|
| `src/<module>.test.ts` | モジュールごとの振る舞い |
| `src/pipeline.test.ts` | 流れ（順序・待ち・成否）。エージェント・GitHub・時計は `pipelineHarness` の偽物を使う |
| `src/e2e.test.ts` | `autopilot-run` を別プロセスで丸ごと動かす。本物の git と、偽の claude / agy / gh（`fakeWorld`）を使う |
| `src/invariants.test.ts` | 下の「設計の約束」と `home/` のルール。散文で宣言した規則がコードで強制されているかを確かめる |
| `src/regressions.test.ts` | 実際に踏んだ欠陥。型では防げず、動かして初めて分かったもの |

- 約束を足したら `invariants.test.ts` に、欠陥を直したら `regressions.test.ts` にテストを足す。
- 本物のエージェント CLI と GitHub はテストで呼ばない。gh の出力の形は、実物で確かめた値を回帰テストに残す。
- テストのヘルパーは `src/testing/helpers.ts` にまとめる。

## 3. 設計の約束

- 流れ（順序と待ち）は `src/pipeline.ts` だけが持つ。判断は LLM に任せ、コードに分岐を足さない。
- エージェント CLI ごとの違いは `src/agents.ts` だけに、gh の呼び出しは `src/github.ts` だけに、CI の判定は `src/ci.ts` だけに閉じる。
- 作業ごとの賢さは `src/models.ts` だけが決める。実在のモデル名はコード・テスト・`home/` に書かず、ホストの `models.yaml` だけに書く。
- モデルを切り替えるのは、失敗して作業ツリーが何も変わっていないときだけにする。
- 成否はエージェントの自己申告ではなく、commit・PR・push が実際にできたかで判定する。
- GitHub の状態は push 直後に揃わない。PR の HEAD がローカルと一致するまで CI の結果を読まない。
- 窓口とのやりとりは `.autopilot/` のファイルだけで行う。
- 仕組みを足すのは、プロンプトで守れないと実際に分かったときだけにする。

## 4. 操作ルール

- **Git 操作の禁止**: ユーザーからの特別な指示がない限り、コミット・プッシュ・ブランチ作成などの Git 操作は行わない。
- `home/` はホストのホームに symlink され、全エージェントがそのまま読む。書き換えるときは全エージェント・全リポジトリに効くことを意識する。
