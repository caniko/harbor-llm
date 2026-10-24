import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readlink, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { inflateSync } from "node:zlib";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
// Only in-flight exports are shared. Completed environments remain owned by
// direnv: arbitrary hooks and credentials must not acquire a second stale cache.
const preparations = new Map();
const knownWatches = new Map();

function decodeWatches(value) {
  if (typeof value !== "string") throw new Error("direnv export did not report watched inputs");
  const watches = JSON.parse(inflateSync(Buffer.from(value, "base64url"), { maxOutputLength: 8 * 1024 * 1024 }));
  if (!Array.isArray(watches) || watches.some(w => !path.isAbsolute(w.path ?? "") || !Number.isSafeInteger(w.modtime) || typeof w.exists !== "boolean")) {
    throw new Error("Invalid direnv watch generation");
  }
  return watches;
}

async function watchState(file) {
  try {
    const [link, target] = await Promise.all([lstat(file), stat(file)]);
    return [file, link.ino, link.size, link.mtimeMs, target.ino, target.size, target.mtimeMs];
  } catch (error) { if (error.code === "ENOENT") return [file, null]; throw error; }
}

async function watchGeneration(files) {
  // Bounded batches avoid exhausting file descriptors on recursive watch_dir.
  const states = [];
  for (let start = 0; start < files.length; start += 64) {
    states.push(...await Promise.all(files.slice(start, start + 64).map(watchInputState)));
  }
  return createHash("sha256").update(JSON.stringify(states)).digest("hex");
}

async function watchInputState(file) {
  const state = await watchState(file);
  if (state[1] === null || !/^(?:flake|nix)-profile(?:-.+)?\.rc$/.test(path.basename(file))) return state;
  const profile = file.slice(0, -3);
  try { if (!(await lstat(profile)).isSymbolicLink()) return state; }
  catch (error) { if (error.code === "ENOENT") return state; throw error; }
  // nix-direnv touches its watched profile body on every GC-root refresh.
  // Compare the body and retained target instead: manual cache edits still
  // invalidate waiters, including edits with unchanged size and timestamps.
  if (state[5] > 8 * 1024 * 1024) throw new Error("nix-direnv cached environment exceeds the preparation limit");
  const contents = await readFile(file);
  if (contents.length > 8 * 1024 * 1024) throw new Error("nix-direnv cached environment exceeds the preparation limit");
  state[3] = state[6] = null;
  return [...state, await readlink(profile), createHash("sha256").update(contents).digest("hex")];
}

async function validateWatches(watches) {
  for (const watch of watches) {
    const state = await watchState(watch.path);
    if ((state[1] !== null) !== watch.exists
      || (watch.exists && Math.floor(Math.max(state[3], state[6]) / 1000) !== watch.modtime)) {
      throw new Error("Project watched inputs changed during preparation; retry");
    }
  }
}

