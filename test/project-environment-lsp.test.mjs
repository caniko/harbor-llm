import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import plugin from "../src/project-environment-v2.mjs";

test("v2 LSP startup uses the same project snapshot as shell execution", { skip: !process.env.DIRENV_BIN }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harbor-lsp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  await mkdir(path.join(project, "src"), { recursive: true });
  await writeFile(path.join(project, ".envrc"), 'export HARBOR_LSP_MARKER="prepared"\nunset HARBOR_LSP_REMOVED\n');
  const credential = path.join(root, "credential");
  await writeFile(credential, `#!${process.execPath}\nconsole.log("fixture-password");\n`, { mode: 0o700 });
  const hooks = {};
  const previous = process.env.HARBOR_LSP_REMOVED;
  process.env.HARBOR_LSP_REMOVED = "baseline";
  t.after(() => {
    if (previous === undefined) delete process.env.HARBOR_LSP_REMOVED;
    else process.env.HARBOR_LSP_REMOVED = previous;
  });
  const commands = {};
  const cleanup = await plugin.setup({
    options: {
      roots: [project], direnv: process.env.DIRENV_BIN, nix: process.env.NIX_BIN ?? "/missing/nix",
      system: "x86_64-linux", serverURL: "http://127.0.0.1:1", opencode: credential,
      direnvApproval: "auto", preparationLockDirectory: path.join(root, "locks"),
      projectXdg: { XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data") },
    },
    location: { directory: project },
    shell: { hook: async (name, callback) => { hooks.shell = callback; } },
    lsp: { hook: async (name, callback) => { assert.equal(name, "start.before"); hooks.lsp = callback; } },
    tool: { transform: async () => {} },
    command: { transform: async (callback) => callback({ add: (command) => { commands[command.name] = command; } }) },
    event: { async *subscribe({ signal }) { await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })); } },
  });
  t.after(cleanup);
  assert.equal(typeof hooks.lsp, "function");
  const signal = new AbortController().signal;
  const invocation = {
    sessionID: "one", signal, serverID: "pkl", filePath: path.join(project, "src", "Model.pkl"),
    cwd: root, command: ["pkl-lsp", "--stdio"], env: { SERVER_CONFIG: "wins" }, extendEnv: true,
  };
  await hooks.lsp(invocation);
  assert.equal(invocation.cwd, project);
  assert.equal(invocation.extendEnv, false);
  assert.equal(invocation.env.HARBOR_LSP_MARKER, "prepared");
  assert.equal(invocation.env.HARBOR_LSP_REMOVED, undefined);
  assert.equal(invocation.env.SERVER_CONFIG, "wins");
  assert.equal(invocation.env.PWD, project);
  const reused = { ...invocation, env: { SERVER_CONFIG: "wins" }, filePath: path.join(project, "Other.pkl") };
  await hooks.lsp(reused);
  assert.equal(reused.generation, invocation.generation);
  assert.deepEqual(reused.env, invocation.env);
  const shell = { sessionID: "one", signal, cwd: project, env: {} };
  await hooks.shell(shell);
  assert.equal(shell.env.HARBOR_LSP_MARKER, invocation.env.HARBOR_LSP_MARKER);
  await writeFile(path.join(project, ".envrc"), 'export HARBOR_LSP_MARKER="changed"\n');
  const next = { ...invocation, env: {} };
  await hooks.lsp(next);
  assert.equal(next.env.HARBOR_LSP_MARKER, "changed");
  assert.notEqual(next.generation, invocation.generation);
  await assert.rejects(hooks.lsp({ ...invocation, sessionID: undefined }), /session-aware native LSP/);
});
