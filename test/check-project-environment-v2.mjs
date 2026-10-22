import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, stat, symlink, realpath, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// node test/check-project-environment-v2.mjs <opencode> <direnv> <nix> <nix-direnv/direnvrc>
// For a source candidate: OPENCODE_SOURCE=/checkout and <opencode>=<bun>.
// Requires the proposed session-aware shell hook, not unmodified old v2.
const [opencode, direnv, nix, nixDirenvRC] = process.argv.slice(2);
assert.ok([opencode,direnv,nix,nixDirenvRC].every(value=>value && path.isAbsolute(value)), "supply absolute opencode, direnv, nix and nix-direnv direnvrc paths");
const preparationTimeoutMs = 5000;
const cleanupGraceMs = 2000;
const sourceArgs = process.env.OPENCODE_SOURCE ? ["run", "--cwd", path.join(process.env.OPENCODE_SOURCE,"packages/cli"), "src/index.ts"] : [];
const root = await mkdtemp(path.join(os.tmpdir(),"project-env-v2-"));
const a = `${root}/a`, b = `${root}/b`, home = `${root}/home`, probe = `${root}/probe`;
for (const directory of [a, b, home, probe]) await mkdir(directory);
let password = randomBytes(24).toString("hex");
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: `${home}/config`, XDG_DATA_HOME: `${home}/data`, XDG_STATE_HOME: `${home}/state`, OPENCODE_PASSWORD: password, PROJECT_TEST_BASE: "backend-value" };
if (process.env.PROJECT_ENV_NATIVE_CREDENTIAL === "1") {
  assert.equal(sourceArgs.length, 0, "native credential probe requires a packaged executable");
  delete env.OPENCODE_PASSWORD;
  password = (await promisify(execFile)(opencode, ["service", "get", "password"], {env,cwd:a})).stdout.trim();
  assert.ok(password);
}
for (const name of Object.keys(env)) if (name.startsWith("DIRENV_")) delete env[name];
// An ambient canary/opencode environment must not inject a second configured
// plugin instance (its own OPENCODE_CONFIG, credentials or terminal flags).
for (const name of Object.keys(env)) {
  if (name.startsWith("OPENCODE_") && name !== "OPENCODE_PASSWORD") delete env[name];
}
for (const project of [a, b]) {
  await writeFile(`${project}/flake.nix`, '{ outputs = {self}: { devShells.x86_64-linux = let shell = builtins.derivation {name="fixture-shell";system="x86_64-linux";builder="/bin/sh";}; in {default=shell;docs=shell;}; }; }');
  await writeFile(`${project}/.envrc`, `export PROJECT_TEST="${path.basename(project)}:\${PROJECT_DEV_SHELL:-default}"\nexport PROJECT_DEV_SHELL_ACTIVE="\${PROJECT_DEV_SHELL:-default}"\nunset PROJECT_TEST_BASE\n`);
  await promisify(execFile)(direnv, ["allow", project], { env });
}
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${socket.address().port}`;
await new Promise((resolve) => socket.close(resolve));
await writeFile(`${probe}/server.js`, `
import {writeFile} from "node:fs/promises";
export default {id:"harbor-llm.env-probe", async setup(ctx) {
 const pending = new Map();
 await ctx.command.transform(editor => editor.add({name:"env-probe-cancel", async execute({prompt}) {
  const {tag} = JSON.parse(prompt.text);
  if (!pending.has(tag)) throw new Error("missing pending probe");
  pending.get(tag).abort();
 }}));
 await ctx.command.transform(editor => editor.add({name:"env-probe", async execute({sessionID,prompt}) {
  const input = JSON.parse(prompt.text);
  const shell = (await ctx.tool.list()).find(tool => tool.name === "shell");
  if (!shell) throw new Error("missing native shell");
  const controller = new AbortController();
  pending.set(input.tag, controller);
  try {
   const result = await shell.execute(input, {sessionID, agent:"code", messageID:"msg_env_probe", id:"call_env_probe", signal:controller.signal, progress:async()=>{}});
   await writeFile(${JSON.stringify(root)} + "/result-" + input.tag + ".json", JSON.stringify(result));
  } catch (error) {
   await writeFile(${JSON.stringify(root)} + "/failure-" + input.tag + ".json", JSON.stringify({name:error.name, code:error.code, message:String(error)}));
   throw error;
  } finally { pending.delete(input.tag); }
 }}));
}};
`);
await writeFile(`${a}/opencode.json`, JSON.stringify({ plugins: [
   { package: process.env.PROJECT_ENV_PLUGIN ?? fileURLToPath(new URL("../plugins/project-environment-prototype", import.meta.url)), options: {plugin:process.env.PROJECT_ENV_IMPLEMENTATION, roots:[a,b], direnv, nix, system:"x86_64-linux", serverURL:url, direnvApproval:"manual", opencode, preparationTimeoutMs, preparationLockDirectory:`${root}/preparation-locks`, bootstrapEnvironment:{PATH:env.PATH, HOME:home}} },
  { package: probe },
] }));
const child = spawn(opencode, [...sourceArgs, "--print-logs", "serve", ...(process.env.PROJECT_ENV_NATIVE_CREDENTIAL === "1" ? ["--service"] : []), "--hostname", "127.0.0.1", "--port", new URL(url).port], {cwd:a, env, stdio:["ignore","pipe","pipe"]});
let log = "";
child.stdout.on("data", chunk => { log += chunk; });
child.stderr.on("data", chunk => { log += chunk; });
const closed = new Promise(resolve => child.once("close",resolve));
const headers = {Authorization:`Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "Content-Type":"application/json"};
async function request(method, endpoint, body) {
   const response = await fetch(url + endpoint, {method,headers,body:body === undefined ? undefined : JSON.stringify(body),signal:AbortSignal.timeout(180_000)});
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}
async function waitFor(check, description, timeoutMs = cleanupGraceMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${description} (${timeoutMs}ms)`);
}
async function exists(file) {
  try { await stat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function progressSince(offset) {
  return log.slice(offset).split("\n").flatMap(line => {
    const match = line.match(/project-environment (\{.*\})/);
    return match ? [JSON.parse(match[1])] : [];
  });
}
try {
 for (let i=0;i<100 && !log.includes("server listening on");i++) await new Promise(resolve=>setTimeout(resolve,100));
 assert.match(log,/server listening on/);
 const query = new URLSearchParams({"location[directory]":a});
 await request("GET",`/api/config?${query}`);
 for (let i=0;i<100;i++) {
  const plugins = await request("GET",`/api/plugin?${query}`);
  if (plugins.data.some(p=>p.id==="harbor-llm.env-probe" && p.state.status==="active")) break;
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 const create = async (effect = "allow") => (await request("POST","/api/session",{location:{directory:a},permissions:[{action:"*",resource:"*",effect:"allow"},{action:"shell",resource:"*",effect}]})).data.id;
 const one = await create(), two = await create();
 const command = (session,name,text) => request("POST",`/api/session/${session}/command`,{name,text:JSON.stringify(text)});
 async function run(session,workdir,tag, shellCommand = "printf '%s|%s' \"$PROJECT_TEST\" \"$PROJECT_TEST_BASE\"") {
  await command(session,"env-probe",{command:shellCommand,workdir,tag});
  const result = JSON.parse(await readFile(`${root}/result-${tag}.json`,"utf8"));
  assert.equal(result.output.status,"completed",JSON.stringify(result));
  return result.output.output;
 }
  assert.match(await run(one,a,"default"),/a:default\|/);
  // A nested flake without its own .envrc inherits the in-scope ancestor, and
  // an uncovered workdir keeps the baseline: neither fails the command.
  await mkdir(`${a}/nested`);
  await writeFile(`${a}/nested/flake.nix`, '{ outputs = {self}: { devShells.x86_64-linux = let shell = builtins.derivation {name="nested-shell";system="x86_64-linux";builder="/bin/sh";}; in {default=shell;}; }; }');
  assert.match(await run(one,`${a}/nested`,"nested"),/a:default\|/);
  assert.match(await run(one,probe,"uncovered"),/^\|backend-value/);
  assert.match(await run(one,a,"recovers"),/a:default\|/);
  console.log("PASS: nested flake and uncovered workdir resolve without failing the command");
 async function approveDuring(session, action) {
   const prior = new Set((await request("GET",`/api/session/${session}/form`)).data.map(item=>item.id));
   const pending = action().then(value=>({value}),error=>({error}));
   let approval;
    // Selection first evaluates the native Nix catalog (a 120s bounded
    // operation), then requests approval. Do not abort it after only 5s.
    for(let i=0;i<2600;i++) {
     approval=(await request("GET",`/api/session/${session}/form`)).data.find(item=>!prior.has(item.id));
     if(approval) break;
     await new Promise(resolve=>setTimeout(resolve,50));
   }
   assert.ok(approval,"selection operation must request native approval");
   await promisify(execFile)(direnv,["allow",a],{env});
   await request("POST",`/api/session/${session}/form/${approval.id}/reply`,{answer:{decision:"retry"}});
   const result=await pending;
   if(result.error) throw result.error;
 }
 await writeFile(`${a}/.envrc`,(await readFile(`${a}/.envrc`,"utf8"))+"\n# selected revision\n");
 await approveDuring(one,()=>command(one,"project-env-select",{cwd:a,shell:"docs"}));
 assert.match(await run(one,a,"selected"),/a:docs\|/);
 assert.doesNotMatch(await run(one,a,"removed"),/backend-value/);
 assert.match(await run(two,a,"isolated"),/a:default\|/);
 const [ra,rb] = await Promise.all([run(one,a,"parallel-a"),run(one,b,"parallel-b")]);
 assert.match(ra,/a:docs\|/); assert.match(rb,/b:default\|/);
 await writeFile(`${a}/.envrc`,(await readFile(`${a}/.envrc`,"utf8"))+"\n# cleared revision\n");
 await approveDuring(one,()=>command(one,"project-env-clear",{cwd:a}));
 assert.match(await run(one,a,"clear"),/a:default\|/);
 const finishing = run(one,a,"finishing",`printf started > '${root}/started'; while [ ! -f '${root}/release' ]; do sleep 0.05; done; printf 'finished:%s' "$PROJECT_TEST"`);
 for(let i=0;i<100;i++) {
  try { await readFile(`${root}/started`); break; } catch { await new Promise(resolve=>setTimeout(resolve,50)); }
 }
  assert.equal(await readFile(`${root}/started`,"utf8"),"started");
  // Unlike the former wrapper, a long foreground command in A does not
  // serialize a second command in B behind its completion.
  assert.match(await run(one,b,"while-a-running"),/b:default\|/);
 await writeFile(`${a}/.envrc`,'export PROJECT_TEST="intermediate-edit"\n');
 await writeFile(`${a}/.envrc`,'export PROJECT_TEST="after-approval"\nunset PROJECT_TEST_BASE\n');
 assert.deepEqual((await request("GET",`/api/session/${one}/form`)).data,[]);
 await writeFile(`${root}/release`,"");
 assert.match(await finishing,/finished:a:default/);
 assert.deepEqual((await request("GET",`/api/session/${one}/form`)).data,[]);
 const held = run(one,a,"after-approval");
 let form;
 for(let i=0;i<100;i++) {
  form=(await request("GET",`/api/session/${one}/form`)).data.find(item=>item.metadata.revision && item.metadata.envrc === `${a}/.envrc`);
  if(form) break;
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 assert.ok(form,"new execution must request approval");
 assert.equal(form.metadata.envrc,`${a}/.envrc`);
 await assert.rejects(readFile(`${root}/result-after-approval.json`),{code:"ENOENT"});
 await promisify(execFile)(direnv,["allow",a],{env});
 await request("POST",`/api/session/${one}/form/${form.id}/reply`,{answer:{decision:"retry"}});
 assert.match(await held,/after-approval\|/);
 console.log("PASS: editing is lazy, running command finishes, new command waits for a real v2 form then resumes after native direnv approval");
 console.log("PASS: real native executor default/select/clear/tombstones/two projects/two sessions/concurrency");
  // With the proposed native hook API, direct user-shell execution now
  // enters the same approval barrier instead of using a stale session env.
 await writeFile(`${a}/.envrc`,'export PROJECT_TEST="unapproved-again"\n');
  const direct = request("POST",`/api/session/${one}/shell`,{command:`/bin/sh -c 'printf "%s" "$PROJECT_TEST" > "${root}/bypass"'`});
  let directForm;
  for(let i=0;i<100;i++) {
    directForm=(await request("GET",`/api/session/${one}/form`)).data.find(item=>item.id!==form.id);
    if(directForm) break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(directForm,"direct shell must request approval");
  await assert.rejects(readFile(`${root}/bypass`),{code:"ENOENT"});
  await promisify(execFile)(direnv,["allow",a],{env});
  await request("POST",`/api/session/${one}/form/${directForm.id}/reply`,{answer:{decision:"retry"}});
  await direct;
 for(let i=0;i<100;i++) {
  try { await readFile(`${root}/bypass`); break; } catch { await new Promise(resolve=>setTimeout(resolve,50)); }
 }
  assert.equal(await readFile(`${root}/bypass`,"utf8"),"unapproved-again");
  console.log("PASS WITH PROPOSED CORE CHANGE: direct user shell waits and uses the fresh approved environment");
   const denied = await create("deny");
   const preparationBeforeDenial = log.split("environment request").length;
   await assert.rejects(command(denied,"env-probe",{command:`printf denied > '${root}/denied'`,workdir:b,tag:"denied"}));
   await assert.rejects(readFile(`${root}/denied`),{code:"ENOENT"});
   assert.equal(log.split("environment request").length,preparationBeforeDenial,"denied invocation must not prepare an environment");
   await assert.rejects(command(denied,"env-probe",{command:`printf denied > '${root}/denied'`,workdir:b,tag:"denied-bootstrap",environment:"bootstrap"}));
   assert.equal(log.split("environment request").length,preparationBeforeDenial,"bootstrap must retain shell authorization");
   console.log("PASS: native project and bootstrap denial prevent preparation and command side effects");
   await writeFile(`${b}/flake.lock`,"broken");
   await writeFile(`${b}/.envrc`, `echo export >> '${root}/exports'\nif grep -q broken flake.lock; then\n echo "requires lock file changes but they're not allowed due to '--no-update-lock-file'" >&2\n exit 1\nfi\nexport PROJECT_TEST="repaired"\n`);
   await promisify(execFile)(direnv,["allow",b],{env});
   await assert.rejects(command(one,"env-probe",{command:"printf should-not-run",workdir:b,tag:"drift"}));
   await assert.rejects(command(two,"env-probe",{command:"printf should-not-run",workdir:b,tag:"blocked"}));
   assert.equal((await readFile(`${root}/exports`,"utf8")).trim(),"export");
   await command(one,"env-probe",{command:"printf repaired > flake.lock",workdir:b,tag:"bootstrap-repair",environment:"bootstrap"});
   const repaired = JSON.parse(await readFile(`${root}/result-bootstrap-repair.json`,"utf8"));
   assert.equal(repaired.output.status,"completed");
   assert.match(await run(one,b,"project-repaired"),/repaired/);
   assert.equal((await readFile(`${root}/exports`,"utf8")).trim().split("\n").length,2);
   assert.match(log,/"invocationID":"sh_/);
   assert.match(log,/"toolCallID":"call_env_probe"/);
    console.log("PASS: one attributable drift failure, blocked repeat, explicit bootstrap repair, project-mode recovery");
   // Exercise real nix-direnv cache handling. Only its Nix subprocess boundary
   // is doubled: no fixture builds, downloads or production GC roots are used.
   await mkdir(`${b}/.direnv`);
   await mkdir(`${root}/cache-target`);
   await writeFile(`${root}/cache-value`, "cache-renewed");
   const profile = `${b}/.direnv/flake-profile-${createHash("sha1").update(".\n").digest("hex")}`;
   await symlink(`${root}/missing-cache-target`, profile);
   await writeFile(`${b}/.envrc`, `source ${JSON.stringify(nixDirenvRC)}
_nix() {
  case "$1" in
    print-dev-env)
      printf 'renewal\\n' >> '${root}/renewals'
      if [[ -e '${root}/stall-renewal' ]]; then
        sleep 30 &
        echo $! > '${root}/hung-helper.pid'
        wait
      fi
      while [[ ! -e '${root}/release-renewal' ]]; do sleep 0.02; done
      ln -s '${root}/cache-target' "$3"
      printf 'export PROJECT_TEST="%s"\\n' "$(cat '${root}/cache-value')"
      ;;
    flake) printf '{}\\n' ;;
    build) ln -sfn -- "$(readlink -f "$4")" "$3" ;;
    *) return 1 ;;
  esac
}
nix_direnv_disallow_fallback
use flake .
`);
   // The stale body is newer than the definitions: the missing profile alone
   // must trigger renewal, not a simultaneous .envrc edit.
   await writeFile(`${profile}.rc`, 'export PROJECT_TEST="stale-cache"\n');
   await promisify(execFile)(direnv,["allow",b],{env});
   assert.equal(await exists(profile), false, "fixture must start with a dangling profile");
   const renewalLogStart = log.length;
   const renewed = run(one,b,"cache-renewed-a");
   // Attach handlers before another assertion can fail, without hiding failure.
   renewed.catch(() => {});
   await waitFor(() => exists(`${root}/renewals`), "cache renewal to start");
   const joinedRenewal = run(two,b,"cache-renewed-b");
   joinedRenewal.catch(() => {});
   await waitFor(() => progressSince(renewalLogStart).some(event => event.shared), "concurrent cache renewal to join");
   await command(one,"env-probe",{command:`touch '${root}/release-renewal'`,workdir:b,tag:"release-renewal",environment:"bootstrap"});
   assert.deepEqual(await Promise.all([renewed,joinedRenewal]), ["cache-renewed|backend-value","cache-renewed|backend-value"]);
   assert.equal(await realpath(profile), `${root}/cache-target`);
   const cacheTimestamp = (await stat(`${profile}.rc`)).mtimeMs;
   const warmLogStart = log.length;
   assert.match(await run(one,b,"cache-warm-a"), /^cache-renewed\|/);
   assert.match(await run(two,b,"cache-warm-b"), /^cache-renewed\|/);
   assert.equal((await stat(`${profile}.rc`)).mtimeMs, cacheTimestamp, "warm loads must not invalidate the watched cache");
   assert.equal(progressSince(warmLogStart).filter(event => event.phase === "direnv export" && event.status === "ready").length, 2, "warm commands must still load through direnv, not a second environment cache");
   assert.equal(await readFile(`${root}/renewals`,"utf8"), "renewal\n", "concurrent and warm callers must not repeat the Nix renewal");
   console.log("PASS: dangling nix-direnv profile renews once for concurrent callers and warm loads preserve the cache");
   // Recreate only the fixture's dangling profile. Stall inside nix-direnv's
   // renewal while concurrent native callers wait and bootstrap stays usable.
   const retainedCache = await readFile(`${profile}.rc`, "utf8");
   await writeFile(`${root}/stall-renewal`, "");
   await unlink(profile);
   await symlink(`${root}/missing-cache-target`, profile);
   const hungLogStart = log.length;
   const hung = tag => command(tag === "hung-cancelled" ? one : two,"env-probe",{
     command:`printf should-not-run > '${root}/unexpected-command'`,workdir:b,tag,
   }).then(value=>({value}),error=>({error}));
   let cancelledSettled = false, survivorSettled = false;
   const hungStarted = performance.now();
   let survivorFinished;
   const cancelled = hung("hung-cancelled").finally(() => { cancelledSettled = true; });
   await waitFor(() => exists(`${root}/hung-helper.pid`), "hung export to start");
   const helper = Number(await readFile(`${root}/hung-helper.pid`,"utf8"));
   assert.ok(Number.isSafeInteger(helper) && helper > 1);
   const surviving = hung("hung-surviving").finally(() => { survivorSettled = true; survivorFinished = performance.now(); });
   await waitFor(() => progressSince(hungLogStart).some(event => event.shared === true), "both callers to join the export");
   const preparation = progressSince(hungLogStart).find(event => event.phase === "direnv export" && event.status === "preparing");
   assert.equal(preparation.timeoutMs, preparationTimeoutMs);
   assert.ok(progressSince(hungLogStart).some(event => event.shared && event.preparationID === preparation.preparationID));
   await command(one,"env-probe",{command:"true",workdir:b,tag:"hung-bootstrap",environment:"bootstrap"});
   assert.equal(JSON.parse(await readFile(`${root}/result-hung-bootstrap.json`,"utf8")).output.status,"completed");
   const sharedCancellationStarted = performance.now();
   await command(one,"env-probe-cancel",{tag:"hung-cancelled"});
   await waitFor(() => cancelledSettled, "caller cancellation", 1000);
   assert.ok(performance.now() - sharedCancellationStarted < 1000, "cancellation must settle promptly, including its control request");
   assert.ok((await cancelled).error,"cancelled preparation must settle without starting the command");
   const cancellation = JSON.parse(await readFile(`${root}/failure-hung-cancelled.json`,"utf8"));
   assert.match(JSON.stringify(cancellation), /cancel|abort|interrupt/i);
   assert.doesNotMatch(JSON.stringify(cancellation), /timeout/i);
   assert.equal(survivorSettled, false, "cancellation must settle before the surviving caller's deadline");
   assert.equal(await exists(`/proc/${helper}`), true, "the surviving export must still own its helper");
   assert.equal(await readFile(`${root}/renewals`,"utf8"),"renewal\nrenewal\n","cancelling one waiter must not restart or cancel the surviving renewal");
   await waitFor(() => survivorSettled, "the configured preparation deadline", preparationTimeoutMs + cleanupGraceMs);
   const survivor = await surviving;
   assert.ok(survivor.error,"hung preparation must reach its configured deadline");
   const failure = progressSince(hungLogStart).find(event => event.preparationID === preparation.preparationID && event.status === "failed");
   assert.equal(failure.reason, "timeout");
   assert.equal(failure.timeoutMs, preparationTimeoutMs);
   assert.ok(failure.elapsedMs >= preparationTimeoutMs - 20 && failure.elapsedMs <= preparationTimeoutMs + cleanupGraceMs, JSON.stringify(failure));
   assert.ok(survivorFinished - hungStarted <= preparationTimeoutMs + cleanupGraceMs, "the native request must settle within the deadline and cleanup grace");
   const timeout = JSON.parse(await readFile(`${root}/failure-hung-surviving.json`,"utf8"));
   assert.equal(timeout.code, "TIMEOUT");
   assert.ok(timeout.message.includes(`preparation=${preparation.preparationID}`));
   await assert.rejects(stat(`${root}/unexpected-command`),{code:"ENOENT"});
   await waitFor(async () => !await exists(`/proc/${helper}`), "timed-out helper cleanup");
   assert.equal(await readFile(`${profile}.rc`, "utf8"), retainedCache, "failed renewal must preserve the previous cache without executing it");
   assert.equal(await exists(profile), false, "timed-out renewal must not publish a profile");
   await writeFile(`${root}/cache-value`, "after-timeout");
   await unlink(`${root}/stall-renewal`);
   assert.match(await run(two,b,"after-timeout"), /^after-timeout\|/);
   assert.equal(await realpath(profile), `${root}/cache-target`);
   assert.equal(await readFile(`${root}/renewals`, "utf8"), "renewal\nrenewal\nrenewal\n");
   console.log("PASS: hung nix-direnv renewal shares work, bootstrap bypasses the wait, cancellation preserves peers, timeout reaps children and same-input retry succeeds");
   // A final waiter must clean up on cancellation, without waiting for timeout.
   await writeFile(`${b}/.envrc`, `sleep 30 &\necho $! > '${root}/last-helper.pid'\nwait\n`);
   await promisify(execFile)(direnv,["allow",b],{env});
   const lastLogStart = log.length;
   let lastSettled = false;
   const last = command(one,"env-probe",{command:`touch '${root}/last-command'`,workdir:b,tag:"last-cancelled"})
     .then(value=>({value}),error=>({error})).finally(() => { lastSettled = true; });
   await waitFor(() => exists(`${root}/last-helper.pid`), "final waiter's helper");
   const lastHelper = Number(await readFile(`${root}/last-helper.pid`,"utf8"));
   assert.ok(Number.isSafeInteger(lastHelper) && lastHelper > 1);
   const cancellationStarted = performance.now();
   await command(one,"env-probe-cancel",{tag:"last-cancelled"});
   await waitFor(() => lastSettled, "final waiter cancellation", 1000);
   assert.ok(performance.now() - cancellationStarted < 1000, "final waiter cancellation must settle promptly");
   assert.ok((await last).error);
   assert.match(await readFile(`${root}/failure-last-cancelled.json`,"utf8"), /cancel|abort|interrupt/i);
   assert.doesNotMatch(await readFile(`${root}/failure-last-cancelled.json`,"utf8"), /timeout/i);
   await waitFor(async () => !await exists(`/proc/${lastHelper}`), "cancelled helper cleanup");
   assert.ok(performance.now() - cancellationStarted < preparationTimeoutMs, "cleanup must precede the preparation deadline");
   assert.equal(progressSince(lastLogStart).some(event => event.reason === "timeout"), false);
   assert.equal(await exists(`${root}/last-command`), false);
   await writeFile(`${b}/.envrc`, 'export PROJECT_TEST="after-cancellation"\n');
   await promisify(execFile)(direnv,["allow",b],{env});
   assert.match(await run(one,b,"after-cancellation"), /^after-cancellation\|/);
   console.log("PASS: final waiter cancellation reaps its helper before timeout and permits immediate retry");
   // Contend on the actual persistent export anchor. A queued cancellation
   // must not execute .envrc, delete the anchor, or terminate its other owner.
   await writeFile(`${b}/.envrc`, `echo export >> '${root}/queued-exports'\nexport PROJECT_TEST="after-lock"\n`);
   await promisify(execFile)(direnv,["allow",b],{env});
   const anchor = preparation.lock;
   const anchorInode = (await stat(anchor)).ino;
   const holder = spawn("flock",["--nonblock","--exclusive",anchor,"sh","-c",`touch '${root}/lock-held'; cat >/dev/null`],{env,stdio:["pipe","ignore","ignore"]});
   const holderClosed = new Promise((resolve,reject) => {
     holder.once("error",reject);
     holder.once("close",code => code === 0 ? resolve() : reject(new Error(`lock holder exited ${code}`)));
   });
   holderClosed.catch(() => {});
   try {
     await waitFor(() => exists(`${root}/lock-held`), "fixture lock owner");
     const lockLogStart = log.length;
     let queuedSettled = false;
     const queued = command(one,"env-probe",{command:`touch '${root}/queued-command'`,workdir:b,tag:"lock-cancelled"})
       .then(value=>({value}),error=>({error})).finally(() => { queuedSettled = true; });
     await waitFor(() => progressSince(lockLogStart).some(event => event.phase === "direnv export" && event.lock === anchor), "export waiting for the lock");
     await command(one,"env-probe",{command:"true",workdir:b,tag:"locked-bootstrap",environment:"bootstrap"});
     assert.equal(JSON.parse(await readFile(`${root}/result-locked-bootstrap.json`,"utf8")).output.status,"completed");
     assert.equal(queuedSettled, false, "the project request must remain blocked behind the lock");
     assert.equal(await exists(`${root}/queued-exports`), false, "a blocked export must not execute .envrc");
     const queuedPreparation = progressSince(lockLogStart).find(event => event.phase === "direnv export" && event.status === "preparing");
     const queuedCancellationStarted = performance.now();
     await command(one,"env-probe-cancel",{tag:"lock-cancelled"});
     await waitFor(() => queuedSettled, "queued lock cancellation", 1000);
     assert.ok(performance.now() - queuedCancellationStarted < 1000, "lock cancellation must settle promptly");
     assert.ok((await queued).error);
     assert.match(await readFile(`${root}/failure-lock-cancelled.json`,"utf8"), /cancel|abort|interrupt/i);
     assert.doesNotMatch(await readFile(`${root}/failure-lock-cancelled.json`,"utf8"), /timeout/i);
     await waitFor(() => progressSince(lockLogStart).some(event => event.preparationID === queuedPreparation.preparationID && event.reason === "cancelled"), "queued preparation cleanup before lock release");
     assert.equal(await exists(`${root}/queued-exports`), false);
     assert.equal(await exists(`${root}/queued-command`), false);
     assert.equal(holder.exitCode, null, "cancellation must leave the other lock owner alive");
     assert.equal(holder.signalCode, null);
     assert.equal((await stat(anchor)).ino, anchorInode, "cancellation must not replace the lock anchor");
     await assert.rejects(promisify(execFile)("flock",["--nonblock","--exclusive",anchor,"true"]),{code:1});
   } finally {
     holder.stdin.end();
     await holderClosed;
   }
   assert.match(await run(one,b,"after-lock-release"), /^after-lock\|/);
   assert.equal(await readFile(`${root}/queued-exports`,"utf8"), "export\n", "cancelled lock waiters must never execute later");
   assert.equal((await stat(anchor)).ino, anchorInode);
   console.log("PASS: held-lock cancellation and bootstrap stay responsive, preserve the owner/anchor and permit retry after release");
  const deleting = await create();
  await writeFile(`${a}/.envrc`, 'export PROJECT_TEST="deleted-session"\n');
  const selecting = command(deleting,"project-env-select",{cwd:a,shell:"docs"}).then(()=>({ok:true}),error=>({error}));
  let deletionForm;
  for(let i=0;i<100;i++) {
    deletionForm=(await request("GET",`/api/session/${deleting}/form`)).data[0];
    if(deletionForm) break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(deletionForm,"selection must be waiting before deletion");
  await request("DELETE",`/api/session/${deleting}`);
  assert.ok((await selecting).error,"deletion must cancel the pending selection");
  console.log("PASS: select/clear use native forms; session deletion cancels pending selection");
} finally {
 child.kill("SIGTERM");
 const timer=setTimeout(()=>child.kill("SIGKILL"),5000);
 await closed; clearTimeout(timer);
 await writeFile(`${root}/backend.log`,log.replaceAll(password,"[redacted]"));
 console.log(`evidence: ${root}`);
}
