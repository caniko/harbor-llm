{
  pkgs,
  module,
}: let
  evaluate = extra:
    (import "${pkgs.path}/nixos/lib/eval-config.nix" {
      system = pkgs.stdenv.hostPlatform.system;
      modules = [
        module
        {
          nixpkgs.pkgs = pkgs;
          system.stateVersion = "26.05";
        }
        extra
      ];
    }).config;
  disabled = evaluate {};
  enabled = evaluate {services.harbor-llm-custodian.enable = true;};
  grouped = evaluate {
    services.harbor-llm-custodian = {
      enable = true;
      controllerGroup = "fixture-controllers";
      timeoutMs = 1500;
    };
    users.groups.fixture-controllers = {};
  };
  socket = enabled.systemd.sockets.harbor-llm-custodian.socketConfig;
  service = enabled.systemd.services."harbor-llm-custodian@".serviceConfig;
in
  assert !(disabled.services.harbor-llm-custodian.enable);
  assert !(disabled.systemd.sockets ? harbor-llm-custodian);
  assert !(disabled.systemd.services ? "harbor-llm-custodian@");
  assert socket.Accept && socket.SocketMode == "0600" && socket.SocketUser == "root";
  assert socket.MaxConnections == 4 && socket.TriggerLimitBurst == 32;
  assert grouped.systemd.sockets.harbor-llm-custodian.socketConfig.SocketMode == "0660";
  assert grouped.systemd.sockets.harbor-llm-custodian.socketConfig.SocketGroup == "fixture-controllers";
  assert grouped.systemd.services."harbor-llm-custodian@".serviceConfig.RuntimeMaxSec == "1500ms";
  assert service.User == "root" && service.Restart == "no";
  assert service.KillMode == "control-group" && service.SendSIGKILL;
  assert service.RuntimeMaxSec == "30000ms" && service.TimeoutStopSec == "250ms";
  assert service.MemoryMax == "768M" && service.TasksMax == 4 && service.CPUQuota == "100%";
  assert service.ProtectSystem == "strict" && service.PrivateNetwork && service.NoNewPrivileges;
  assert service.StandardInput == "socket" && service.StandardOutput == "socket";
    pkgs.runCommand "harbor-llm-custodian-module" {} ''
      touch $out
    ''
