# エージェントが動くホストに autopilot を入れる NixOS モジュール。
#
# - autopilot-run を PATH に入れる。
# - home/ の共通ルールとスキルを、各エージェント CLI がホーム全体で読む場所へ symlink する。
#   リポジトリの .agents/skills ではそのリポジトリでしか効かないため、ホーム側に置く。
#   共通ルールの後ろには、ホストが渡すルール (extraRules) を足す。
# - 段階ごとのモデルの並び (models.yaml) を /etc/autopilot5/models.yaml に置く。
# - メトリクス収集 (metrics.enable) が有効な場合、単価定義を /etc/autopilot5/rates.yaml に配置し、
#   systemd user サービスおよびタイマーで定期的にメトリクスを収集する。
#
# ~/.claude/settings.json などエージェントや Orca が書き換えるファイルには触れない。
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.autopilot5;
  home = config.users.users.${cfg.user}.home;
  group = config.users.users.${cfg.user}.group;
  # home/AGENTS.md (窓口としてのルール) の後ろに、ホストが渡すルールを足す。
  rules = pkgs.writeText "AGENTS.md" (
    lib.concatMapStringsSep "\n" builtins.readFile ([ ../home/AGENTS.md ] ++ cfg.extraRules)
  );
  skills = ../home/skills;

  # エージェントごとの「ホーム全体で読む共通ルール」と「スキル置き場」。
  targets = {
    claude = {
      rules = ".claude/CLAUDE.md";
      skills = ".claude/skills";
    };
    agy = {
      rules = ".gemini/AGENTS.md";
      skills = ".gemini/config/skills";
    };
    copilot = {
      rules = ".copilot/copilot-instructions.md";
      skills = ".copilot/skills";
    };
  };

  skillNames = builtins.attrNames (builtins.readDir skills);

  # 書き間違いは実行時ではなくビルド時に落とす (autoUpgrade が失敗として見える)。
  checkedModels = pkgs.runCommand "autopilot5-models.yaml" { } ''
    export HOME=$TMPDIR
    ${lib.getExe cfg.package} models --file ${cfg.models}
    cp ${cfg.models} $out
  '';

  # "a/b/c" → [ "a" "a/b" "a/b/c" ]。新しいホストでは途中のディレクトリも無い。
  ancestors =
    path:
    let
      parts = lib.splitString "/" path;
    in
    builtins.genList (i: lib.concatStringsSep "/" (lib.take (i + 1) parts)) (builtins.length parts);

  rulesFor =
    agent:
    let
      t = targets.${agent};
      dirs = lib.unique (ancestors (builtins.dirOf t.rules) ++ ancestors t.skills);
    in
    # エージェントの認証情報も入る場所なので、本人以外は読めないようにする。
    map (d: "d ${home}/${d} 0700 ${cfg.user} ${group} -") dirs
    ++ [ "L+ ${home}/${t.rules} - - - - ${rules}" ]
    ++ map (s: "L+ ${home}/${t.skills}/${s} - - - - ${skills}/${s}") skillNames;
in
{
  options.programs.autopilot5 = {
    enable = lib.mkEnableOption "autopilot（窓口エージェントから任された仕事を裏で完走させる）";

    package = lib.mkOption {
      type = lib.types.package;
      description = "使用する autopilot-run パッケージ。";
    };

    user = lib.mkOption {
      type = lib.types.str;
      example = "nixos";
      description = "エージェントを動かすユーザー。このユーザーのホームに共通ルールとスキルを置く。";
    };

    models = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = lib.literalExpression "./models.yaml";
      description = ''
        段階 (high / standard / light) ごとのモデルの並び。エージェント → 段階 → 前から順に試すモデルで書く。
        モデルは頻繁に変わるので、モデル名はこのファイルだけに書く。null なら各 CLI の既定モデルで動く。
      '';
    };

    extraRules = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      default = [ ];
      example = lib.literalExpression "[ inputs.nix-config.lib.agentRules ]";
      description = ''
        共通ルール (home/AGENTS.md) の後ろに足すルール。
        人間個人の約束 (言葉・進め方など) のように、autopilot の外で決めて他のホストとも共有するものを置く。
      '';
    };

    agents = lib.mkOption {
      type = lib.types.listOf (lib.types.enum (builtins.attrNames targets));
      default = builtins.attrNames targets;
      description = "共通ルールとスキルを配るエージェント CLI。";
    };

    metrics = {
      enable = lib.mkEnableOption "AI Agent 使用量メトリクス収集と VictoriaMetrics 連携";

      ratesFile = lib.mkOption {
        type = lib.types.path;
        default = ../metrics/rates.yaml;
        description = "配置するモデル単価定義ファイル (rates.yaml)。";
      };

      interval = lib.mkOption {
        type = lib.types.str;
        default = "*:0/1";
        example = "*:0/1";
        description = "メトリクス収集を実行する systemd タイマー間隔 (OnCalendar)。";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];
    environment.etc."autopilot5/models.yaml" = lib.mkIf (cfg.models != null) {
      source = checkedModels;
    };
    environment.etc."autopilot5/rates.yaml" = lib.mkIf cfg.metrics.enable {
      source = cfg.metrics.ratesFile;
    };
    systemd.tmpfiles.rules = lib.concatMap rulesFor cfg.agents;

    systemd.user.timers.ai-agent-metrics-collector = lib.mkIf cfg.metrics.enable {
      description = "AI Agent 使用量メトリクス定期収集タイマー";
      wantedBy = [ "timers.target" ];

      unitConfig = {
        ConditionUser = cfg.user;
      };

      timerConfig = {
        OnCalendar = cfg.metrics.interval;
        Persistent = true;
      };
    };

    systemd.user.services.ai-agent-metrics-collector = lib.mkIf cfg.metrics.enable {
      description = "AI Agent 使用量メトリクス収集と VictoriaMetrics 連携";

      unitConfig = {
        ConditionUser = cfg.user;
      };

      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${pkgs.python3}/bin/python3 ${../metrics/collector.py} --rates-file /etc/autopilot5/rates.yaml";
      };
    };
  };
}
