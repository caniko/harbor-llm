{
  config,
  lib,
  ...
}: let
  cfg = config.services.harbor-llm-custodian;
  state = "/var/lib/harbor-llm-custodian";
  runtime = "/run/harbor-llm-custodian";
  group =
    if cfg.controllerGroup == null
    then "root"
    else cfg.controllerGroup;
  configuration = builtins.toFile "harbor-llm-custodian.json" (builtins.toJSON {
    version = 1;
    stateDirectory = "${state}/executions";
    admissionDirectory = "${state}/admissions";
    inherit (cfg) maximumArtifactBytes timeoutMs;
  });
in {
  options.services.harbor-llm-custodian = {
    enable = lib.mkEnableOption "the preparation-only Harbor LLM Linux custodian";
    package = lib.mkOption {
      type = lib.types.package;
      description = "Package containing the native harbor-llm-custodian executable.";
    };
    controllerGroup = lib.mkOption {
      type = lib.types.nullOr (lib.types.strMatching "[a-z_][a-z0-9_-]*");
      default = null;
      description = ''
        Explicit existing controller group permitted to connect. Null restricts
        the socket to root. Membership alone never grants an admission; every
        preparation requires an independent root-issued record for the peer UID.
      '';
    };
    maximumArtifactBytes = lib.mkOption {
      type = lib.types.ints.between 1 (512 * 1024 * 1024);
      default = 512 * 1024 * 1024;
      description = "Artifact capture ceiling; consumers may only tighten it.";
    };
    timeoutMs = lib.mkOption {
      type = lib.types.ints.between 1 60000;
      default = 30000;
      description = "Non-renewable preparation connection lifetime in milliseconds.";
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.controllerGroup == null || builtins.hasAttr group config.users.groups;
        message = "harbor-llm-custodian.controllerGroup must name an explicitly declared group";
      }
    ];
    systemd.tmpfiles.rules = [
      "d ${runtime} 0750 root ${group} -"
      "d ${state} 0700 root root -"
      "d ${state}/executions 0700 root root -"
      "d ${state}/admissions 0700 root root -"
      "d ${state}/admissions/pending 0700 root root -"
      "d ${state}/admissions/consumed 0700 root root -"
    ];
    systemd.sockets.harbor-llm-custodian = {
      description = "Harbor LLM preparation control socket";
      wantedBy = ["sockets.target"];
      socketConfig = {
        ListenStream = "${runtime}/control.sock";
        Accept = true;
        SocketUser = "root";
        SocketGroup = group;
        SocketMode =
          if cfg.controllerGroup == null
          then "0600"
          else "0660";
        MaxConnections = 4;
        TriggerLimitIntervalSec = "60s";
        TriggerLimitBurst = 32;
        RemoveOnStop = true;
      };
    };
    systemd.services."harbor-llm-custodian@" = {
      description = "Harbor LLM bounded artifact preparation";
      serviceConfig = {
        Type = "exec";
        ExecStart = "${cfg.package}/bin/harbor-llm-custodian serve --config ${configuration}";
        StandardInput = "socket";
        StandardOutput = "socket";
        StandardError = "journal";
        User = "root";
        Group = "root";
        UMask = "0077";
        Restart = "no";
        RuntimeMaxSec = "${toString cfg.timeoutMs}ms";
        TimeoutStopSec = "250ms";
        KillMode = "control-group";
        SendSIGKILL = true;
        MemoryMax = "768M";
        MemorySwapMax = 0;
        TasksMax = 4;
        CPUQuota = "100%";
        LimitCORE = 0;
        LimitNOFILE = 64;
        NoNewPrivileges = true;
        CapabilityBoundingSet = "";
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [state];
        PrivateNetwork = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        RestrictAddressFamilies = ["AF_UNIX"];
        RestrictSUIDSGID = true;
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
      };
    };
  };
}
