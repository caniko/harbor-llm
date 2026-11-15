import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AGENT_DEFAULTS, injectInitialize, mergeLsp, pick } from "../src/lsp.mjs";
import { PassThrough } from "node:stream";

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
  await writeFile(`${project}/.envrc`, `mkdir -p .direnv && touch .direnv/profile.rc\nwatch_file .direnv/profile.rc\nexport PROBE=approved\nexport OPENCODE_CONFIG_CONTENT='${JSON.stringify({ lsp: { echo: { command: echo, extensions: [".x"] } } })}'\n`);
  await writeFile(`${project}/.opencode/opencode.jsonc`, JSON.stringify({ lsp: { filed: { command: ["filed"], extensions: [".y"] } } }));
  await writeFile(env.HARBOR_LLM_LSP_OPTIONS, JSON.stringify({ roots: [root], direnv: process.env.DIRENV_BIN, nix: process.env.NIX_BIN, system: "x86_64-linux" }));
  const list = async () => JSON.parse((await promisify(execFile)(process.execPath, [cli, "list", project], { env })).stdout);

  // Unapproved: only the committed file applies.
  const unapproved = await list();
  assert.deepEqual(Object.keys(unapproved), ["filed"]);
  await promisify(execFile)(process.env.DIRENV_BIN, ["allow", project], { env });
  const approved = await list();
  assert.deepEqual(Object.keys(approved), ["filed", "echo"]);
  // Same command, new environment: the fingerprint moves.
  assert.notEqual(approved.filed.fingerprint, unapproved.filed.fingerprint);
  // Like nix-direnv's retention, every load touches a watched file: direnv's
  // bookkeeping moves, the environment does not.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await list()).filed.fingerprint, approved.filed.fingerprint);

  const child = spawn(process.execPath, [cli, "serve", ".z,.x", project], { env, stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.end("ping");
  let output = "";
  for await (const chunk of child.stdout) output += chunk;
  assert.equal(output, "ping:approved");
});

test("serve merges the agent profile into initialize and passes the rest through", async () => {
  const frame = (message) => {
    const body = JSON.stringify(message);
    return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  };
  const input = new PassThrough();
  const output = new PassThrough();
  const project = { checkOnSave: true, cargo: { features: ["admin"] } };
  const client = { cachePriming: { numThreads: 2 } };
  injectInitialize(input, output, { ...AGENT_DEFAULTS.rust, ...project });
  const initialize = frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { initializationOptions: client } });
  const later = frame({ jsonrpc: "2.0", method: "initialized", params: {} });
  // Split mid-header to cover a message arriving in pieces; a look-alike
  // header must not be read as the length.
  const tricky = `X-Content-Length: 1\r\n${initialize}`;
  input.write(tricky.slice(0, 10));
  input.end(tricky.slice(10) + later);
  let text = "";
  for await (const chunk of output) text += chunk;
  const [header, rest] = text.split("\r\n\r\n", 2);
  const length = Number(/Content-Length: (\d+)/.exec(header)[1]);
  const options = JSON.parse(rest.slice(0, length)).params.initializationOptions;
  assert.equal(options.checkOnSave, true, "the project map outranks agent defaults");
  assert.deepEqual(options.cargo.features, ["admin"]);
  assert.deepEqual(options.cachePriming, { enable: false, numThreads: 2 }, "client options merge last");
  assert.equal(options.files.watcher, "server");
  assert.equal(text.slice(header.length + 4 + length), later);
});
