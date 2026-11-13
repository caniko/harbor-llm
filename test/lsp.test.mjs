import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mergeLsp, pick } from "../src/lsp.mjs";

const cli = fileURLToPath(new URL("../src/lsp.mjs", import.meta.url));

test("devshell entries outrank the committed file; disabled and incomplete entries drop", () => {
  const servers = mergeLsp(
    { rust: { command: ["rust-analyzer"] }, taplo: { command: ["taplo", "lsp", "stdio"], extensions: [".toml"] }, pyright: { command: ["pyright"], extensions: [".py"] } },
    { rust: { command: ["/store/rust-analyzer"] }, pyright: { disabled: true }, basedpyright: { command: ["basedpyright"], extensions: [".py"] }, bare: { command: ["bare"] } },
  );
  assert.deepEqual(Object.keys(servers), ["rust", "taplo", "basedpyright"]);
  assert.deepEqual(servers.rust, { command: ["/store/rust-analyzer"], extensions: [".rs"] });
  assert.deepEqual(pick(servers, [".js", ".py"])?.[0], "basedpyright");
  assert.deepEqual(pick(servers, ["taplo"])?.[0], "taplo");
  assert.equal(pick(servers, [".go"]), undefined);
});

test("serve runs the devshell's server in the approved project environment", {
  skip: !process.env.DIRENV_BIN || !process.env.NIX_BIN,
}, async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "harbor-lsp-serve-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, XDG_CONFIG_HOME: `${root}/config`, XDG_DATA_HOME: `${root}/data`, HARBOR_LLM_LSP_OPTIONS: `${root}/options.json` };
  const project = `${root}/project`;
  await mkdir(`${project}/.opencode`, { recursive: true });
  // Echoes stdin with a variable only the project's .envrc sets.
  const echo = [process.execPath, "-e", 'process.stdin.on("data", (d) => process.stdout.write(d + ":" + process.env.PROBE))'];
  await writeFile(`${project}/.envrc`, `export PROBE=approved\nexport OPENCODE_CONFIG_CONTENT='${JSON.stringify({ lsp: { echo: { command: echo, extensions: [".x"] } } })}'\n`);
  await writeFile(`${project}/.opencode/opencode.jsonc`, JSON.stringify({ lsp: { filed: { command: ["filed"], extensions: [".y"] } } }));
  await writeFile(env.HARBOR_LLM_LSP_OPTIONS, JSON.stringify({ roots: [root], direnv: process.env.DIRENV_BIN, nix: process.env.NIX_BIN, system: "x86_64-linux" }));
  const list = async () => JSON.parse((await promisify(execFile)(process.execPath, [cli, "list", project], { env })).stdout);

  // Unapproved: only the committed file applies.
  assert.deepEqual(Object.keys(await list()), ["filed"]);
  await promisify(execFile)(process.env.DIRENV_BIN, ["allow", project], { env });
  assert.deepEqual(Object.keys(await list()), ["filed", "echo"]);

  const child = spawn(process.execPath, [cli, "serve", ".z,.x", project], { env, stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.end("ping");
  let output = "";
  for await (const chunk of child.stdout) output += chunk;
  assert.equal(output, "ping:approved");
});
