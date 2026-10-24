import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createProjectEnvironments, createEnvironmentBarrier } from "../src/project-environment.mjs";

const exec = promisify(execFile);
const direnv = process.env.DIRENV_BIN;
const nix = process.env.NIX_BIN;
const integration = { skip: !direnv || !nix, timeout: 30_000 };

async function writableDirectories(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await writableDirectories(path.join(directory, entry.name));
  }
}

async function fixture(t, options = { direnvApproval: "manual" }, approved = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-environment-"));
  t.after(async () => { await writableDirectories(root); await rm(root, { recursive: true, force: true }); });
  const baseline = { ...process.env, HOME: `${root}/home`, XDG_CONFIG_HOME: `${root}/config`, XDG_DATA_HOME: `${root}/data`, XDG_RUNTIME_DIR: `${root}/runtime`, PROJECT_TEST_BASE: "baseline" };
  // Pure fixture flakes need no downloads/builds. A private local store lets
  // the real Nix catalog query run inside the Nix check without its daemon.
  baseline.NIX_CONFIG = `experimental-features = nix-command flakes\nstore = local?root=${root}/nix\nmin-free = 0\nmax-free = 0\nsubstituters =\n`;
  delete baseline.DIRENV_CONFIG;
  for (const name of Object.keys(baseline)) if (name.startsWith("DIRENV_")) delete baseline[name];
  const system = process.arch === "arm64" ? "aarch64-linux" : "x86_64-linux";
  const projects = ["a", "b"].map((name) => path.join(root, name));
  for (const directory of [...projects, baseline.HOME, baseline.XDG_CONFIG_HOME, baseline.XDG_DATA_HOME, baseline.XDG_RUNTIME_DIR]) await mkdir(directory, { mode: 0o700 });
  const envrc = (name) => `
export PROJECT_TEST="${name}:\${PROJECT_DEV_SHELL:-default}"
export PROJECT_DEV_SHELL_ACTIVE="\${PROJECT_DEV_SHELL:-default}"
unset PROJECT_TEST_BASE
`;
  for (const project of projects) {
    await writeFile(path.join(project, "flake.nix"), `{ outputs = {self}: { devShells.${system} = let shell = builtins.derivation { name = "fixture-shell"; system = "${system}"; builder = "/bin/sh"; }; in { default = shell; docs = shell; notAShell = null; }; }; }`);
    await writeFile(path.join(project, ".envrc"), envrc(path.basename(project)));
    if (approved) await exec(direnv, ["allow", project], { env: baseline });
  }
  const environments = createProjectEnvironments({ roots: projects, direnv, nix, system, baseline, ...options });
  return { projects, baseline, environments };
}

test("invalid approval mode fails configuration validation", () => {
  assert.throws(() => createProjectEnvironments({ direnvApproval: "always" }), /auto or manual/);
});

test("relative preparation lock directories are rejected", () => {
  assert.throws(() => createProjectEnvironments({
    roots: ["/workspace"], direnv: "/bin/direnv", nix: "/bin/nix",
    baseline: {}, preparationLockDirectory: "relative",
  }), /preparationLockDirectory must be an absolute path/);
});

test("bootstrap is explicitly configured and never invokes project executables", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bootstrap-environment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".envrc"), "exit 19\n");
  const options = { roots: [root], direnv: "/missing/direnv", nix: "/missing/nix", system: "x86_64-linux", baseline: { PATH: "/tainted", PROJECT_SECRET: "tainted" } };
  const unconfigured = createProjectEnvironments(options);
  await assert.rejects(unconfigured.resolve({ sessionID: "a", cwd: root, environment: "bootstrap" }), /bootstrapEnvironment/);
  const environments = createProjectEnvironments({ ...options, bootstrapEnvironment: { PATH: "/host/bin", HOME: root } });
  const result = await environments.resolve({ sessionID: "a", cwd: root, environment: "bootstrap" });
  assert.deepEqual(result.env, { PATH: "/host/bin", HOME: root });
  assert.equal(result.env.PROJECT_SECRET, undefined);
  assert.equal(result.fallback, "explicit bootstrap environment");
  await assert.rejects(environments.resolve({ sessionID: "a", cwd: root }), /preparation failed/);
});

test("unchanged lock drift blocks repeated exports and input edits permit recovery", integration, async (t) => {
  const events = [];
  const { projects: [cwd], environments } = await fixture(t, { direnvApproval: "auto", onProgress: event => events.push(event) });
  const counter = path.join(cwd, "exports");
  await writeFile(path.join(cwd, "flake.lock"), "broken");
  await writeFile(path.join(cwd, ".envrc"), `echo export >> ${JSON.stringify(counter)}\nif grep -q broken flake.lock; then\n echo "requires lock file changes but they're not allowed due to '--no-update-lock-file'" >&2\n exit 1\nfi\nexport PROJECT_TEST="repaired"\n`);
  await assert.rejects(environments.resolve({ sessionID: "a", cwd }), { code: "LOCK_DRIFT" });
  await assert.rejects(environments.resolve({ sessionID: "b", cwd }), { code: "LOCK_DRIFT" });
  assert.equal((await readFile(counter, "utf8")).trim(), "export");
  await assert.rejects(environments.resolve({ sessionID: "a", cwd, retry: true }), { code: "LOCK_DRIFT" });
  assert.equal((await readFile(counter, "utf8")).trim().split("\n").length, 2);
  await writeFile(path.join(cwd, "flake.lock"), "repaired");
  assert.equal((await environments.resolve({ sessionID: "a", cwd })).env.PROJECT_TEST, "repaired");
  assert.equal((await readFile(counter, "utf8")).trim().split("\n").length, 3);
  assert.ok(events.some(event => event.status === "blocked"));
});

