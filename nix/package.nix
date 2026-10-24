{
  lib,
  stdenv,
  bun,
  makeWrapper,
  git,
  gh,
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
    # テスト（エンドツーエンド）が本物の git でリポジトリを作る。
    git
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
    # PR・CI の操作に使う。エージェント CLI（claude / agy / copilot）は Nix 管理外なので含めない。
    wrapProgram $out/bin/autopilot-run --prefix PATH : ${
      lib.makeBinPath [
        git
        gh
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