async function sharedPreparation(key, signal, prepare, onJoin) {
  signal?.throwIfAborted();
  let state = preparations.get(key);
  const joined = !!state;
  if (!state) {
    const controller = new AbortController();
    state = { controller, waiters: 0, id: randomUUID() };
    state.promise = Promise.resolve().then(() => prepare(controller.signal, state.id)).finally(() => {
      if (preparations.get(key) === state) preparations.delete(key);
    });
    // The final waiter can leave before subprocess cleanup finishes.
    state.promise.catch(() => {});
    preparations.set(key, state);
  }
  onJoin?.({ preparationID: state.id, shared: joined });
  state.waiters++;
  let abort;
  try {
    return await Promise.race([state.promise, new Promise((_, reject) => {
      abort = () => {
        const error = new Error("Project environment preparation cancelled");
        error.code = "CANCELLED";
        error.preparation = { phase: "direnv export", reason: "cancelled", status: "failed" };
        reject(error);
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    })]);
  } finally {
    signal?.removeEventListener("abort", abort);
    if (--state.waiters === 0) {
      if (preparations.get(key) === state) preparations.delete(key);
      state.controller.abort();
    }
  }
}

async function revision(file) {
  return createHash("sha256").update(file).update("\n").update(await readFile(file)).digest("hex");
}

export class EnvironmentApprovalRequired extends Error {
  constructor(project, envrc, hash) {
    super(`Project .envrc needs operator approval: ${envrc}`);
    this.name = "EnvironmentApprovalRequired";
    this.project = project;
    this.envrc = envrc;
    this.revision = hash;
  }

  async isCurrent() {
    try { return await realpath(this.envrc) === this.envrc && await revision(this.envrc) === this.revision; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }
}
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const OUTSIDE_ROOTS = "Working directory is outside configured project roots";
const SELECTION_NEEDS_ENVRC = "Shell selection requires a project .envrc inside the configured roots";
const SELECTION_NEEDS_LOCAL_ENVRC = "Shell selection requires a .envrc inside the selected flake root; inherited ancestor environments do not apply to explicit selection";

// Selection metadata only. Every launch asks direnv to evaluate from the
// same baseline; nix-direnv owns its build cache and watch invalidation.
export function createProjectEnvironments({ roots, direnv, nix, system, baseline, bootstrapEnvironment, consistencyLocks = {}, preparationLockDirectory, direnvApproval = "auto", preparationTimeoutMs = 600_000, onProgress, setsid = "setsid", flock = "flock" }) {
  if (!["auto", "manual"].includes(direnvApproval)) throw new Error("direnvApproval must be auto or manual");
  if (!Number.isSafeInteger(preparationTimeoutMs) || preparationTimeoutMs <= 0 || preparationTimeoutMs > 3_600_000) {
    throw new Error("preparationTimeoutMs must be a positive integer no greater than 3600000");
  }
  if (!roots?.length || ![...roots, direnv, nix].every((p) => typeof p === "string" && path.isAbsolute(p))) {
    throw new Error("Project environments require absolute roots and executable paths");
  }
  if (preparationLockDirectory !== undefined && (typeof preparationLockDirectory !== "string" || !path.isAbsolute(preparationLockDirectory))) {
    throw new Error("preparationLockDirectory must be an absolute path");
  }
  const selections = new Map();
  const blocked = new Map();
  if (bootstrapEnvironment !== undefined && (!bootstrapEnvironment || typeof bootstrapEnvironment !== "object"
    || Array.isArray(bootstrapEnvironment) || typeof bootstrapEnvironment.PATH !== "string" || !bootstrapEnvironment.PATH
    || typeof bootstrapEnvironment.HOME !== "string" || !bootstrapEnvironment.HOME
    || !path.isAbsolute(bootstrapEnvironment.HOME) || Object.entries(bootstrapEnvironment).some(([name, value]) =>
      typeof value !== "string" || name.startsWith("DIRENV_") || name.startsWith("PROJECT_DEV_SHELL") || name === "NIX_DIRENV_DID_FALLBACK"))) {
    throw new Error("bootstrapEnvironment must be an independently configured string environment without project markers");
  }
  const bootstrap = bootstrapEnvironment === undefined ? null : Object.freeze({ ...bootstrapEnvironment });
  if (!consistencyLocks || typeof consistencyLocks !== "object" || Array.isArray(consistencyLocks)
    || Object.entries(consistencyLocks).some(([root, file]) => !path.isAbsolute(root) || typeof file !== "string" || !path.isAbsolute(file))) {
    throw new Error("consistencyLocks must map absolute project roots to absolute lock anchors");
  }
  async function consistencyLock(root) {
    const file = consistencyLocks[root];
    if (!file) return undefined;
    const anchor = await open(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      const info = await anchor.stat();
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error("Invalid environment definition lock anchor");
    } finally { await anchor.close(); }
    return file;
  }
  const base = { ...baseline };
  for (const name of Object.keys(base)) {
    if (name.startsWith("DIRENV_") || name.startsWith("PROJECT_DEV_SHELL") || name === "NIX_DIRENV_DID_FALLBACK") delete base[name];
  }
  const key = (sessionID, root) => {
    if (typeof sessionID !== "string" || !sessionID) throw new Error("Session identity is required");
    return JSON.stringify([sessionID, root]);
  };
  async function run(binary, args, cwd, env, signal, detail = {}) {
    const timeoutMs = args[0] === "export" ? preparationTimeoutMs : args[0] === "eval" ? 120_000 : 10_000;
    const progress = { preparationID: randomUUID(), phase: `${path.basename(binary)} ${args[0]}`, cwd, timeoutMs, ...detail };
    const started = performance.now();
    const deadline = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; deadline.abort(); }, timeoutMs);
    const combined = AbortSignal.any([deadline.signal, ...(signal ? [signal] : [])]);
    let child, closed;
    try {
      combined.throwIfAborted();
      onProgress?.({ ...progress, status: "preparing" });
      // execFile does not forward a `detached` option. Linux setsid gives
      // this preparation its own process group while retaining stdlib limits.
      const grouped = process.platform === "linux";
      const invocation = detail.lock ? [flock, "--exclusive", detail.lock, binary, ...args] : [binary, ...args];
      const guarded = detail.readLock ? [flock, "--shared", detail.readLock, ...invocation] : invocation;
      const execution = exec(grouped ? setsid : guarded[0], grouped ? ["--", ...guarded] : guarded.slice(1), { cwd, env, signal: combined, maxBuffer: 8 * 1024 * 1024 });
      child = execution.child;
      closed = new Promise((resolve) => child.once("close", resolve));
      const result = await execution;
      onProgress?.({ ...progress, status: "ready", elapsedMs: Math.round(performance.now() - started) });
      return result.stdout;
    } catch (error) {
      // A timed-out direnv can leave its bash/Nix children alive. Reap this
      // preparation's private process group, never the caller's running jobs.
      if (child?.pid) {
        try { process.kill(process.platform === "linux" ? -child.pid : child.pid, "SIGKILL"); }
        catch (killError) { if (killError.code !== "ESRCH") throw new Error("Cannot terminate failed environment preparation"); }
      }
      if (closed) await closed;
      // Hook output can contain credentials. Never forward stdout/stderr.
      const lockDrift = !signal?.aborted && !timedOut
        && /requires lock file changes but they're not allowed/.test(error.stderr ?? "");
      const reason = signal?.aborted ? "cancelled" : timedOut ? "timeout" : lockDrift ? "lock file changes required"
        : error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "output limit exceeded"
          : error.signal ? `terminated by ${error.signal}` : `exit ${error.code ?? "unknown"}`;
      const result = { ...progress, status: "failed", reason, elapsedMs: Math.round(performance.now() - started) };
      onProgress?.(result);
      const failure = new Error(`Project environment preparation failed: ${result.phase}; cwd=${cwd}; envrc=${detail.envrc ?? "not yet resolved"}; approval=${detail.approval ?? "not yet checked"}; ${reason}; elapsed=${result.elapsedMs}ms; limit=${timeoutMs}ms; preparation=${progress.preparationID}`);
      failure.code = signal?.aborted ? "CANCELLED" : timedOut ? "TIMEOUT" : lockDrift ? "LOCK_DRIFT" : "PREPARATION_FAILED";
      failure.preparation = result;
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }
  // `root` and `boundary` answer different questions: the nearest flake owns
  // the named-shell catalog, while the configured root containing cwd is the
  // only scope in which a discovered `.envrc` may execute.
  async function projectAt(cwd) {
    const directory = await realpath(cwd);
    const allowed = await Promise.all(roots.map((root) => realpath(root)));
    const boundary = allowed.filter((root) => inside(root, directory)).sort((a, b) => b.length - a.length)[0];
    // Coverage is not trust: an uncovered workdir resolves to the configured
    // baseline instead of failing the command or running a foreign `.envrc`.
    if (!boundary) return { root: null, boundary: null, cwd: directory, flake: false, covered: false };
    let current = directory;
    for (;;) {
      try {
        if ((await stat(path.join(current, "flake.nix"))).isFile()) return { root: current, boundary, cwd: directory, flake: true, covered: true };
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (current === boundary) break;
      current = path.dirname(current);
    }
    // Non-flake projects may still use direnv, but have no named-shell menu.
    return { root: boundary, boundary, cwd: directory, flake: false, covered: true };
  }
  async function list(cwd, signal) {
    const project = await projectAt(cwd);
    if (!project.flake) return { ...project, shells: [] };
    const names = JSON.parse(await run(nix, [
      // Nix permits an in-memory relock with --no-write-lock-file, even when
      // --no-update-lock-file is also present. Require the existing lock.
      "eval", "--no-allow-import-from-derivation", "--no-update-lock-file", "--json",
      `${project.root}#devShells.${system}`, "--apply",
      "shells: builtins.filter (name: let shell = shells.${name}; in builtins.isAttrs shell && (shell.type or null) == \"derivation\") (builtins.attrNames shells)",
    ], project.root, base, signal, { readLock: await consistencyLock(project.root) }));
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) throw new Error("Invalid flake shell catalog");
    return { ...project, shells: names };
  }
  // Returns the in-scope `.envrc` to execute, or null when none applies to
  // this launch. Null is a coverage result, never a trust grant: nothing is
  // executed, allowed or exported on that path. Ordinary launches accept an
  // ancestor `.envrc` inside the configured boundary; explicit shell selection
  // (`forSelection`) additionally requires the `.envrc` to live inside the
  // selected flake root, so an ancestor can never acknowledge another flake's
  // shell name on its behalf.
  async function requireApproval(project, env, signal, { forSelection = false } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const status = JSON.parse(await run(direnv, ["status", "--json"], project.cwd, env, signal));
      const rc = status.state?.foundRC;
      if (!rc) return null;
      const file = await realpath(rc.path);
      // direnv searches up to the filesystem root, so an ancestor `.envrc`
      // outside the configured boundary is discovered but never run here.
      if (!inside(project.boundary, file)) return null;
      if (forSelection && !inside(project.root, file)) {
        throw new Error(`${SELECTION_NEEDS_LOCAL_ENVRC}: ${file} is outside ${project.root}`);
      }
      if (rc.allowed === 0) return file;
      if (![1, 2].includes(rc.allowed)) throw new Error("Unknown direnv approval state");
      const approval = new EnvironmentApprovalRequired(project.root, file, await revision(file));
      // direnv 2.37: Allowed=0, NotAllowed=1, explicitly Denied=2.
      if (direnvApproval === "manual" || rc.allowed === 2) throw approval;
      if (!await approval.isCurrent()) continue;
      signal?.throwIfAborted();
      await run(direnv, ["allow", file], project.cwd, env, signal, { envrc: file, approval: "unapproved" });
      // Re-read native trust after allow; never export based on an old status.
    }
    throw new Error("Project .envrc approval did not stabilize; retry preparation");
  }
  // Uncovered launches keep the configured baseline; each caller gets its own
  // frozen copy so no launch can mutate the shared configuration.
  const fallback = () => Object.freeze({ ...base });
  async function preparationLock(envrc) {
    const directory = preparationLockDirectory ?? path.join(base.XDG_RUNTIME_DIR ?? path.join(base.HOME, ".cache"), "harbor-llm");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await stat(directory);
    if (await realpath(directory) !== directory || metadata.uid !== process.getuid() || (metadata.mode & 0o077)) {
      throw new Error("Environment preparation lock directory is not private and operator-owned");
    }
    // Serialize all shells sharing nix-direnv's layout across processes. Never
    // unlink the anchor: flock state belongs to its inode, not its pathname.
    const file = path.join(directory, `${createHash("sha256").update(path.dirname(envrc)).digest("hex")}.lock`);
    const anchor = await open(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      const info = await anchor.stat();
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error("Invalid preparation lock anchor");
    } finally { await anchor.close(); }
    return file;
  }
  // Returns the launch environment plus the fallback reason, if any. Ordinary
  // launches never fail for coverage — only approval, evaluation, cancellation
  // and explicit selection errors still reject.
  async function capture(project, shell, signal, context = {}, retry = false) {
    if (shell !== undefined && !project.covered) throw new Error(OUTSIDE_ROOTS);
    if (!project.covered) return { env: fallback(), reason: "outside configured project roots" };
    const env = { ...base, ...(shell === undefined ? {} : { PROJECT_DEV_SHELL: shell }) };
    const envrc = await requireApproval(project, env, signal, { forSelection: shell !== undefined });
    if (envrc === null) {
      if (shell !== undefined) throw new Error(SELECTION_NEEDS_ENVRC);
      return { env: fallback(), reason: "no in-scope project .envrc" };
    }
    let output;
    const readLock = await consistencyLock(path.dirname(envrc));
    const hash = await revision(envrc);
    const definitions = [...new Set([envrc, ...[project.root, path.dirname(envrc)].flatMap(root => [path.join(root, "flake.nix"), path.join(root, "flake.lock")])])];
    const watchFiles = [...new Set([...definitions, ...(knownWatches.get(envrc) ?? [])])].sort();
    // Hash the declaration/lock pair as well as native watches: same-size edits
    // within one timestamp tick must release a blocked generation.
    const definitionGeneration = async () => {
      const contents = await Promise.all(definitions.map(async file => {
        try { return await revision(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
      }));
      return createHash("sha256").update(JSON.stringify([contents, await watchGeneration(watchFiles)])).digest("hex");
    };
    const generation = await definitionGeneration();
    const identity = createHash("sha256").update(JSON.stringify([
      project.cwd, project.boundary, envrc, hash, generation, shell, system, direnv, nix,
      preparationTimeoutMs, readLock, setsid, flock, Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
    ])).digest("hex");
    if (retry) blocked.delete(identity);
    const previous = blocked.get(identity);
    if (previous) {
      onProgress?.({ ...previous.preparation, ...context, phase: "environment request", status: "blocked", generation });
      const error = new Error(`${previous.message}; repair with an explicit bootstrap invocation or retry after correcting inputs`);
      error.code = "LOCK_DRIFT";
      error.preparation = { ...previous.preparation, ...context, status: "blocked" };
      throw error;
    }
    try {
      output = await sharedPreparation(identity, signal, async (sharedSignal, preparationID) => {
        const lock = await preparationLock(envrc);
        return run(direnv, ["export", "json"], project.cwd, env, sharedSignal, { ...context, preparationID, generation, envrc, approval: "approved", lock, readLock });
      }, receipt => onProgress?.({ ...context, ...receipt, generation, phase: "environment request", status: "preparing", cwd: project.cwd }));
      // Every waiter rechecks native approval and definition freshness. Source
      // watch invalidation is still handled inside each direnv export.
      if (await requireApproval(project, env, signal, { forSelection: shell !== undefined }) !== envrc
        || await revision(envrc) !== hash
        || await definitionGeneration() !== generation) throw new Error("Project environment changed during preparation; retry");
    }
    catch (error) {
      // A definition can change between status and export. Turn a revoked
      // approval into the same barrier; preserve unrelated evaluation errors.
      // Recovery keeps the selection restriction so a vanishing local .envrc
      // can never prompt for or auto-allow an ancestor on selection's behalf.
      if (error.code === "CANCELLED" || error.code === "TIMEOUT") throw error;
      if (error.code === "LOCK_DRIFT" && await definitionGeneration() === generation) {
        if (blocked.size >= 128) blocked.delete(blocked.keys().next().value);
        blocked.set(identity, { message: error.message, preparation: error.preparation });
      }
      await requireApproval(project, env, signal, { forSelection: shell !== undefined });
      throw error;
    }
    const patch = JSON.parse(output);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Invalid direnv environment patch");
    const watches = decodeWatches(patch.DIRENV_WATCHES);
    await validateWatches(watches);
    knownWatches.set(envrc, [...new Set(watches.map(w => w.path))].sort());
    for (const [name, value] of Object.entries(patch)) {
      if (value === null) delete env[name];
      else if (typeof value === "string") env[name] = value;
      else throw new Error("Invalid direnv environment value");
    }
    if (env.NIX_DIRENV_DID_FALLBACK) throw new Error("nix-direnv used a stale fallback; repair the project environment");
    if (shell !== undefined && env.PROJECT_DEV_SHELL_ACTIVE !== shell) {
      throw new Error("Project .envrc did not acknowledge the selected flake shell");
    }
    return { env: Object.freeze(env), reason: null };
  }
  return {
    list,
    async resolve({ sessionID, cwd, signal, environment = "project", invocationID, toolCallID, retry = false }) {
      signal?.throwIfAborted();
      if (!["project", "bootstrap"].includes(environment)) throw new Error("Unknown environment mode");
      const project = await projectAt(cwd);
      const context = { sessionID, invocationID, toolCallID, environment };
      if (environment === "bootstrap") {
        if (!bootstrap) throw new Error("Explicit repair execution requires bootstrapEnvironment configuration");
        signal?.throwIfAborted();
        onProgress?.({ ...context, phase: "environment request", status: "bootstrap", cwd: project.cwd });
        return { ...project, shell: null, env: Object.freeze({ ...bootstrap }), fallback: "explicit bootstrap environment" };
      }
      const shell = project.covered ? selections.get(key(sessionID, project.root)) : undefined;
      if (shell !== undefined && !(await list(cwd, signal)).shells.includes(shell)) throw new Error("Selected shell is no longer in the flake");
      const captured = await capture(project, shell, signal, context, retry);
      return { ...project, shell: shell ?? null, env: captured.env, fallback: captured.reason };
    },
    async select({ sessionID, cwd, shell, signal }) {
      const project = await list(cwd, signal);
      if (!project.covered) throw new Error(OUTSIDE_ROOTS);
      if (!project.shells.includes(shell)) throw new Error("Shell is not declared by the project flake");
      const id = key(sessionID, project.root);
      await capture(project, shell, signal);
      signal?.throwIfAborted();
      selections.set(id, shell);
      return { root: project.root, shell };
    },
    async clear({ sessionID, cwd, signal }) {
      const project = await projectAt(cwd);
      // Clearing an uncovered workdir is an explicit no-op: no selection can
      // exist there (resolve never reads one, select never writes one), and
      // there is no `.envrc` whose approval flow a clear should trigger.
      if (!project.covered) return { root: null, shell: null };
      const id = key(sessionID, project.root);
      await capture(project, undefined, signal);
      signal?.throwIfAborted();
      selections.delete(id);
      return { root: project.root, shell: null };
    },
    release(sessionID) {
      for (const id of selections.keys()) if (JSON.parse(id)[0] === sessionID) selections.delete(id);
    },
  };
}

// Reusable preparation barrier; native hooks consume its immutable snapshot.
export function createEnvironmentBarrier({ environments, requestApproval }) {
  const sessions = new Map();
  const released = new Set();
  let disposed = false;

  async function prepare(operation, input) {
    const { sessionID } = input;
    if (!sessionID || disposed || released.has(sessionID)) throw new Error("Project environment session is unavailable");
    let state = sessions.get(sessionID);
    if (!state) {
      state = { controller: new AbortController(), denied: new Set(), tail: Promise.resolve() };
      sessions.set(sessionID, state);
    }
    const signal = AbortSignal.any([state.controller.signal, ...(input.signal ? [input.signal] : [])]);
    signal.throwIfAborted();
    // Repair must remain available while a project preparation is waiting.
    if (operation === "resolve" && input.environment === "bootstrap") return environments.resolve({ ...input, signal });
    const work = state.tail.catch(() => {}).then(async () => {
      for (;;) {
        signal.throwIfAborted();
        try {
          const result = await environments[operation]({ ...input, signal });
          signal.throwIfAborted();
          return result;
        } catch (error) {
          if (!(error instanceof EnvironmentApprovalRequired) || !requestApproval) throw error;
          const id = JSON.stringify([error.envrc, error.revision]);
          if (state.denied.has(id)) throw new Error(`Project environment approval was declined: ${error.envrc}`);
          if (!await error.isCurrent()) continue;
          const answer = await requestApproval({ sessionID, approval: error, signal });
          signal.throwIfAborted();
          if (answer === "deny") {
            state.denied.add(id);
            throw new Error(`Project environment approval was declined: ${error.envrc}`);
          }
          if (answer !== "retry") throw new Error("Invalid project environment approval response");
        }
      }
    });
    state.tail = work;
    // Keep queue ownership until work finishes, while a cancelled queued
    // caller settles promptly and never starts after its predecessor finishes.
    let abort;
    try {
      return await Promise.race([work, new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      })]);
    } finally { signal.removeEventListener("abort", abort); }
  }

  const reset = (sessionID) => {
    const state = sessions.get(sessionID);
    state?.controller.abort();
    sessions.delete(sessionID);
    environments.release(sessionID);
    return state?.tail.catch(() => {});
  };
  return {
    resolve: (input) => prepare("resolve", input),
    select: (input) => prepare("select", input),
    clear: (input) => prepare("clear", input),
    reset,
    release: (sessionID) => { released.add(sessionID); return reset(sessionID); },
    async dispose() {
      disposed = true;
      await Promise.all([...sessions.keys()].map(reset));
      released.clear();
    },
  };
}
