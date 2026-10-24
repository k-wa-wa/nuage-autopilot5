# エージェントが動くホストに autopilot を入れる NixOS モジュール。
#
# - autopilot-run を PATH に入れる。
# - home/ の共通ルールとスキルを、各エージェント CLI がホーム全体で読む場所へ symlink する。
#   リポジトリの .agents/skills ではそのリポジトリでしか効かないため、ホーム側に置く。
#
# ~/.claude/settings.json などエージェントや Orca が書き換えるファイルには触れない。
{
  config,
  lib,
  ...
}:

let
  cfg = config.programs.autopilot5;
  home = config.users.users.${cfg.user}.home;
  group = config.users.users.${cfg.user}.group;
  rules = ../home/AGENTS.md;
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

    agents = lib.mkOption {
      type = lib.types.listOf (lib.types.enum (builtins.attrNames targets));
      default = builtins.attrNames targets;
      description = "共通ルールとスキルを配るエージェント CLI。";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];
    systemd.tmpfiles.rules = lib.concatMap rulesFor cfg.agents;
  };
}