test("an inherited envrc's lock edit releases a nested flake's blocked generation", integration, async (t) => {
  const { projects: [cwd], environments } = await fixture(t, { direnvApproval: "auto" });
  const nested = path.join(cwd, "nested");
  await mkdir(nested);
  await writeFile(path.join(nested, "flake.nix"), "{ outputs = _: {}; }");
  await writeFile(path.join(cwd, "flake.lock"), "broken");
  await writeFile(path.join(cwd, ".envrc"), `if grep -q broken flake.lock; then\n echo "requires lock file changes but they're not allowed due to '--no-update-lock-file'" >&2\n exit 1\nfi\nexport PROJECT_TEST="parent-repaired"\n`);
  await assert.rejects(environments.resolve({ sessionID: "a", cwd: nested }), { code: "LOCK_DRIFT" });
  await writeFile(path.join(cwd, "flake.lock"), "repaired");
  assert.equal((await environments.resolve({ sessionID: "a", cwd: nested })).env.PROJECT_TEST, "parent-repaired");
});

test("bootstrap repair bypasses a held project preparation queue", { timeout: 1000 }, async (t) => {
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const barrier = createEnvironmentBarrier({ environments: {
    async resolve(input) {
      if (input.environment === "bootstrap") return "repair-ready";
      entered.resolve();
      return finish.promise;
    },
    release() {},
  } });
  t.after(async () => { finish.resolve(); await barrier.dispose(); });
  const pending = barrier.resolve({ sessionID: "a", cwd: "/fixture" });
  await entered.promise;
  assert.equal(await barrier.resolve({ sessionID: "a", cwd: "/fixture", environment: "bootstrap" }), "repair-ready");
  finish.resolve("project-ready");
  assert.equal(await pending, "project-ready");
});

test("native Nix lock drift can be repaired through bootstrap before project execution resumes", integration, async (t) => {
  const { projects: [cwd], baseline } = await fixture(t);
  const native = async (args, env = baseline) => {
    t.diagnostic(`native lock fixture: ${args.join(" ")}`);
    return exec(nix, ["--debug", ...args], { cwd, env, timeout: 8_000 });
  };
  // Change an already-locked absolute path input. This exercises real lock
  // drift without invoking a network fetcher inside the Nix sandbox.
  const beforeInput = path.join(cwd, "input-before");
  const afterInput = path.join(cwd, "input-after");
  await mkdir(beforeInput);
  await mkdir(afterInput);
  await writeFile(path.join(beforeInput, "value"), "before\n");
  await writeFile(path.join(afterInput, "value"), "after\n");
  const definition = input => `{ inputs.fixture = { type = "path"; path = ${JSON.stringify(input)}; flake = false; }; outputs = _: {}; }`;
  await writeFile(path.join(cwd, "flake.nix"), definition(beforeInput));
  await native(["flake", "lock"]);
  await writeFile(path.join(cwd, "flake.nix"), definition(afterInput));
  await assert.rejects(native(["flake", "metadata", "--no-update-lock-file"]), error => {
    assert.match(error.stderr, /requires lock file changes but they're not allowed/);
    return true;
  });
  const counter = path.join(cwd, "exports");
  await writeFile(path.join(cwd, ".envrc"), `strict_env\nwatch_file flake.nix flake.lock\necho export >> ${JSON.stringify(counter)}\n${JSON.stringify(nix)} flake metadata --no-update-lock-file >/dev/null || exit 1\nexport PROJECT_TEST="repaired"\n`);
  const environments = createProjectEnvironments({ roots: [cwd], direnv, nix, system: "x86_64-linux", baseline, direnvApproval: "auto", preparationTimeoutMs: 8_000,
    onProgress: event => t.diagnostic(`native lock fixture: ${event.phase} ${event.status}`),
    bootstrapEnvironment: { PATH: baseline.PATH, HOME: baseline.HOME, NIX_CONFIG: baseline.NIX_CONFIG } });
  await assert.rejects(environments.list(cwd), { code: "LOCK_DRIFT" });
  await assert.rejects(environments.resolve({ sessionID: "a", cwd }), { code: "LOCK_DRIFT" });
  await assert.rejects(environments.resolve({ sessionID: "b", cwd }), { code: "LOCK_DRIFT" });
  assert.equal((await readFile(counter, "utf8")).trim(), "export");
  const repair = await environments.resolve({ sessionID: "a", cwd, environment: "bootstrap" });
  await native(["flake", "lock"], repair.env);
  assert.equal((await environments.resolve({ sessionID: "a", cwd })).env.PROJECT_TEST, "repaired");
  assert.equal((await readFile(counter, "utf8")).trim().split("\n").length, 2);
});

test("environment readers exclude promotion writers until export finishes", integration, async (t) => {
  const { projects: [cwd], baseline } = await fixture(t);
  const anchor = path.join(cwd, "definition.lock");
  const started = path.join(cwd, "started");
  await writeFile(path.join(cwd, ".envrc"), `echo started > ${JSON.stringify(started)}\nsleep 0.3\nexport PROJECT_TEST="read-consistent"\n`);
  const environments = createProjectEnvironments({ roots: [cwd], direnv, nix, system: "x86_64-linux", baseline, direnvApproval: "auto", consistencyLocks: { [cwd]: anchor } });
  const pending = environments.resolve({ sessionID: "a", cwd });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await readFile(started); break; } catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await assert.rejects(exec("flock", ["--nonblock", "--exclusive", anchor, "true"]), { code: 1 });
  assert.equal((await pending).env.PROJECT_TEST, "read-consistent");
  const inode = (await stat(anchor)).ino;
  await exec("flock", ["--nonblock", "--exclusive", anchor, "true"]);
  assert.equal((await stat(anchor)).ino, inode);
});

test("preparation deadline configuration rejects invalid values", () => {
  for (const preparationTimeoutMs of [0, -1, 1.5, Infinity, "600000", 3_600_001]) {
    assert.throws(() => createProjectEnvironments({ preparationTimeoutMs }), /preparationTimeoutMs/);
  }
});

