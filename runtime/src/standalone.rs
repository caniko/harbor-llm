//! Experimental Linux managed-host standalone supervisor. The original controller
//! owns admission; this owns one nondelegated systemd container, sealed executable
//! images, a private bridge connection and cleanup. This is not the specialist
//! untrusted-worker profile: same-UID host writers and engine/tool code are trusted.
//! Root invocation is unsupported. The root preparation service remains disabled
//! for launch until its distinct-writer/admission integration is qualified.
use crate::{
    Controller,
    artifact::Snapshot,
    ipc::{Exchange, Limits, Wire},
};
use harbor_llm_protocol::{
    Binding, ErrorCode, ProtocolError,
    channel::Role,
    commands::{
        self, AuthenticatedChannel, Command, CommandBody, TransferPurpose, TransferReference,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    os::{
        fd::{AsFd, AsRawFd},
        unix::{
            fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
            net::UnixListener,
        },
    },
    path::{Path, PathBuf},
    process::{Child, Command as Process, Stdio},
    thread,
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, ProtocolError>;
fn fail(code: ErrorCode) -> ProtocolError {
    ProtocolError { code }
}
fn lost<E>(_: E) -> ProtocolError {
    fail(ErrorCode::CustodyLost)
}

/// Immutable Nix-store runtime dependencies selected by the embedding application.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tools {
    /// Exact native systemd client.
    pub systemd_run: PathBuf,
    /// Matching systemd control client.
    pub systemctl: PathBuf,
    /// Namespace constructor; user namespaces must be available.
    pub bubblewrap: PathBuf,
    /// Exact Node executable; the supervisor also seals it before launch.
    pub node: PathBuf,
    /// Independently provisioned Node SHA-256.
    pub node_digest: String,
    /// Native namespace setup helper from the same qualified runtime artifact.
    pub helper: PathBuf,
    /// Independently provisioned setup-helper SHA-256.
    pub helper_digest: String,
    /// Qualified installed dispatcher module, including its immutable imports.
    pub dispatcher: PathBuf,
    /// Explicit immutable tools-only PATH, never the ambient operator PATH.
    pub path: String,
}

/// Required, non-raiseable managed execution resource ceilings.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resources {
    /// Whole original unit lifetime, including setup and observation.
    pub wall_seconds: u32,
    /// Cgroup memory limit, including private tmpfs; swap is disabled.
    pub memory_bytes: u64,
    /// Aggregate CPU quota in percent.
    pub cpu_percent: u32,
    /// All descendants, including threads and tools.
    pub tasks: u32,
    /// Private tmpfs byte limit; state is retained only through its original fd.
    pub scratch_bytes: u64,
    /// Private tmpfs inode ceiling, enforced before engine startup.
    pub scratch_inodes: u64,
}

/// Trusted application plan. No process credentials or operator environment are
/// inherited. The broker socket is an application-provisioned revocable lease.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    /// Immutable dependencies.
    pub tools: Tools,
    /// Enforced resource inputs.
    pub resources: Resources,
    /// Protected controller directory containing the broker and control sockets.
    pub control_directory: PathBuf,
    /// Application-approved engine configuration; the named provider gets the private proxy.
    pub engine_configuration: Value,
    /// The provider whose baseURL is replaced with the private broker endpoint.
    pub provider_id: String,
    /// Exact application-validated session configuration.
    pub session_configuration: Value,
    /// Exact expected engine version; readiness is also bound to the sealed image.
    pub engine_version: String,
    /// Original queued inbox identity, allocated before admission.
    pub inbox_id: String,
    /// Separately validated current cancellation grant; absent means unsupported.
    pub interrupt_authority: Option<String>,
}

/// Retained original tmpfs mount and immutable plan identity. Only verified cleanup
/// can produce this handoff. It is not persisted restart authority and cannot be
/// rebuilt from a path, a missing journal or a new generation.
pub struct RetainedState {
    directory: File,
    binding: Binding,
    plan_digest: String,
    state_digest: String,
    used: bool,
}
impl RetainedState {
    /// Pinned mount path for bounded evidence inspection by its trusted owner.
    /// Do not mutate it: a copied-state observational handoff binds these bytes.
    pub fn path(&self) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}", self.directory.as_raw_fd()))
    }
}

/// One original unit/bridge. Drop revokes the supplied lease before attempting
/// cleanup; callers must use `close` to obtain verified cleanup evidence.
pub struct Session {
    binding: Binding,
    plan: Plan,
    plan_digest: String,
    unit: String,
    invocation: Option<String>,
    cgroup: Option<File>,
    state: Option<File>,
    exchange: Option<Exchange>,
    client: Option<Child>,
    node: Snapshot,
    _helper: Snapshot,
    _engine: File,
    _seed: Option<tempfile::TempDir>,
    revoke: Box<dyn FnMut() -> bool>,
    revoked: bool,
    closed: bool,
}

