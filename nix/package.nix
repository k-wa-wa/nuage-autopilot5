{
  lib,
  stdenv,
  bun,
  makeWrapper,
  git,
  gh,
  gitleaks,
  version ? "0.1.0",
}:

# 実行時の依存パッケージは無いので、依存取得の derivation は要らない。
stdenv.mkDerivation {
  pname = "autopilot-run";
  inherit version;

  # ビルドとテストに要るものだけを含める。ドキュメントを直しても再ビルドされない。
  # home/ は不変条件テスト（invariants.test.ts）が検査するので含める。
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../tsconfig.json
      ../src
      ../home
    ];
  };

  nativeBuildInputs = [
    bun
    makeWrapper
    # テスト（エンドツーエンド）が本物の git / gitleaks を使う。
    git
    gitleaks
  ];

  dontConfigure = true;

  # bun build --compile が末尾に付ける JavaScript バンドルを strip / patchelf で落とさない。
  dontStrip = true;
  dontPatchELF = true;

  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    bun test --isolate
    bun build --compile --outfile autopilot-run src/main.ts
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 autopilot-run $out/bin/autopilot-run

    # Issue / PR への自由記述時の機密情報検査を行う gh 安全ラッパー
    makeWrapper $out/bin/autopilot-run $out/bin/gh \
      --add-flags "shield gh" \
      --set GH_REAL_PATH ${gh}/bin/gh \
      --prefix PATH : ${
        lib.makeBinPath [
          git
          gh
          gitleaks
        ]
      }

    # コミット時にステージされた差分と未暗号化 SOPS を検査する pre-commit フック
    mkdir -p $out/share/autopilot5/hooks
    makeWrapper $out/bin/autopilot-run $out/share/autopilot5/hooks/pre-commit \
      --add-flags "shield pre-commit" \
      --prefix PATH : ${
        lib.makeBinPath [
          git
          gitleaks
        ]
      }

    # PR・CI の操作に使う。エージェント CLI（claude / agy / copilot）は Nix 管理外なので含めない。
    wrapProgram $out/bin/autopilot-run --prefix PATH : ${
      lib.makeBinPath [
        git
        gh
        gitleaks
      ]
    }
    runHook postInstall
  '';

  meta = {
    description = "窓口エージェントから任された仕事を、人間を呼ばずに最後まで進める";
    mainProgram = "autopilot-run";
    platforms = lib.platforms.unix;
  };
}
