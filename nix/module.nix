# エージェントが動くホストに autopilot を入れる NixOS モジュール。
#
# - autopilot-run を PATH に入れる。
# - home/ の共通ルールとスキルを、各エージェント CLI がホーム全体で読む場所へ symlink する。
#   リポジトリの .agents/skills ではそのリポジトリでしか効かないため、ホーム側に置く。
#   共通ルールの後ろには、ホストが渡すルール (extraRules) を足す。
#   codex のルールには、最後に home/codex.md を足す。
# - 段階ごとのモデルの並び (models.yaml) を /etc/autopilot5/models.yaml に置く。
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
  # codex には、取り違えやすい読み方を補うルールを最後に足す。
  codexRules = pkgs.writeText "AGENTS.md" (
    lib.concatMapStringsSep "\n" builtins.readFile (
      [ ../home/AGENTS.md ] ++ cfg.extraRules ++ [ ../home/codex.md ]
    )
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
    codex = {
      rules = ".codex/AGENTS.md";
      skills = ".agents/skills";
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
    ++ [ "L+ ${home}/${t.rules} - - - - ${if agent == "codex" then codexRules else rules}" ]
    ++ map (s: "L+ ${home}/${t.skills}/${s} - - - - ${skills}/${s}") skillNames;

  checkedTaskConfig =
    name: task:
    let
      resolvedMemory =
        if task.memory == null then
          null
        else
          {
            repo = if task.memory.repo != null then task.memory.repo else cfg.taskDefaults.memoryRepo;
            inherit (task.memory) file maxLines;
          };
      resolvedPrecheck =
        if task.precheck == null then
          null
        else
          {
            inherit (task.precheck) command;
            timeoutSec =
              if task.precheck.timeoutSec != null then
                task.precheck.timeoutSec
              else
                cfg.taskDefaults.precheckTimeoutSec;
          };
      raw = pkgs.writeText "autopilot-task-${name}.json" (
        builtins.toJSON {
          inherit name;
          soulFile = "${task.soul}";
          inherit (task) agent level;
          trigger = {
            inherit (task.trigger) type schedule;
          };
          precheck = resolvedPrecheck;
          memory = resolvedMemory;
          workdir = if task.workdir != null then task.workdir else cfg.taskDefaults.workdir;
          timeoutSec = if task.timeoutSec != null then task.timeoutSec else cfg.taskDefaults.timeoutSec;
        }
      );
    in
    pkgs.runCommand "autopilot-task-${name}-config.json" { } ''
      export HOME=$TMPDIR
      ${cfg.package}/bin/autopilot-task check-config --file ${raw}
      cp ${raw} $out
    '';
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
        担当の優先順 (roles.impl / roles.review) と段階 (high / standard / light) ごとのモデルの並び。エージェント → 段階 → 前から順に試すモデルで書く。
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

    taskDefaults = {
      envFile = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "タスク用 systemd サービスに読み込む既定の EnvironmentFile パス。";
      };
      memoryRepo = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "タスクの記憶機能で使う既定の git リポジトリパス。";
      };
      workdir = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "タスクの既定の作業ディレクトリ。null 時はランナーがタスク専用ディレクトリを自動作成する。";
      };
      timeoutSec = lib.mkOption {
        type = lib.types.ints.positive;
        default = 3600;
        description = "タスク実行の既定タイムアウト秒数。";
      };
      precheckTimeoutSec = lib.mkOption {
        type = lib.types.ints.positive;
        default = 60;
        description = "precheck コマンドの既定タイムアウト秒数。";
      };
    };

    tasks = lib.mkOption {
      default = { };
      description = "定期実行する自律タスクの定義。";
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            soul = lib.mkOption {
              type = lib.types.path;
              description = "タスクの指示書（SOUL.md）のパス。";
            };
            agent = lib.mkOption {
              type = lib.types.nullOr (
                lib.types.enum [
                  "claude"
                  "agy"
                  "codex"
                ]
              );
              default = null;
              description = "使用するエージェント CLI。null 時は models.yaml の roles.impl 順で実行する。";
            };
            level = lib.mkOption {
              type = lib.types.enum [
                "high"
                "standard"
                "light"
              ];
              default = "standard";
              description = "タスク実行で使う賢さ段階。";
            };
            trigger = lib.mkOption {
              description = "タスクの起動トリガー。";
              type = lib.types.submodule {
                options = {
                  type = lib.mkOption {
                    type = lib.types.enum [ "cron" ];
                    default = "cron";
                    description = "トリガー種別。";
                  };
                  schedule = lib.mkOption {
                    type = lib.types.str;
                    description = "systemd timer の OnCalendar 式。";
                  };
                };
              };
            };
            precheck = lib.mkOption {
              default = null;
              description = "エージェント起動前に実行する軽量チェック。失敗時はスキップする。";
              type = lib.types.nullOr (
                lib.types.submodule {
                  options = {
                    command = lib.mkOption {
                      type = lib.types.str;
                      description = "sh -c に渡す事前チェックコマンド。";
                    };
                    timeoutSec = lib.mkOption {
                      type = lib.types.nullOr lib.types.ints.positive;
                      default = null;
                      description = "事前チェックのタイムアウト秒数。null 時は taskDefaults.precheckTimeoutSec を使う。";
                    };
                  };
                }
              );
            };
            memory = lib.mkOption {
              default = null;
              description = "タスクの長期記憶設定。null 時は記憶機能を使わない。";
              type = lib.types.nullOr (
                lib.types.submodule {
                  options = {
                    repo = lib.mkOption {
                      type = lib.types.nullOr lib.types.str;
                      default = null;
                      description = "記憶を保存する git リポジトリパス。null 時は taskDefaults.memoryRepo を使う。";
                    };
                    file = lib.mkOption {
                      type = lib.types.str;
                      description = "記憶リポジトリ内の相対ファイルパス。";
                    };
                    maxLines = lib.mkOption {
                      type = lib.types.ints.positive;
                      default = 200;
                      description = "プロンプトへ読み込む末尾行数。";
                    };
                  };
                }
              );
            };
            workdir = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "タスク実行時の作業ディレクトリ。null 時は taskDefaults.workdir を使う。";
            };
            timeoutSec = lib.mkOption {
              type = lib.types.nullOr lib.types.ints.positive;
              default = null;
              description = "タスク全体のタイムアウト秒数。null 時は taskDefaults.timeoutSec を使う。";
            };
            envFile = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "EnvironmentFile パス。null 時は taskDefaults.envFile を使う。";
            };
          };
        }
      );
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = lib.mapAttrsToList (name: task: {
      assertion = task.memory == null || task.memory.repo != null || cfg.taskDefaults.memoryRepo != null;
      message = "programs.autopilot5.tasks.${name}.memory.repo または programs.autopilot5.taskDefaults.memoryRepo を指定すること";
    }) cfg.tasks;

    # atelier サーバー上のエージェントが叩く gh が安全ラッパーを経由するように高優先度で配備
    environment.systemPackages = [ (lib.hiPrio cfg.package) ];

    # 全リポジトリに効くシステム Git 設定（core.hooksPath）
    programs.git = {
      enable = lib.mkDefault true;
      config.core.hooksPath = "${cfg.package}/share/autopilot5/hooks";
    };

    environment.etc."autopilot5/models.yaml" = lib.mkIf (cfg.models != null) {
      source = checkedModels;
    };
    systemd.tmpfiles.rules = lib.concatMap rulesFor cfg.agents ++ [
      # home-manager や per-user プロファイルより PATH の前にある ~/.local/bin に安全ラッパーを配備
      "d ${home}/.local/bin 0755 ${cfg.user} ${group} -"
      "L+ ${home}/.local/bin/gh - - - - ${cfg.package}/bin/safe-gh"
    ];

    systemd.user.services = lib.mapAttrs' (
      name: task:
      let
        envFile = if task.envFile != null then task.envFile else cfg.taskDefaults.envFile;
      in
      lib.nameValuePair "autopilot-task-${name}" {
        description = "autopilot5 task: ${name}";
        unitConfig.ConditionUser = cfg.user;
        path = [
          cfg.package
          "${home}/.local"
          "${home}/.config/orca/cli"
          "/etc/profiles/per-user/${cfg.user}"
          "/run/wrappers"
          "/run/current-system/sw"
        ];
        serviceConfig = {
          Type = "oneshot";
          ExecStart = "${cfg.package}/bin/autopilot-task run --config ${checkedTaskConfig name task}";
        }
        // lib.optionalAttrs (envFile != null) {
          EnvironmentFile = "-${envFile}";
        };
      }
    ) cfg.tasks;

    systemd.user.timers = lib.mapAttrs' (
      name: task:
      lib.nameValuePair "autopilot-task-${name}" {
        description = "autopilot5 task timer: ${name}";
        unitConfig.ConditionUser = cfg.user;
        wantedBy = [ "timers.target" ];
        timerConfig = {
          OnCalendar = task.trigger.schedule;
          Persistent = false;
        };
      }
    ) cfg.tasks;
  };
}