test("approved export failure reports its phase without exposing hook output", integration, async (t) => {
  const events = [];
  const { projects: [cwd], environments } = await fixture(t, { direnvApproval: "auto", onProgress: (event) => events.push(event) });
  await writeFile(path.join(cwd, ".envrc"), 'echo SECRET_SENTINEL_DO_NOT_LOG >&2\nexit 19\n');
  await assert.rejects(environments.resolve({ sessionID: "a", cwd }), (error) => {
    assert.equal(error.code, "PREPARATION_FAILED");
    assert.equal(error.preparation.phase, "direnv export");
    assert.equal(error.preparation.approval, "approved");
    assert.equal(error.preparation.envrc, path.join(cwd, ".envrc"));
    // direnv normalizes the .envrc failure to its own exit code 1.
    assert.match(error.message, /exit 1/);
    assert.doesNotMatch(error.message, /SECRET_SENTINEL/);
    return true;
  });
  assert.ok(events.some(event => event.phase === "direnv allow" && event.status === "ready"));
  assert.doesNotMatch(JSON.stringify(events), /SECRET_SENTINEL/);
});

test("preparation timeout is distinct from approval and reaps helper processes", integration, async (t) => {
  const { projects: [cwd], environments } = await fixture(t, { direnvApproval: "auto", preparationTimeoutMs: 500 });
  await writeFile(path.join(cwd, ".envrc"), `sleep 30 &\necho $! > ${JSON.stringify(path.join(cwd, "helper.pid"))}\nwait\n`);
  await assert.rejects(environments.resolve({ sessionID: "a", cwd }), (error) => {
    assert.equal(error.code, "TIMEOUT");
    assert.equal(error.preparation.phase, "direnv export");
    assert.equal(error.preparation.approval, "approved");
    assert.equal(error.preparation.timeoutMs, 500);
    assert.ok(error.preparation.elapsedMs >= 490);
    return true;
  });
  const pid = Number(await readFile(path.join(cwd, "helper.pid"), "utf8"));
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const state = await readFile(`/proc/${pid}/stat`, "utf8");
  assert.fail(`timed-out preparation left helper ${pid}: ${state.slice(state.lastIndexOf(")") + 2).split(" ").slice(0,3).join(" ")}`);
});

test("slow successful export emits safe progress and respects the configured deadline", integration, async (t) => {
  const events = [];
  const { projects: [cwd], environments } = await fixture(t, { direnvApproval: "auto", preparationTimeoutMs: 3000, onProgress: event => events.push(event) });
  await writeFile(path.join(cwd, ".envrc"), 'sleep 0.2\nexport PROJECT_TEST="prepared"\n');
  assert.equal((await environments.resolve({ sessionID: "a", cwd })).env.PROJECT_TEST, "prepared");
  const exportEvents = events.filter(event => event.phase === "direnv export");
  assert.deepEqual(exportEvents.map(event => event.status), ["preparing", "ready"]);
  assert.equal(exportEvents[0].preparationID, exportEvents[1].preparationID);
  assert.equal(exportEvents[1].cwd, cwd);
});

test("concurrent sessions share one export and cancellation leaves other waiters alive", integration, async (t) => {
  const events = [];
  const { projects: [cwd], environments } = await fixture(t, { direnvApproval: "auto", onProgress: event => events.push(event) });
  const counter = path.join(cwd, "exports");
  await writeFile(path.join(cwd, ".envrc"), `echo export >> ${JSON.stringify(counter)}\nsleep 0.4\nexport PROJECT_TEST="shared"\n`);
  const controller = new AbortController();
  const cancelled = assert.rejects(environments.resolve({ sessionID: "a", invocationID: "sh_a", toolCallID: "call_a", cwd, signal: controller.signal }), { code: "CANCELLED" });
  const surviving = environments.resolve({ sessionID: "b", invocationID: "sh_b", toolCallID: "call_b", cwd });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await readFile(counter); break; } catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  controller.abort();
  await cancelled;
  assert.equal((await surviving).env.PROJECT_TEST, "shared");
  assert.equal((await readFile(counter, "utf8")).trim(), "export");
  const requests = events.filter(event => event.phase === "environment request");
  assert.equal(requests.length, 2);
  assert.equal(new Set(requests.map(event => event.preparationID)).size, 1);
  assert.deepEqual(requests.map(event => event.invocationID).sort(), ["sh_a", "sh_b"]);
  assert.equal(requests.filter(event => event.shared).length, 1);
  await environments.resolve({ sessionID: "c", cwd });
  assert.equal((await readFile(counter, "utf8")).trim().split("\n").length, 2, "completed snapshots are not cached");
});