fn command(binding: &Binding, body: CommandBody) -> Command {
    Command {
        schema_version: 2,
        command_schema_digest: commands::SCHEMA_DIGEST.into(),
        request_id: "original-exchange".into(),
        binding: binding.clone(),
        body,
    }
}
fn reference(purpose: TransferPurpose, bytes: &[u8]) -> TransferReference {
    TransferReference {
        transfer_id: if purpose == TransferPurpose::Input {
            "input"
        } else {
            "configuration"
        }
        .into(),
        purpose,
        digest: crate::digest(bytes),
        bytes: bytes.len().to_string(),
    }
}
fn transfer(
    exchange: &mut Exchange,
    binding: &Binding,
    reference: &TransferReference,
    bytes: &[u8],
) -> Result<()> {
    exchange.send_transfer(&command(
        binding,
        CommandBody::TransferBegin(commands::TransferBegin {
            reference: reference.clone(),
        }),
    ))?;
    for (index, chunk) in bytes.chunks(16384).enumerate() {
        exchange.send_transfer(&command(
            binding,
            CommandBody::TransferChunk(commands::TransferChunk {
                transfer_id: reference.transfer_id.clone(),
                offset: (index * 16384).to_string(),
                data: chunk.iter().map(|byte| format!("{byte:02x}")).collect(),
            }),
        ))?;
    }
    exchange.send_transfer(&command(
        binding,
        CommandBody::TransferEnd(commands::TransferEnd {
            transfer_id: reference.transfer_id.clone(),
        }),
    ))
}
fn store_file(path: &Path) -> Result<()> {
    let metadata = fs::metadata(path).map_err(lost)?;
    if !path.starts_with("/nix/store")
        || path.canonicalize().map_err(lost)? != path
        || !metadata.is_file()
        || metadata.uid() != 0
        || metadata.mode() & 0o222 != 0
    {
        return Err(fail(ErrorCode::CustodyLost));
    }
    Ok(())
}
fn digest_array(value: &str) -> Result<[u8; 32]> {
    if !crate::valid_digest(value) {
        return Err(fail(ErrorCode::InvalidFrame));
    }
    Ok(std::array::from_fn(|index| {
        u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).expect("validated digest")
    }))
}
fn verify_image(path: &Path, expected: &[u8; 32], deadline: Instant) -> Result<()> {
    let mut file = File::open(path).map_err(lost)?;
    let metadata = file.metadata().map_err(lost)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 512 * 1024 * 1024 {
        return Err(fail(ErrorCode::CustodyLost));
    }
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    let mut length = 0;
    loop {
        if Instant::now() >= deadline {
            return Err(fail(ErrorCode::BudgetExhausted));
        }
        let count = file.read(&mut buffer).map_err(lost)?;
        if count == 0 {
            break;
        }
        length += count as u64;
        if length > metadata.len() {
            return Err(fail(ErrorCode::CustodyLost));
        }
        hash.update(&buffer[..count]);
    }
    if length != metadata.len() || <[u8; 32]>::from(hash.finalize()) != *expected {
        return Err(fail(ErrorCode::CustodyLost));
    }
    Ok(())
}
// Only closed, original supervisor state enters this copier. Types, depth, names,
// total bytes and inodes are bounded on both copies; links/devices are unsupported.
// The second independent read-back authenticates the complete copied tree.
fn copy_state(
    source: &Path,
    destination: Option<&Path>,
    resources: &Resources,
    deadline: Instant,
) -> Result<String> {
    use std::path::Component;
    let mut pending = vec![(PathBuf::new(), 0)];
    let mut entries = 0u64;
    let mut total = 0u64;
    let mut hash = Sha256::new();
    while let Some((relative, depth)) = pending.pop() {
        if depth > 64 || Instant::now() >= deadline {
            return Err(fail(ErrorCode::BudgetExhausted));
        }
        let mut children = Vec::new();
        for child in fs::read_dir(source.join(&relative)).map_err(lost)? {
            entries += 1;
            if entries >= resources.scratch_inodes {
                return Err(fail(ErrorCode::BudgetExhausted));
            }
            children.push(child.map_err(lost)?.file_name());
        }
        children.sort();
        for name in children {
            let relative = relative.join(name);
            let name = relative
                .to_str()
                .ok_or_else(|| fail(ErrorCode::CustodyLost))?;
            if name.len() > 4096
                || relative
                    .components()
                    .any(|component| !matches!(component, Component::Normal(_)))
            {
                return Err(fail(ErrorCode::CustodyLost));
            }
            let path = source.join(&relative);
            let metadata = fs::symlink_metadata(&path).map_err(lost)?;
            hash.update((name.len() as u32).to_be_bytes());
            hash.update(name.as_bytes());
            if metadata.is_dir() {
                hash.update([0]);
                if let Some(destination) = destination {
                    fs::DirBuilder::new()
                        .mode(0o700)
                        .create(destination.join(&relative))
                        .map_err(lost)?;
                }
                pending.push((relative, depth + 1));
            } else if metadata.is_file() && metadata.nlink() == 1 {
                total = total
                    .checked_add(metadata.len())
                    .ok_or_else(|| fail(ErrorCode::BudgetExhausted))?;
                if total > resources.scratch_bytes {
                    return Err(fail(ErrorCode::BudgetExhausted));
                }
                hash.update([1]);
                hash.update(metadata.len().to_be_bytes());
                let mut input = File::from(
                    rustix::fs::open(
                        &path,
                        rustix::fs::OFlags::RDONLY
                            | rustix::fs::OFlags::NOFOLLOW
                            | rustix::fs::OFlags::NONBLOCK
                            | rustix::fs::OFlags::CLOEXEC,
                        rustix::fs::Mode::empty(),
                    )
                    .map_err(lost)?,
                );
                let pinned = input.metadata().map_err(lost)?;
                if (pinned.dev(), pinned.ino(), pinned.len())
                    != (metadata.dev(), metadata.ino(), metadata.len())
                {
                    return Err(fail(ErrorCode::CustodyLost));
                }
                let mut output = destination
                    .map(|destination| {
                        File::options()
                            .write(true)
                            .create_new(true)
                            .mode(0o600)
                            .open(destination.join(&relative))
                            .map_err(lost)
                    })
                    .transpose()?;
                let mut length = 0u64;
                let mut buffer = [0; 65536];
                loop {
                    if Instant::now() >= deadline {
                        return Err(fail(ErrorCode::BudgetExhausted));
                    }
                    let count = input.read(&mut buffer).map_err(lost)?;
                    if count == 0 {
                        break;
                    }
                    length += count as u64;
                    if length > metadata.len() {
                        return Err(fail(ErrorCode::CustodyLost));
                    }
                    hash.update(&buffer[..count]);
                    if let Some(output) = &mut output {
                        output.write_all(&buffer[..count]).map_err(lost)?;
                    }
                }
                if length != metadata.len() {
                    return Err(fail(ErrorCode::CustodyLost));
                }
            } else {
                return Err(fail(ErrorCode::CustodyLost));
            }
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn bounded_control(command: &mut Process) -> Result<Vec<u8>> {
    let mut child = command.spawn().map_err(lost)?;
    let result = (|| {
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| fail(ErrorCode::CustodyLost))?;
        let flags = rustix::fs::fcntl_getfl(&stdout).map_err(lost)?;
        rustix::fs::fcntl_setfl(&stdout, flags | rustix::fs::OFlags::NONBLOCK).map_err(lost)?;
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut output = Vec::new();
        let mut buffer = [0; 4096];
        let mut eof = false;
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) => eof = true,
                Ok(count) => {
                    if output.len() + count > 16384 {
                        return Err(fail(ErrorCode::BudgetExhausted));
                    }
                    output.extend_from_slice(&buffer[..count]);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => (),
                Err(error) => return Err(lost(error)),
            }
            if let Some(status) = child.try_wait().map_err(lost)? {
                if eof {
                    return if status.success() {
                        Ok(output)
                    } else {
                        Err(fail(ErrorCode::CustodyLost))
                    };
                }
            }
            if Instant::now() >= deadline {
                return Err(fail(ErrorCode::BudgetExhausted));
            }
            thread::sleep(Duration::from_millis(5));
        }
    })();
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

/// Private binary entrypoint: constrain the fresh tmpfs, verify retained limits,
/// permanently drop all capabilities, then exec the embedded bridge. Rejects the
/// initial/root user namespace, including an ordinary host-root invocation.
#[doc(hidden)]
pub fn setup() -> Result<()> {
    use rustix::{
        mount::{MountFlags, mount_remount},
        thread::{
            CapabilitiesSecureBits, CapabilitySet, CapabilitySets,
            remove_capability_from_bounding_set, set_capabilities, set_capabilities_secure_bits,
            set_no_new_privs,
        },
    };
    use std::os::unix::process::CommandExt;
    let args: Vec<_> = std::env::args().take(6).collect();
    if args.len() != 5 || !rustix::process::geteuid().is_root() {
        return Err(fail(ErrorCode::UnsupportedProfile));
    }
    let map = fs::read_to_string("/proc/self/uid_map").map_err(lost)?;
    let map: Vec<_> = map.split_whitespace().collect();
    if map.len() != 3
        || map[0] != "0"
        || map[1].parse::<u32>().ok().is_none_or(|uid| uid == 0)
        || map[2] != "1"
    {
        return Err(fail(ErrorCode::UnsupportedProfile));
    }
    let bytes = args[1].parse::<u64>().map_err(lost)?;
    let inodes = args[2].parse::<u64>().map_err(lost)?;
    if !(1024 * 1024..=256 * 1024 * 1024).contains(&bytes)
        || !(64..=65536).contains(&inodes)
        || !args[4].starts_with("gate-")
        || !args[4].ends_with(".sock")
        || args[4].contains('/')
    {
        return Err(fail(ErrorCode::InvalidFrame));
    }
    let directory = File::open("/work").map_err(lost)?;
    if rustix::fs::fstatfs(&directory).map_err(lost)?.f_type != 0x01021994 {
        return Err(fail(ErrorCode::CustodyLost));
    }
    mount_remount(
        "/work",
        MountFlags::NOSUID | MountFlags::NODEV | MountFlags::NOEXEC,
        format!("size={bytes},nr_inodes={inodes},mode=0700"),
    )
    .map_err(lost)?;
    let stat = rustix::fs::fstatvfs(&directory).map_err(lost)?;
    if stat.f_blocks * stat.f_frsize > bytes || stat.f_files > inodes {
        return Err(fail(ErrorCode::CustodyLost));
    }
    // Stay in the mount-owning user namespace long enough to bound tmpfs, then
    // prohibit descendants from regaining namespace capabilities. This sysctl is
    // scoped to this user namespace, never the host namespace rejected above.
    fs::write("/proc/sys/user/max_user_namespaces", "0").map_err(lost)?;
    set_capabilities_secure_bits(
        CapabilitiesSecureBits::NO_ROOT
            | CapabilitiesSecureBits::NO_ROOT_LOCKED
            | CapabilitiesSecureBits::NO_SETUID_FIXUP
            | CapabilitiesSecureBits::NO_SETUID_FIXUP_LOCKED
            | CapabilitiesSecureBits::NO_CAP_AMBIENT_RAISE
            | CapabilitiesSecureBits::NO_CAP_AMBIENT_RAISE_LOCKED,
    )
    .map_err(lost)?;
    for bit in 0..64 {
        match remove_capability_from_bounding_set(CapabilitySet::from_bits_retain(1 << bit)) {
            Ok(()) | Err(rustix::io::Errno::INVAL) => (),
            Err(error) => return Err(lost(error)),
        }
    }
    set_capabilities(
        None,
        CapabilitySets {
            effective: CapabilitySet::empty(),
            permitted: CapabilitySet::empty(),
            inheritable: CapabilitySet::empty(),
        },
    )
    .map_err(lost)?;
    set_no_new_privs(true).map_err(lost)?;
    if args[3] != "fresh" {
        digest_array(&args[3])?;
        let resources = Resources {
            wall_seconds: 60,
            memory_bytes: 0,
            cpu_percent: 0,
            tasks: 0,
            scratch_bytes: bytes,
            scratch_inodes: inodes,
        };
        let deadline = Instant::now() + Duration::from_secs(60);
        if copy_state(
            Path::new("/artifacts/retained"),
            Some(Path::new("/work")),
            &resources,
            deadline,
        )? != args[3]
            || copy_state(Path::new("/work"), None, &resources, deadline)? != args[3]
        {
            return Err(fail(ErrorCode::CustodyLost));
        }
    }
    Err(lost(
        Process::new("/artifacts/node")
            .args([
                "--input-type=module",
                "-e",
                include_str!("standalone.mjs"),
                &args[4],
            ])
            .env_clear()
            .exec(),
    ))
}
impl Plan {
    /// Exact plan identity to retain with application admission, not a new grant.
    pub fn digest(&self) -> Result<String> {
        Ok(crate::digest(&serde_json::to_vec(self).map_err(lost)?))
    }
    /// Identity binding the complete plan and exact sealed engine bytes. Admission
    /// must provision this value independently; computing it grants no authority.
    pub fn implementation_digest(&self, engine_digest: &str) -> Result<String> {
        digest_array(engine_digest)?;
        Ok(crate::digest(
            &serde_json::to_vec(&(self.digest()?, engine_digest)).map_err(lost)?,
        ))
    }
    fn validate(&self) -> Result<()> {
        if rustix::process::geteuid().is_root() {
            return Err(fail(ErrorCode::UnsupportedProfile));
        }
        let limits = &self.resources;
        if !(1..=3600).contains(&limits.wall_seconds)
            || !(64 * 1024 * 1024..=4 * 1024 * 1024 * 1024).contains(&limits.memory_bytes)
            || !(1..=200).contains(&limits.cpu_percent)
            || !(16..=256).contains(&limits.tasks)
            || !(1024 * 1024..=256 * 1024 * 1024).contains(&limits.scratch_bytes)
            || !(64..=65536).contains(&limits.scratch_inodes)
            || self.tools.path.len() > 16384
            || self.tools.path.is_empty()
        {
            return Err(fail(ErrorCode::BudgetExhausted));
        }
        for path in [
            &self.tools.systemd_run,
            &self.tools.systemctl,
            &self.tools.bubblewrap,
            &self.tools.node,
            &self.tools.helper,
            &self.tools.dispatcher,
        ] {
            store_file(path)?;
        }
        for path in self.tools.path.split(':') {
            let path = Path::new(path);
            if !path.starts_with("/nix/store")
                || path.canonicalize().map_err(lost)? != path
                || !path.is_dir()
            {
                return Err(fail(ErrorCode::CustodyLost));
            }
        }
        crate::private(&self.control_directory, true, false).map_err(lost)?;
        if self.control_directory.canonicalize().map_err(lost)? != self.control_directory {
            return Err(fail(ErrorCode::CustodyLost));
        }
        for value in [&self.session_configuration, &self.engine_configuration] {
            if serde_json::to_vec(value).map_err(lost)?.len() > 16384 {
                return Err(fail(ErrorCode::BudgetExhausted));
            }
        }
        if self.session_configuration["model"]["providerID"] != self.provider_id
            || self.engine_configuration["plugins"] != serde_json::json!([])
            || self.engine_configuration["warming"] != false
            || self.engine_configuration["snapshots"] != false
            || self.engine_configuration["update"] != "disable"
            || self.engine_configuration["share"] != "disabled"
            || self.engine_configuration["providers"][&self.provider_id]["models"]
                .get(
                    self.session_configuration["model"]["id"]
                        .as_str()
                        .unwrap_or(""),
                )
                .is_none()
            || self
                .interrupt_authority
                .as_ref()
                .is_some_and(|value| !crate::valid_digest(value))
        {
            return Err(fail(ErrorCode::InvalidFrame));
        }
        Ok(())
    }
}
impl Session {
    /// Launch and create exactly once inside the controller's fsynced Start fence.
    /// The trusted revoker must synchronously invalidate and close this generation's
    /// broker authority within 250 ms, including failure, and must not panic. It is
    /// retained for explicit close, failure and Drop cleanup. Its implementation
    /// and dedicated authority/budget policy are separate acceptance prerequisites.
    pub fn start(
        controller: &mut Controller,
        engine: &Snapshot,
        plan: Plan,
        revoke: Box<dyn FnMut() -> bool>,
    ) -> Result<Self> {
        plan.validate()?;
        let binding = controller.registration().binding.clone();
        let engine_digest: String = engine
            .digest()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        if binding.implementation_digest != plan.implementation_digest(&engine_digest)? {
            return Err(fail(ErrorCode::CustodyLost));
        }
        let bytes = serde_json::to_vec(&plan.session_configuration).map_err(lost)?;
        let reference = reference(TransferPurpose::Configuration, &bytes);
        let create = command(
            &binding,
            CommandBody::Create(commands::Create {
                configuration: reference.clone(),
            }),
        );
        let mut session = None;
        let result = controller.dispatch_initial(&create, |request| {
            let mut launched = Self::launch(binding.clone(), engine, plan, None, "fresh", revoke)?;
            let result = (|| {
                let exchange = launched
                    .exchange
                    .as_mut()
                    .ok_or_else(|| fail(ErrorCode::CustodyLost))?;
                transfer(exchange, &binding, &reference, &bytes)?;
                exchange.request(request)
            })();
            session = Some(launched);
            result
        });
        result.map_err(|error| fail(error.code))?;
        session.ok_or_else(|| fail(ErrorCode::CustodyLost))
    }

    /// Explicit observational server restart after verified original-unit cleanup.
    /// This consumes the handoff's one observational attempt; it never derives fresh dispatch
    /// authority. Exact-source qualification must prove restart continuity absent.
    pub fn reopen(
        binding: &Binding,
        engine: &Snapshot,
        plan: Plan,
        state: &mut RetainedState,
        revoke: Box<dyn FnMut() -> bool>,
    ) -> Result<Self> {
        plan.validate()?;
        let engine_digest: String = engine
            .digest()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        if state.binding != *binding
            || state.plan_digest != plan.digest()?
            || binding.implementation_digest != plan.implementation_digest(&engine_digest)?
        {
            return Err(fail(ErrorCode::CustodyLost));
        }
        if state.used {
            return Err(fail(ErrorCode::EffectUnknown));
        }
        state.used = true;
        Self::launch(
            binding.clone(),
            engine,
            plan,
            Some((&state.directory, &state.state_digest)),
            "observe",
            revoke,
        )
    }

    fn control(&self) -> Process {
        let mut command = Process::new(&self.plan.tools.systemctl);
        command.args(["--user", "--no-pager"]);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        command
    }
    fn properties(&self) -> Result<Value> {
        // systemd's property output is bounded by the selected keys.
        let output = bounded_control(self.control().args(["show", &self.unit, "--property=InvocationID,ControlGroup,Delegate,MemoryMax,MemorySwapMax,TasksMax,CPUQuotaPerSecUSec,KillMode,ActiveState"]))?;
        let text = std::str::from_utf8(&output).map_err(lost)?;
        let mut fields = serde_json::Map::new();
        for line in text.lines() {
            let (key, value) = line
                .split_once('=')
                .ok_or_else(|| fail(ErrorCode::CustodyLost))?;
            fields.insert(key.into(), Value::String(value.into()));
        }
        Ok(Value::Object(fields))
    }
    fn launch(
        binding: Binding,
        engine: &Snapshot,
        plan: Plan,
        state: Option<(&File, &str)>,
        mode: &str,
        revoke: Box<dyn FnMut() -> bool>,
    ) -> Result<Self> {
        let timeout = Duration::from_secs(u64::from(plan.resources.wall_seconds));
        let deadline = Instant::now() + timeout;
        let node = Snapshot::capture(
            &plan.tools.node,
            &digest_array(&plan.tools.node_digest)?,
            512 * 1024 * 1024,
            timeout,
        )?;
        let helper = Snapshot::capture(
            &plan.tools.helper,
            &digest_array(&plan.tools.helper_digest)?,
            512 * 1024 * 1024,
            timeout,
        )?;
        let mut seed = None;
        let mut seed_digest = "fresh".to_owned();
        if let Some((state, expected)) = state {
            let directory = tempfile::Builder::new()
                .prefix("retained-")
                .tempdir_in(&plan.control_directory)
                .map_err(lost)?;
            seed_digest = copy_state(
                Path::new(&format!("/proc/self/fd/{}", state.as_raw_fd())),
                Some(directory.path()),
                &plan.resources,
                deadline,
            )?;
            if seed_digest != expected
                || copy_state(directory.path(), None, &plan.resources, deadline)? != seed_digest
            {
                return Err(fail(ErrorCode::CustodyLost));
            }
            seed = Some(directory);
        }
        let mut nonce = [0; 32];
        let mut key = [0; 32];
        getrandom::fill(&mut nonce).map_err(lost)?;
        getrandom::fill(&mut key).map_err(lost)?;
        let suffix = crate::digest(&nonce);
        let gate_name = format!("gate-{}.sock", &suffix[..12]);
        let gate = plan.control_directory.join(&gate_name);
        let control_directory =
            crate::private(&plan.control_directory, true, false).map_err(lost)?;
        let listener = UnixListener::bind(format!(
            "/proc/self/fd/{}/{gate_name}",
            control_directory.as_raw_fd()
        ))
        .map_err(lost)?;
        listener.set_nonblocking(true).map_err(lost)?;
        let unit = format!("harbor-llm-{}.service", &suffix[..32]);
        let mut session = Self {
            binding: binding.clone(),
            plan_digest: plan.digest()?,
            plan,
            unit,
            invocation: None,
            cgroup: None,
            state: None,
            exchange: None,
            client: None,
            node,
            _helper: helper,
            _engine: File::from(engine.as_fd().try_clone_to_owned().map_err(lost)?),
            _seed: seed,
            revoke,
            revoked: false,
            closed: false,
        };
        let diagnostic = File::options()
            .write(true)
            .create_new(true)
            .open(
                session
                    .plan
                    .control_directory
                    .join(format!("{gate_name}.stderr")),
            )
            .map_err(lost)?;
        let mut launch = Process::new(&session.plan.tools.systemd_run);
        launch
            .args(["--user", "--wait", "--pipe", "--quiet"])
            .arg(format!("--unit={}", session.unit));
        for property in [
            format!("RuntimeMaxSec={}s", session.plan.resources.wall_seconds),
            format!("MemoryMax={}", session.plan.resources.memory_bytes),
            "MemorySwapMax=0".into(),
            format!("TasksMax={}", session.plan.resources.tasks),
            format!("CPUQuota={}%", session.plan.resources.cpu_percent),
            "KillMode=control-group".into(),
            "Delegate=no".into(),
            "Restart=no".into(),
            "NoNewPrivileges=yes".into(),
            "TimeoutStopSec=250ms".into(),
            "SendSIGKILL=yes".into(),
            "LimitCORE=0".into(),
            "LimitNOFILE=128".into(),
            "UMask=0077".into(),
        ] {
            launch.arg(format!("--property={property}"));
        }
        let parent = std::process::id();
        let engine_path = format!("/proc/{parent}/fd/{}", session._engine.as_raw_fd());
        let node_path = format!("/proc/{parent}/fd/{}", session.node.as_fd().as_raw_fd());
        let helper_path = format!("/proc/{parent}/fd/{}", session._helper.as_fd().as_raw_fd());
        // The manager opens the original descriptors before user-namespace setup.
        // Bubblewrap copies sealed image bytes to readonly mounts; both copies are
        // verified before bootstrap credentials. Direct memfd binds cannot resolve
        // anonymous names, and cross-process /proc paths lose namespace access.
        for (path, name) in [
            (&engine_path, "engine"),
            (&node_path, "node"),
            (&helper_path, "helper"),
        ] {
            launch.arg(format!("--property=OpenFile={path}:{name}:read-only"));
        }
        launch.arg(format!(
            "--property=OpenFile=/proc/{parent}/fd/{}:control:read-only",
            control_directory.as_raw_fd()
        ));
        if let Some(seed) = &session._seed {
            launch.arg(format!(
                "--property=OpenFile={}:state:read-only",
                seed.path().display()
            ));
        }
        launch
            .arg(&session.plan.tools.bubblewrap)
            .args([
                "--unshare-all",
                "--unshare-user",
                "--unshare-cgroup",
                "--die-with-parent",
                "--new-session",
                "--uid",
                "0",
                "--gid",
                "0",
                "--cap-drop",
                "ALL",
                "--cap-add",
                "CAP_SYS_ADMIN",
                "--cap-add",
                "CAP_SETPCAP",
                "--cap-add",
                "CAP_SYS_RESOURCE",
                "--clearenv",
                "--ro-bind",
                "/nix/store",
                "/nix/store",
                "--proc",
                "/proc",
                "--dev",
                "/dev",
                "--ro-bind-fd",
            ])
            .arg("6")
            .arg("/control")
            .args([
                "--perms",
                "0500",
                "--ro-bind-data",
                "3",
                "/artifacts/engine",
                "--perms",
                "0500",
                "--ro-bind-data",
                "4",
                "/artifacts/node",
                "--perms",
                "0500",
                "--ro-bind-data",
                "5",
                "/artifacts/helper",
            ]);
        if session._seed.is_some() {
            launch
                .arg("--ro-bind-fd")
                .arg("7")
                .arg("/artifacts/retained");
        }
        launch.args([
            "--size",
            &session.plan.resources.scratch_bytes.to_string(),
            "--tmpfs",
            "/work",
        ]);
        launch
            .args([
                "--symlink",
                "/work/tmp",
                "/tmp",
                "--symlink",
                "/work/home",
                "/home",
                "--remount-ro",
                "/",
                "--chdir",
                "/work",
                "--",
                "/artifacts/helper",
                &session.plan.resources.scratch_bytes.to_string(),
                &session.plan.resources.scratch_inodes.to_string(),
                &seed_digest,
                &gate_name,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(diagnostic));
        session.client = Some(launch.spawn().map_err(lost)?);
        let stream = loop {
            if Instant::now() >= deadline
                || session
                    .client
                    .as_mut()
                    .unwrap()
                    .try_wait()
                    .map_err(lost)?
                    .is_some()
            {
                return Err(fail(ErrorCode::CustodyLost));
            }
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10))
                }
                Err(error) => return Err(lost(error)),
            }
        };
        let peer = rustix::net::sockopt::socket_peercred(&stream).map_err(lost)?;
        let pid = peer.pid.as_raw_nonzero().get();
        verify_image(
            Path::new(&format!("/proc/{pid}/exe")),
            &session.node.digest(),
            deadline,
        )?;
        verify_image(
            Path::new(&format!("/proc/{pid}/root/artifacts/engine")),
            &engine.digest(),
            deadline,
        )?;
        verify_image(
            Path::new(&format!("/proc/{pid}/root/artifacts/helper")),
            &session._helper.digest(),
            deadline,
        )?;
        let props = session.properties()?;
        let cgroup = props["ControlGroup"]
            .as_str()
            .ok_or_else(|| fail(ErrorCode::CustodyLost))?;
        if peer.uid != rustix::process::geteuid()
            || !cgroup.starts_with("/user.slice/")
            || cgroup.contains("..")
            || fs::read_to_string(format!("/proc/{pid}/cgroup"))
                .map_err(lost)?
                .trim()
                != format!("0::{cgroup}")
            || props["Delegate"] != "no"
            || props["KillMode"] != "control-group"
            || props["MemoryMax"]
                .as_str()
                .and_then(|value| value.parse::<u64>().ok())
                != Some(session.plan.resources.memory_bytes)
            || props["MemorySwapMax"] != "0"
            || props["TasksMax"]
                .as_str()
                .and_then(|value| value.parse::<u32>().ok())
                != Some(session.plan.resources.tasks)
        {
            return Err(fail(ErrorCode::CustodyLost));
        }
        session.invocation = props["InvocationID"]
            .as_str()
            .filter(|id| id.len() == 32)
            .map(str::to_owned);
        if session.invocation.is_none() {
            return Err(fail(ErrorCode::CustodyLost));
        }
        session.cgroup = Some(
            File::open(Path::new("/sys/fs/cgroup").join(cgroup.trim_start_matches('/')))
                .map_err(lost)?,
        );
        let cpu: Vec<u64> = fs::read_to_string(format!(
            "/proc/self/fd/{}/cpu.max",
            session.cgroup.as_ref().unwrap().as_raw_fd()
        ))
        .map_err(lost)?
        .split_whitespace()
        .map(str::parse)
        .collect::<std::result::Result<_, _>>()
        .map_err(lost)?;
        if cpu.len() != 2
            || cpu[1] == 0
            || cpu[0] * 100 != u64::from(session.plan.resources.cpu_percent) * cpu[1]
        {
            return Err(fail(ErrorCode::CustodyLost));
        }
        // The only connection is authenticated against the actual sealed Node
        // process and original nondelegated unit before receiving any credentials.
        drop(listener);
        fs::remove_file(&gate).map_err(lost)?;
        let digest = digest_array(&crate::digest(&serde_json::to_vec(&binding).map_err(lost)?))?;
        let mut wire = Wire::new(
            stream,
            Limits {
                timeout: deadline.saturating_duration_since(Instant::now()),
                records: 4096,
                bytes: 64 * 1024 * 1024,
            },
        )?;
        wire.send(&serde_json::to_vec(&serde_json::json!({"binding":binding,"key":key,"nonce":nonce,"digest":digest,"mode":mode,"plan":session.plan})).map_err(lost)?)?;
        let ready: Value = serde_json::from_slice(
            &wire
                .receive(16384)?
                .ok_or_else(|| fail(ErrorCode::CustodyLost))?,
        )
        .map_err(lost)?;
        if ready != serde_json::json!({"ready":true}) {
            return Err(fail(ErrorCode::CustodyLost));
        }
        session.state = Some(File::open(format!("/proc/{pid}/root/work")).map_err(lost)?);
        session.exchange = Some(Exchange::from_wire(
            wire,
            AuthenticatedChannel::new(&key, &nonce, &digest, Role::Controller),
            binding,
        ));
        key.fill(0);
        nonce.fill(0);
        Ok(session)
    }
    /// Admit only the original exact-byte input under the durable Submit fence.
    pub fn submit(&mut self, controller: &mut Controller, bytes: &[u8]) -> Result<()> {
        if crate::digest(bytes) != self.binding.input_digest {
            return Err(fail(ErrorCode::CustodyLost));
        }
        let reference = reference(TransferPurpose::Input, bytes);
        let exchange = self
            .exchange
            .as_mut()
            .ok_or_else(|| fail(ErrorCode::CustodyLost))?;
        controller
            .dispatch_initial(
                &command(
                    &self.binding,
                    CommandBody::Submit(commands::Submit {
                        handle: self.binding.execution_id.clone(),
                        inbox_id: self.plan.inbox_id.clone(),
                        input: reference.clone(),
                    }),
                ),
                |request| {
                    transfer(exchange, &self.binding, &reference, bytes)?;
                    exchange.request(request)
                },
            )
            .map_err(|error| fail(error.code))?;
        Ok(())
    }
    /// Release only the original admitted input, once, under the Execute fence.
    pub fn execute(&mut self, controller: &mut Controller) -> Result<()> {
        self.dispatch_execute(controller, false)
    }
    fn dispatch_execute(&mut self, controller: &mut Controller, lose_reply: bool) -> Result<()> {
        let request = command(
            &self.binding,
            CommandBody::Execute(commands::Execute {
                handle: self.binding.execution_id.clone(),
                inbox_id: self.plan.inbox_id.clone(),
                input_digest: self.binding.input_digest.clone(),
            }),
        );
        controller
            .dispatch_initial(&request, |request| {
                let exchange = self
                    .exchange
                    .as_mut()
                    .ok_or_else(|| fail(ErrorCode::CustodyLost))?;
                let reply = exchange.request(request)?;
                if lose_reply {
                    return Err(fail(ErrorCode::TransportFailed));
                }
                Ok(reply)
            })
            .map_err(|error| fail(error.code))?;
        Ok(())
    }
    /// Discard an actual release receipt to exercise final-supervisor UNKNOWN.
    /// This is fault injection, never recovery or another release attempt.
    #[cfg(feature = "native-conformance")]
    pub fn execute_losing_reply_for_conformance(
        &mut self,
        controller: &mut Controller,
    ) -> Result<()> {
        self.dispatch_execute(controller, true)
    }
    /// Bounded read-only recovery through the original authenticated bridge.
    pub fn reconcile(&mut self) -> Result<Vec<u8>> {
        self.exchange
            .as_mut()
            .ok_or_else(|| fail(ErrorCode::CustodyLost))?
            .reconcile(
                &command(
                    &self.binding,
                    CommandBody::Reconcile(commands::Target {
                        handle: self.binding.execution_id.clone(),
                    }),
                ),
                1024 * 1024,
            )
    }
    /// Interrupt the bound execution using separately authenticated current authority.
    pub fn interrupt(&mut self, controller: &mut Controller, authority: &str) -> Result<()> {
        if self.plan.interrupt_authority.as_deref() != Some(authority) {
            return Err(fail(ErrorCode::AuthorityDenied));
        }
        let request = command(
            &self.binding,
            CommandBody::Interrupt(commands::Cancel {
                handle: self.binding.execution_id.clone(),
                authority_digest: authority.into(),
            }),
        );
        controller
            .dispatch_interrupt(&request, authority, |request| {
                self.exchange
                    .as_mut()
                    .ok_or_else(|| fail(ErrorCode::CustodyLost))?
                    .request(request)
            })
            .map_err(|error| fail(error.code))?;
        Ok(())
    }
    /// Bound original unit identity, for the embedding application's evidence ledger.
    pub fn unit(&self) -> &str {
        &self.unit
    }
    /// Original private state mount for bounded evidence reads, never another launch grant.
    pub fn state_path(&self) -> Result<PathBuf> {
        Ok(PathBuf::from(format!(
            "/proc/self/fd/{}",
            self.state
                .as_ref()
                .ok_or_else(|| fail(ErrorCode::CustodyLost))?
                .as_raw_fd()
        )))
    }

    fn cleanup(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        // Revoke even when startup/IPC failed. Never let a cleanup error skip it.
        if !self.revoked {
            self.revoked = (self.revoke)();
        }
        if let Some(exchange) = &mut self.exchange {
            exchange.close();
        }
        self.exchange = None;
        if let Some(invocation) = &self.invocation {
            if self.properties()?["InvocationID"].as_str() != Some(invocation.as_str()) {
                return Err(fail(ErrorCode::CustodyLost));
            }
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut stop = self
            .control()
            .args(["stop", "--no-block", &self.unit])
            .spawn()
            .map_err(lost)?;
        while stop.try_wait().map_err(lost)?.is_none() {
            if Instant::now() >= deadline {
                let _ = stop.kill();
                let _ = stop.wait();
                return Err(fail(ErrorCode::CustodyLost));
            }
            thread::sleep(Duration::from_millis(5));
        }
        if let Some(cgroup) = &self.cgroup {
            loop {
                match fs::read_to_string(format!(
                    "/proc/self/fd/{}/cgroup.events",
                    cgroup.as_raw_fd()
                )) {
                    Ok(events) if events.lines().any(|line| line == "populated 0") => break,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                    _ if Instant::now() >= deadline => return Err(fail(ErrorCode::CustodyLost)),
                    _ => thread::sleep(Duration::from_millis(10)),
                }
            }
        } else if self.client.is_some() {
            return Err(fail(ErrorCode::CustodyLost));
        }
        if let Some(client) = &mut self.client {
            if client.try_wait().map_err(lost)?.is_none() {
                let _ = client.kill();
            }
            client.wait().map_err(lost)?;
        }
        self.closed = true;
        if !self.revoked {
            return Err(fail(ErrorCode::CustodyLost));
        }
        Ok(())
    }
    /// Revoke first, stop the original whole cgroup and verify it empty. Failure
    /// quarantines this state: no retained restart handoff is returned.
    pub fn close(mut self) -> Result<RetainedState> {
        self.cleanup()?;
        let path = self.state_path()?;
        let database = fs::symlink_metadata(path.join("engine.db")).map_err(lost)?;
        if !database.is_file() || database.len() == 0 {
            return Err(fail(ErrorCode::CustodyLost));
        }
        let state_digest = copy_state(
            &path,
            None,
            &self.plan.resources,
            Instant::now() + Duration::from_secs(2),
        )?;
        Ok(RetainedState {
            directory: self
                .state
                .take()
                .ok_or_else(|| fail(ErrorCode::CustodyLost))?,
            binding: self.binding.clone(),
            plan_digest: self.plan_digest.clone(),
            state_digest,
            used: false,
        })
    }

    /// Explicit synthetic fault injection, available only in native conformance
    /// builds. Revoke before killing the original whole unit; never a retry route.
    #[cfg(feature = "native-conformance")]
    pub fn crash_for_conformance(mut self) -> Result<RetainedState> {
        self.revoked = (self.revoke)();
        if !self.revoked {
            return Err(fail(ErrorCode::CustodyLost));
        }
        let current = self.properties()?;
        if current["InvocationID"].as_str() != self.invocation.as_deref() {
            return Err(fail(ErrorCode::CustodyLost));
        }
        bounded_control(self.control().args([
            "kill",
            "--kill-whom=all",
            "--signal=KILL",
            &self.unit,
        ]))?;
        self.close()
    }

    #[cfg(all(test, feature = "native-conformance"))]
    pub(crate) fn reject_stale_cleanup_for_conformance(&mut self) -> Result<()> {
        let original = self.invocation.replace("0".repeat(32));
        let result = self.cleanup();
        self.invocation = original;
        result
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closed_state_copy_is_independently_bound_and_rejects_links_and_ceilings() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let copy = root.path().join("copy");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&copy).unwrap();
        fs::create_dir(source.join("nested")).unwrap();
        fs::write(source.join("nested/original"), b"retained bytes").unwrap();
        let resources = Resources {
            wall_seconds: 60,
            memory_bytes: 0,
            cpu_percent: 0,
            tasks: 0,
            scratch_bytes: 1024,
            scratch_inodes: 16,
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        let digest = copy_state(&source, Some(&copy), &resources, deadline).unwrap();
        assert_eq!(
            copy_state(&copy, None, &resources, deadline).unwrap(),
            digest
        );
        fs::write(copy.join("nested/original"), b"changed").unwrap();
        assert_ne!(
            copy_state(&copy, None, &resources, deadline).unwrap(),
            digest
        );
        assert_eq!(
            copy_state(
                &source,
                None,
                &Resources {
                    scratch_bytes: 1,
                    ..resources.clone()
                },
                deadline
            )
            .unwrap_err()
            .code,
            ErrorCode::BudgetExhausted
        );
        assert_eq!(
            copy_state(
                &source,
                None,
                &Resources {
                    scratch_inodes: 1,
                    ..resources.clone()
                },
                deadline
            )
            .unwrap_err()
            .code,
            ErrorCode::BudgetExhausted
        );
        std::os::unix::fs::symlink("/etc", source.join("foreign")).unwrap();
        assert_eq!(
            copy_state(&source, None, &resources, deadline)
                .unwrap_err()
                .code,
            ErrorCode::CustodyLost
        );
    }
}
