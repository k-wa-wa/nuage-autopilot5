{
  description = "autopilot - Orca 上の窓口エージェントから任された仕事を裏で完走させる";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        packages.autopilot-run = pkgs.callPackage ./nix/package.nix { };
        packages.default = self.packages.${system}.autopilot-run;

        checks = {
          metrics-collector =
            pkgs.runCommand "autopilot5-test-metrics-collector"
              {
                nativeBuildInputs = [ pkgs.python3 ];
              }
              ''
                cp -r ${./metrics} ./metrics
                cd metrics
                python3 -m unittest test_collector.py
                touch $out
              '';
          cost-watcher =
            pkgs.runCommand "autopilot5-test-cost-watcher"
              {
                nativeBuildInputs = [ pkgs.python3 ];
              }
              ''
                cp -r ${./metrics} ./metrics
                cd metrics
                python3 -m unittest test_cost_watcher.py
                touch $out
              '';
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.bun
            pkgs.git
            pkgs.gh
          ];
        };
      }
    )
    // {
      nixosModules.autopilot5 =
        { pkgs, lib, ... }:
        {
          imports = [ ./nix/module.nix ];
          programs.autopilot5.package =
            lib.mkDefault
              self.packages.${pkgs.stdenv.hostPlatform.system}.autopilot-run;
        };
      nixosModules.default = self.nixosModules.autopilot5;
    };
}