test("cancelling an active export is reported as cancellation, not timeout", integration, async (t) => {
  const { projects: [cwd], environments } = await fixture(t, { direnvApproval: "auto", preparationTimeoutMs: 5000 });
  await writeFile(path.join(cwd, ".envrc"), `echo started > ${JSON.stringify(path.join(cwd, "started"))}\nsleep 30\n`);
  const controller = new AbortController();
  const rejected = assert.rejects(environments.resolve({ sessionID: "a", cwd, signal: controller.signal }), (error) => {
    assert.equal(error.code, "CANCELLED");
    assert.equal(error.preparation.reason, "cancelled");
    assert.equal(error.preparation.phase, "direnv export");
    return true;
  });
  let started = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { await readFile(path.join(cwd, "started")); started = true; break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  controller.abort();
  await rejected;
  assert.equal(started, true);
});

test("watched symlinks use direnv's target timestamp", integration, async (t) => {
  const { projects: [cwd], environments } = await fixture(t, { direnvApproval: "auto" });
  const target = path.join(cwd, "input");
  await writeFile(target, "linked");
  const old = new Date(Date.now() - 20_000);
  await utimes(target, old, old);
  await symlink(target, path.join(cwd, "watched"));
  await writeFile(path.join(cwd, ".envrc"), 'watch_file watched\nexport PROJECT_TEST="$(cat watched)"\n');
  assert.equal((await environments.resolve({ sessionID: "a", cwd })).env.PROJECT_TEST, "linked");
});

test("a watched input edit rejects the stale waiter and starts a fresh export", integration, async (t) => {
  const { projects: [cwd], environments } = await fixture(t, { direnvApproval: "auto" });
  const input = path.join(cwd, "input");
  const started = path.join(cwd, "started");
  await writeFile(input, "old");
  await writeFile(path.join(cwd, ".envrc"), `watch_file input\nexport PROJECT_TEST="$(cat input)"\necho started > ${JSON.stringify(started)}\nsleep 0.3\n`);
  await environments.resolve({ sessionID: "prime", cwd });
  await rm(started);
  const stale = assert.rejects(environments.resolve({ sessionID: "stale", cwd }), /changed during preparation/);
  let running = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await readFile(started); running = true; break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(running, "the old export must have read its input before the edit");
  await writeFile(input, "new");
  const fresh = environments.resolve({ sessionID: "fresh", cwd });
  await stale;
  assert.equal((await fresh).env.PROJECT_TEST, "new");
});

test("nix-direnv retention touches preserve an unchanged cached environment", integration, async (t) => {
  const { projects: [cwd], environments } = await fixture(t, { direnvApproval: "auto" });
  const layout = path.join(cwd, ".direnv");
  const profile = path.join(layout, "flake-profile-fixture");
  const cache = `${profile}.rc`;
  await mkdir(layout);
  await symlink(cwd, profile);
  await writeFile(cache, "cached");
  await writeFile(path.join(cwd, ".envrc"), 'touch .direnv/flake-profile-fixture.rc\nwatch_file .direnv/flake-profile-fixture.rc\nexport PROJECT_TEST="$(cat .direnv/flake-profile-fixture.rc)"\n');
  assert.equal((await environments.resolve({ sessionID: "prime", cwd })).env.PROJECT_TEST, "cached");
  const before = (await stat(cache)).mtimeMs;
  const results = await Promise.all(["one", "two", "three"].map(sessionID => environments.resolve({ sessionID, cwd })));
  assert.deepEqual(results.map(result => result.env.PROJECT_TEST), ["cached", "cached", "cached"]);
  assert.ok((await stat(cache)).mtimeMs > before, "native retention refreshed the profile timestamp");
});

test("a cached profile body edit rejects stale waiters even with preserved metadata", integration, async (t) => {
  const { projects: [cwd], environments } = await fixture(t, { direnvApproval: "auto" });
  const layout = path.join(cwd, ".direnv");
  const profile = path.join(layout, "flake-profile-fixture");
  const cache = `${profile}.rc`;
  const started = path.join(cwd, "started");
  await mkdir(layout);
  await symlink(cwd, profile);
  await writeFile(cache, "first");
  const timestamp = Math.floor(Date.now() / 1000) - 20;
  await utimes(cache, timestamp, timestamp);
  await writeFile(path.join(cwd, ".envrc"), 'watch_file .direnv/flake-profile-fixture.rc\nexport PROJECT_TEST="$(cat .direnv/flake-profile-fixture.rc)"\necho started > started\nsleep 0.3\n');
  await environments.resolve({ sessionID: "prime", cwd });
  await rm(started);
  const metadata = await stat(cache);
  const stale = assert.rejects(environments.resolve({ sessionID: "stale", cwd }), /changed during preparation/);
  let running = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await readFile(started); running = true; break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(running, "the old environment was read before the cache edit");
  await writeFile(cache, "other");
  await utimes(cache, metadata.atime, metadata.mtime);
  await stale;
  assert.equal((await environments.resolve({ sessionID: "fresh", cwd })).env.PROJECT_TEST, "other");
});

test("separate processes serialize exports through the same persistent anchor", integration, async (t) => {
  const { projects: [cwd], baseline, environments } = await fixture(t, { direnvApproval: "auto" });
  const events = path.join(cwd, "events");
  await writeFile(path.join(cwd, ".envrc"), `mkdir busy || exit 19\necho start >> ${JSON.stringify(events)}\nsleep 0.2\necho end >> ${JSON.stringify(events)}\nrmdir busy\nexport PROJECT_TEST="serialized"\n`);
  const script = `
    import { createProjectEnvironments } from ${JSON.stringify(new URL("../src/project-environment.mjs", import.meta.url).href)};
    const environments = createProjectEnvironments(${JSON.stringify({ roots: [cwd], baseline, direnv, nix, system: process.arch === "arm64" ? "aarch64-linux" : "x86_64-linux", direnvApproval: "auto" })});
    const result = await environments.resolve({ sessionID: "child", cwd: ${JSON.stringify(cwd)} });
    if (result.env.PROJECT_TEST !== "serialized") throw new Error("wrong environment");
  `;
  const [parent] = await Promise.all([
    environments.resolve({ sessionID: "parent", cwd }),
    exec(process.execPath, ["--input-type=module", "-e", script], { env: baseline }),
  ]);
  assert.equal(parent.env.PROJECT_TEST, "serialized");
  assert.deepEqual((await readFile(events, "utf8")).trim().split("\n"), ["start", "end", "start", "end"]);
  const anchors = await readdir(path.join(baseline.XDG_RUNTIME_DIR, "harbor-llm"));
  assert.equal(anchors.length, 1, "the released anchor remains present");
});

test("an explicitly configured transition directory coordinates separate processes", integration, async (t) => {
  const { projects: [cwd], baseline } = await fixture(t, { direnvApproval: "auto" });
  const directory = path.join(baseline.XDG_RUNTIME_DIR, "existing-preparation-locks");
  const options = { roots: [cwd], baseline, direnv, nix,
    system: process.arch === "arm64" ? "aarch64-linux" : "x86_64-linux",
    direnvApproval: "auto", preparationLockDirectory: directory };
  const environments = createProjectEnvironments(options);
  await writeFile(path.join(cwd, ".envrc"), 'mkdir busy || exit 19\necho start >> events\nsleep 0.2\necho end >> events\nrmdir busy\nexport PROJECT_TEST="transition"\n');
  const script = `
    import { createProjectEnvironments } from ${JSON.stringify(new URL("../src/project-environment.mjs", import.meta.url).href)};
    const environments = createProjectEnvironments(${JSON.stringify(options)});
    await environments.resolve({sessionID: "child", cwd: ${JSON.stringify(cwd)}});
  `;
  await Promise.all([
    environments.resolve({sessionID: "parent", cwd}),
    exec(process.execPath, ["--input-type=module", "-e", script], {env: baseline}),
  ]);
  assert.deepEqual((await readFile(path.join(cwd, "events"), "utf8")).trim().split("\n"), ["start", "end", "start", "end"]);
  assert.equal((await readdir(directory)).length, 1);
  const inode = (await stat(path.join(directory, (await readdir(directory))[0]))).ino;
  await environments.resolve({sessionID: "again", cwd});
  assert.equal((await stat(path.join(directory, (await readdir(directory))[0]))).ino, inode);
});

test("auto is default and approves only when preparation is requested", integration, async (t) => {
  const { projects: [cwd], baseline, environments } = await fixture(t, {}, false);
  const allowed = async () => JSON.parse((await exec(direnv, ["status", "--json"], { cwd, env: baseline })).stdout).state.foundRC.allowed;
  assert.equal(await allowed(), 1);
  await environments.list(cwd);
  assert.equal(await allowed(), 1);
  assert.equal((await environments.resolve({ sessionID: "a", cwd })).env.PROJECT_TEST, "a:default");
  assert.equal(await allowed(), 0);
  await writeFile(path.join(cwd, ".envrc"), 'export PROJECT_TEST="edited"\n');
  assert.equal(await allowed(), 1);
  assert.equal((await environments.resolve({ sessionID: "a", cwd })).env.PROJECT_TEST, "edited");
  assert.equal(await allowed(), 0);
});

test("auto respects explicit direnv deny", integration, async (t) => {
  const { projects: [cwd], baseline, environments } = await fixture(t, { direnvApproval: "auto" });
  await exec(direnv, ["deny", cwd], { env: baseline });
  await assert.rejects(environments.resolve({ sessionID: "a", cwd }), /operator approval/);
  const status = JSON.parse((await exec(direnv, ["status", "--json"], { cwd, env: baseline })).stdout);
  assert.equal(status.state.foundRC.allowed, 2);
});

test("auto approval does not permit execution after failed export", integration, async (t) => {
  const { projects: [cwd], environments } = await fixture(t, {});
  await writeFile(path.join(cwd, ".envrc"), "exit 1\n");
  const barrier = createEnvironmentBarrier({
    environments,
    requestApproval: async () => assert.fail("auto must not prompt for new content"),
  });
  await assert.rejects(barrier.resolve({ cwd, sessionID: "a" }), /failed/);
});

test("approved direnv default, flake selection, clear and tombstones", integration, async (t) => {
  const { projects: [cwd], environments } = await fixture(t);
  assert.deepEqual((await environments.list(cwd)).shells, ["default", "docs"]);
  assert.equal((await environments.resolve({ sessionID: "a", cwd })).env.PROJECT_TEST, "a:default");
  await environments.select({ sessionID: "a", cwd, shell: "docs" });
  const selected = await environments.resolve({ sessionID: "a", cwd });
  assert.equal(selected.env.PROJECT_TEST, "a:docs");
  assert.equal(selected.env.PROJECT_TEST_BASE, undefined);
  assert.equal((await environments.resolve({ sessionID: "b", cwd })).env.PROJECT_TEST, "a:default");
  await assert.rejects(environments.select({ sessionID: "a", cwd, shell: "missing" }), /not declared/);
  assert.equal((await environments.resolve({ sessionID: "a", cwd })).env.PROJECT_TEST, "a:docs");
  await environments.clear({ sessionID: "a", cwd });
  assert.equal((await environments.resolve({ sessionID: "a", cwd })).env.PROJECT_TEST, "a:default");
});

test("changed .envrc fails closed and is never auto-approved", integration, async (t) => {
  const { projects: [cwd], environments } = await fixture(t);
  await writeFile(path.join(cwd, ".envrc"), 'export PROJECT_TEST="changed"\n');
  await assert.rejects(environments.resolve({ sessionID: "a", cwd }), /operator approval/);
});

test("non-flake projects retain direnv without invented shell choices", integration, async (t) => {
  const { projects: [cwd], environments } = await fixture(t);
  await rm(path.join(cwd, "flake.nix"));
  assert.deepEqual((await environments.list(cwd)).shells, []);
  assert.equal((await environments.resolve({ sessionID: "a", cwd })).env.PROJECT_TEST, "a:default");
});

test("nested flake keeps its own shell catalog while the ancestor .envrc supplies the environment", integration, async (t) => {
  const { projects: [cwd], environments } = await fixture(t);
  const system = process.arch === "arm64" ? "aarch64-linux" : "x86_64-linux";
  const nested = path.join(cwd, "nested");
  await mkdir(nested);
  // A nested flake without its own .envrc used to fail every launch because
  // the flake boundary and the discovered .envrc boundary disagreed.
  await writeFile(path.join(nested, "flake.nix"), `{ outputs = {self}: { devShells.${system} = let shell = builtins.derivation { name = "nested-shell"; system = "${system}"; builder = "/bin/sh"; }; in { default = shell; }; }; }`);
  const resolved = await environments.resolve({ sessionID: "a", cwd: nested });
  assert.equal(resolved.env.PROJECT_TEST, "a:default");
  assert.equal(resolved.env.PROJECT_TEST_BASE, undefined);
  assert.equal(resolved.fallback, null);
  assert.equal(resolved.covered, true);
  assert.equal(resolved.root, nested, "the catalog stays with the nearest flake");
  assert.equal(resolved.boundary, await realpath(cwd), "the environment scope is the configured root");
  assert.deepEqual((await environments.list(nested)).shells, ["default"]);
  assert.deepEqual((await environments.list(cwd)).shells, ["default", "docs"]);
});

test("workdirs outside the configured roots keep the baseline and never run a foreign .envrc", integration, async (t) => {
  const { projects: [cwd], baseline, environments } = await fixture(t);
  const outside = path.join(path.dirname(cwd), "outside");
  await mkdir(outside);
  // Allowed on purpose: a wrong implementation would execute it and show up
  // both as this marker and as PROJECT_TEST leaking into the launch.
  await writeFile(path.join(outside, ".envrc"), `echo executed > ${JSON.stringify(path.join(outside, "executed"))}\nexport PROJECT_TEST="outside"\nexport PROJECT_TEST_BASE="outside"\n`);
  await exec(direnv, ["allow", outside], { env: baseline });
  assert.equal((await environments.resolve({ sessionID: "a", cwd })).env.PROJECT_TEST, "a:default");
  const resolved = await environments.resolve({ sessionID: "a", cwd: outside });
  assert.equal(resolved.covered, false);
  assert.equal(resolved.fallback, "outside configured project roots");
  assert.equal(resolved.env.PROJECT_TEST, undefined);
  assert.equal(resolved.env.PROJECT_TEST_BASE, "baseline");
  assert.ok(Object.isFrozen(resolved.env));
  await assert.rejects(readFile(path.join(outside, "executed")), { code: "ENOENT" }, "an uncovered .envrc never executes");
  assert.equal((await environments.resolve({ sessionID: "a", cwd })).env.PROJECT_TEST, "a:default", "the covered launch is unaffected");
  await environments.clear({ sessionID: "a", cwd: outside });
});

test("an ancestor .envrc outside the configured boundary is discovered but not executed", integration, async (t) => {
  const { projects: [cwd], baseline, environments } = await fixture(t);
  const parent = path.dirname(cwd);
  await writeFile(path.join(parent, ".envrc"), `echo executed > ${JSON.stringify(path.join(parent, "executed"))}\nexport PROJECT_TEST="ancestor"\nexport PROJECT_TEST_BASE="ancestor"\n`);
  await exec(direnv, ["allow", parent], { env: baseline });
  await rm(path.join(cwd, ".envrc"));
  const resolved = await environments.resolve({ sessionID: "a", cwd });
  assert.equal(resolved.covered, true, "the workdir itself is inside a configured root");
  assert.equal(resolved.fallback, "no in-scope project .envrc");
  assert.equal(resolved.env.PROJECT_TEST, undefined);
  assert.equal(resolved.env.PROJECT_TEST_BASE, "baseline");
  await assert.rejects(readFile(path.join(parent, "executed")), { code: "ENOENT" }, "an out-of-scope ancestor never executes");
  const status = JSON.parse((await exec(direnv, ["status", "--json"], { cwd, env: baseline })).stdout);
  assert.equal(status.state.foundRC.path, path.join(parent, ".envrc"));
});

test("explicit shell selection never silently falls back to the baseline", integration, async (t) => {
  const { projects: [cwd], environments } = await fixture(t);
  const outside = path.join(path.dirname(cwd), "outside");
  await mkdir(outside);
  await assert.rejects(environments.select({ sessionID: "a", cwd: outside, shell: "docs" }), /outside configured project roots/);
  await rm(path.join(cwd, ".envrc"));
  await assert.rejects(environments.select({ sessionID: "a", cwd, shell: "docs" }), /project \.envrc inside the configured roots/);
  const resolved = await environments.resolve({ sessionID: "a", cwd });
  assert.equal(resolved.shell, null, "a rejected selection is never recorded");
  assert.equal(resolved.fallback, "no in-scope project .envrc", "ordinary launches still fall back");
});

test("an inherited ancestor .envrc cannot acknowledge a nested flake selection", integration, async (t) => {
  const { projects: [cwd], environments } = await fixture(t);
  const system = process.arch === "arm64" ? "aarch64-linux" : "x86_64-linux";
  const nested = path.join(cwd, "nested");
  await mkdir(nested);
  // Same shell names as the parent on purpose: the ancestor .envrc would
  // acknowledge "default" while loading the parent flake, not the nested one.
  await writeFile(path.join(nested, "flake.nix"), `{ outputs = {self}: { devShells.${system} = let shell = builtins.derivation { name = "nested-shell"; system = "${system}"; builder = "/bin/sh"; }; in { default = shell; docs = shell; }; }; }`);
  await assert.rejects(
    environments.select({ sessionID: "a", cwd: nested, shell: "default" }),
    /selected flake root/,
    "explicit selection must not inherit the ancestor .envrc",
  );
  const resolved = await environments.resolve({ sessionID: "a", cwd: nested });
  assert.equal(resolved.shell, null, "a rejected selection is never recorded");
  assert.equal(resolved.fallback, null, "ordinary nested launches still inherit the ancestor");
  assert.equal(resolved.env.PROJECT_TEST, "a:default");
});

test("removing a selected project's local .envrc rejects instead of inheriting the ancestor", integration, async (t) => {
  const { projects: [cwd], baseline, environments } = await fixture(t);
  const nested = path.join(cwd, "nested");
  await mkdir(nested);
  const system = process.arch === "arm64" ? "aarch64-linux" : "x86_64-linux";
  await writeFile(path.join(nested, "flake.nix"), `{ outputs = {self}: { devShells.${system} = let shell = builtins.derivation { name = "nested-shell"; system = "${system}"; builder = "/bin/sh"; }; in { default = shell; docs = shell; }; }; }`);
  await writeFile(path.join(nested, ".envrc"), 'export PROJECT_TEST="nested:${PROJECT_DEV_SHELL:-default}"\nexport PROJECT_DEV_SHELL_ACTIVE="${PROJECT_DEV_SHELL:-default}"\nunset PROJECT_TEST_BASE\n');
  await exec(direnv, ["allow", nested], { env: baseline });
  await environments.select({ sessionID: "a", cwd: nested, shell: "docs" });
  assert.equal((await environments.resolve({ sessionID: "a", cwd: nested })).env.PROJECT_TEST, "nested:docs");
  await rm(path.join(nested, ".envrc"));
  await assert.rejects(
    environments.resolve({ sessionID: "a", cwd: nested }),
    /selected flake root/,
    "a removed local .envrc must not silently redirect selection to the ancestor",
  );
  await assert.rejects(environments.select({ sessionID: "a", cwd: nested, shell: "docs" }), /selected flake root/);
});

test("export failure never approves an ancestor on selection's behalf", integration, async (t) => {
  const { projects: [cwd], baseline, environments } = await fixture(t, { direnvApproval: "auto" });
  const system = process.arch === "arm64" ? "aarch64-linux" : "x86_64-linux";
  const nested = path.join(cwd, "nested");
  await mkdir(nested);
  await writeFile(path.join(nested, "flake.nix"), `{ outputs = {self}: { devShells.${system} = let shell = builtins.derivation { name = "nested-shell"; system = "${system}"; builder = "/bin/sh"; }; in { default = shell; docs = shell; }; }; }`);
  // The local definition deletes itself during export, so recovery discovers
  // the ancestor. The ancestor is unapproved: recovery without the selection
  // restriction would auto-allow it before rethrowing the export failure.
  await writeFile(path.join(nested, ".envrc"), `rm -f ${JSON.stringify(path.join(nested, ".envrc"))}\nexit 1\n`);
  await exec(direnv, ["allow", nested], { env: baseline });
  await writeFile(path.join(cwd, ".envrc"), 'export PROJECT_TEST="edited-ancestor"\n');
  const ancestorAllowed = async () => JSON.parse((await exec(direnv, ["status", "--json"], { cwd, env: baseline })).stdout).state.foundRC.allowed;
  assert.equal(await ancestorAllowed(), 1);
  await assert.rejects(
    environments.select({ sessionID: "a", cwd: nested, shell: "docs" }),
    /selected flake root/,
    "recovery keeps the selection restriction instead of approving the ancestor",
  );
  assert.equal(await ancestorAllowed(), 1, "the ancestor keeps its original trust state");
});

test("a denied ancestor .envrc still blocks an ordinary nested launch", integration, async (t) => {
  const { projects: [cwd], baseline, environments } = await fixture(t);
  const nested = path.join(cwd, "nested");
  await mkdir(nested);
  const system = process.arch === "arm64" ? "aarch64-linux" : "x86_64-linux";
  await writeFile(path.join(nested, "flake.nix"), `{ outputs = {self}: { devShells.${system} = let shell = builtins.derivation { name = "nested-shell"; system = "${system}"; builder = "/bin/sh"; }; in { default = shell; }; }; }`);
  await exec(direnv, ["deny", cwd], { env: baseline });
  await assert.rejects(environments.resolve({ sessionID: "a", cwd: nested }), /operator approval/);
});

test("project, fallback and project launches stay isolated in sequence", integration, async (t) => {
  const { projects: [a, b], environments } = await fixture(t);
  const outside = path.join(path.dirname(a), "outside");
  await mkdir(outside);
  assert.equal((await environments.resolve({ sessionID: "s", cwd: a })).env.PROJECT_TEST, "a:default");
  const middle = await environments.resolve({ sessionID: "s", cwd: outside });
  assert.equal(middle.fallback, "outside configured project roots");
  assert.equal(middle.env.PROJECT_TEST, undefined);
  assert.equal(middle.env.PROJECT_TEST_BASE, "baseline");
  assert.equal((await environments.resolve({ sessionID: "s", cwd: b })).env.PROJECT_TEST, "b:default");
  assert.equal((await environments.resolve({ sessionID: "s", cwd: a })).env.PROJECT_TEST, "a:default");
});

test("failed selected preparation preserves the previous choice", integration, async (t) => {
  const { projects: [cwd], baseline, environments } = await fixture(t);
  await environments.select({ sessionID: "a", cwd, shell: "docs" });
  await writeFile(path.join(cwd, ".envrc"), `
if [ "$PROJECT_DEV_SHELL" = default ]; then exit 1; fi
export PROJECT_DEV_SHELL_ACTIVE="$PROJECT_DEV_SHELL"
export PROJECT_TEST="$PROJECT_DEV_SHELL"
`);
  await exec(direnv, ["allow", cwd], { env: baseline });
  await assert.rejects(environments.select({ sessionID: "a", cwd, shell: "default" }), /failed/);
  assert.equal((await environments.resolve({ sessionID: "a", cwd })).env.PROJECT_TEST, "docs");
});

test("unacknowledged selection and stale nix-direnv fallback are rejected", integration, async (t) => {
  const { projects: [cwd], baseline, environments } = await fixture(t);
  await writeFile(path.join(cwd, ".envrc"), 'export PROJECT_TEST="ignores-selection"\n');
  await exec(direnv, ["allow", cwd], { env: baseline });
  await assert.rejects(environments.select({ sessionID: "a", cwd, shell: "docs" }), /acknowledge/);
  await writeFile(path.join(cwd, ".envrc"), 'export NIX_DIRENV_DID_FALLBACK=1\n');
  await exec(direnv, ["allow", cwd], { env: baseline });
  await assert.rejects(environments.resolve({ sessionID: "a", cwd }), /stale fallback/);
});

test("two projects in one session get independent immutable snapshots", integration, async (t) => {
  const { projects: [a, b], environments } = await fixture(t);
  const barrier = createEnvironmentBarrier({ environments });
  const context = { sessionID: "one", signal: new AbortController().signal };
  const [first, second] = await Promise.all([
    barrier.resolve({ cwd: a, ...context }),
    barrier.resolve({ cwd: b, ...context }),
  ]);
  assert.equal(first.env.PROJECT_TEST, "a:default");
  assert.equal(second.env.PROJECT_TEST, "b:default");
  assert.ok(Object.isFrozen(first.env));
});

test("edits are lazy; current execution finishes and queued work waits for direnv approval", integration, async (t) => {
  const { projects: [cwd], baseline, environments } = await fixture(t);
  let finish, started, asked, answer;
  const running = new Promise((resolve) => { started = resolve; });
  const release = new Promise((resolve) => { finish = resolve; });
  const prompted = new Promise((resolve) => { asked = resolve; });
  const decision = new Promise((resolve) => { answer = resolve; });
  let prompts = 0;
  const executed = [];
  const barrier = createEnvironmentBarrier({
    environments,
    requestApproval: async ({ approval }) => { prompts++; asked(approval); return decision; },
  });
  const execute = async (input, context) => {
      await barrier.resolve({ cwd, ...context });
      executed.push(input.command);
      if (input.command === "running") { started(); await release; }
      return input.command;
  };
  const context = { sessionID: "one", signal: new AbortController().signal };
  const first = execute({ command: "running" }, context);
  await running;
  await writeFile(path.join(cwd, ".envrc"), 'export PROJECT_TEST="intermediate"\n');
  await writeFile(path.join(cwd, ".envrc"), 'export PROJECT_TEST="finished-edit"\n');
  assert.equal(prompts, 0);
  finish();
  assert.equal(await first, "running");
  assert.equal(prompts, 0);
  const second = execute({ command: "next" }, context);
  const third = execute({ command: "queued" }, context);
  const approval = await prompted;
  assert.equal(await approval.isCurrent(), true);
  assert.equal(prompts, 1);
  assert.deepEqual(executed, ["running"]);
  // An explicit operator action grants native direnv trust, not the form.
  await exec(direnv, ["allow", cwd], { env: baseline });
  answer("retry");
  assert.deepEqual(await Promise.all([second, third]), ["next", "queued"]);
  assert.deepEqual(executed, ["running", "next", "queued"]);
  assert.equal(prompts, 1);
});

test("declined revision is not repeatedly prompted or executed", integration, async (t) => {
  const { projects: [cwd], environments } = await fixture(t);
  await writeFile(path.join(cwd, ".envrc"), 'export PROJECT_TEST="changed"\n');
  let prompts = 0;
  const barrier = createEnvironmentBarrier({
    environments,
    requestApproval: async () => { prompts++; return "deny"; },
  });
  const context = { sessionID: "one", signal: new AbortController().signal };
  await assert.rejects(barrier.resolve({ cwd, ...context }), /declined/);
  await assert.rejects(barrier.resolve({ cwd, ...context }), /declined/);
  assert.equal(prompts, 1);
});

test("retry alone grants no trust; editing invalidates the displayed revision", integration, async (t) => {
  const { projects: [cwd], environments } = await fixture(t);
  await writeFile(path.join(cwd, ".envrc"), 'export PROJECT_TEST="first"\n');
  let prompts = 0;
  let previous;
  const barrier = createEnvironmentBarrier({
    environments,
    requestApproval: async ({ approval }) => {
      prompts++;
      if (prompts === 1) {
        previous = approval;
        await writeFile(path.join(cwd, ".envrc"), 'export PROJECT_TEST="second"\n');
        assert.equal(await approval.isCurrent(), false);
        return "retry";
      }
      assert.notEqual(approval.revision, previous.revision);
      return "deny";
    },
  });
  await assert.rejects(barrier.resolve({ cwd, sessionID: "one" }), /declined/);
  assert.equal(prompts, 2);
});

test("select and clear use the same manual approval barrier as resolve", integration, async (t) => {
  const { projects: [cwd], baseline, environments } = await fixture(t, { direnvApproval: "manual" }, false);
  let prompts = 0;
  const barrier = createEnvironmentBarrier({ environments, requestApproval: async () => {
    prompts++;
    await exec(direnv, ["allow", cwd], { env: baseline });
    return "retry";
  } });
  t.after(() => barrier.dispose());
  await barrier.select({ sessionID: "a", cwd, shell: "docs" });
  assert.equal(prompts, 1);
  assert.equal((await barrier.resolve({ sessionID: "a", cwd })).env.PROJECT_TEST, "a:docs");
  await writeFile(path.join(cwd, ".envrc"), 'export PROJECT_TEST="new-default"\n');
  await barrier.clear({ sessionID: "a", cwd });
  assert.equal(prompts, 2);
  assert.equal((await barrier.resolve({ sessionID: "a", cwd })).env.PROJECT_TEST, "new-default");
});

test("session move resets selection; deletion and unload reject future preparation", integration, async (t) => {
  const { projects: [cwd], environments } = await fixture(t);
  const barrier = createEnvironmentBarrier({ environments });
  await barrier.select({ sessionID: "a", cwd, shell: "docs" });
  await barrier.reset("a");
  assert.equal((await barrier.resolve({ sessionID: "a", cwd })).shell, null);
  await barrier.release("a");
  await assert.rejects(barrier.resolve({ sessionID: "a", cwd }), /unavailable/);
  await barrier.dispose();
  await assert.rejects(barrier.resolve({ sessionID: "b", cwd }), /unavailable/);
});

test("cancelling queued preparation settles before its predecessor without running later", { timeout: 3000 }, async () => {
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const calls = [];
  const barrier = createEnvironmentBarrier({ environments: {
    resolve: async ({ cwd }) => { calls.push(cwd); entered.resolve(); await finish.promise; return cwd; },
    release: () => {},
  } });
  const first = barrier.resolve({ sessionID: "a", cwd: "first" });
  await entered.promise;
  const controller = new AbortController();
  const rejected = assert.rejects(barrier.resolve({ sessionID: "a", cwd: "cancelled", signal: controller.signal }), { name: "AbortError" });
  controller.abort();
  await rejected;
  assert.deepEqual(calls, ["first"]);
  finish.resolve();
  assert.equal(await first, "first");
  await barrier.dispose();
  assert.deepEqual(calls, ["first"]);
});
