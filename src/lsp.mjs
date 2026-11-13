#!/usr/bin/env node
// Harbor LSP bridge. A project's Harbor LSP map is OpenCode `lsp` config: the
// committed `.opencode/opencode.jsonc` plus the `OPENCODE_CONFIG_CONTENT` its
// devshell exports. Harnesses that cannot read either from the project's
// environment use this CLI:
//
//   harbor-llm-lsp list [DIR]                  print {name: {command, extensions, env?, initialization?}}
//   harbor-llm-lsp serve SELECTOR[,...] [DIR]  run the first server named SELECTOR or serving `.ext`
//
// The environment comes from the same project-environment resolver as the
// OpenCode adapter, from HARBOR_LLM_LSP_OPTIONS (a JSON file). It never
// approves an `.envrc`.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { constants } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createProjectEnvironments } from "./project-environment.mjs";

// OpenCode built-ins that Harbor declares without `extensions`.
// ponytail: only the bare built-ins Harbor emits today; add a row when a profile adds one.
const BUILTIN_EXTENSIONS = { rust: [".rs"], nixd: [".nix"] };

function lspOf(text, source) {
  if (!text) return {};
  let lsp;
  try {
    lsp = JSON.parse(text).lsp;
  } catch (error) {
    console.error(`harbor-llm-lsp: ignoring ${source}: ${error.message}`);
    return {};
  }
  return lsp && typeof lsp === "object" && !Array.isArray(lsp) ? lsp : {};
}

// Merge like OpenCode: the devshell's OPENCODE_CONFIG_CONTENT outranks the
// committed file, field by field per server.
export function mergeLsp(file, shell) {
  const merged = { ...file };
  for (const [name, entry] of Object.entries(shell)) merged[name] = { ...merged[name], ...entry };
  const servers = {};
  for (const [name, entry] of Object.entries(merged)) {
    if (!entry || entry.disabled) continue;
    const extensions = entry.extensions ?? BUILTIN_EXTENSIONS[name];
    if (!Array.isArray(entry.command) || !entry.command.length || !extensions?.length) {
      console.error(`harbor-llm-lsp: skipping ${name}: needs a command and extensions`);
      continue;
    }
    servers[name] = {
      command: entry.command,
      extensions,
      ...(entry.env && { env: entry.env }),
      ...(entry.initialization && { initialization: entry.initialization }),
    };
  }
  return servers;
}

export function pick(servers, selectors) {
  for (const selector of selectors) {
    if (!selector.startsWith(".") && servers[selector]) return [selector, servers[selector]];
    const found = Object.entries(servers).find(([, server]) => server.extensions.includes(selector));
    if (found) return found;
  }
  return undefined;
}

export async function resolveLsp(dir, environments) {
  const cwd = path.resolve(dir);
  // Like OpenCode outside a devshell: an unapproved or broken environment
  // still serves the committed file's servers.
  // No session: shell selection never applies, so the project default does.
  const project = await environments.resolve({ sessionID: "harbor-llm-lsp", cwd }).catch((error) => {
    console.error(`harbor-llm-lsp: project environment unavailable in ${cwd}: ${error.message}`);
    return { flake: false, env: process.env };
  });
  // A covered root without flake.nix is only the trust boundary, not the project.
  const root = project.flake ? project.root : cwd;
  const file = await readFile(path.join(root, ".opencode", "opencode.jsonc"), "utf8")
    .catch((error) => (error.code === "ENOENT" ? undefined : Promise.reject(error)));
  return {
    root,
    env: project.env,
    servers: mergeLsp(lspOf(file, ".opencode/opencode.jsonc"), lspOf(project.env.OPENCODE_CONFIG_CONTENT, "OPENCODE_CONFIG_CONTENT")),
  };
}

async function main([command, ...args]) {
  const options = JSON.parse(await readFile(process.env.HARBOR_LLM_LSP_OPTIONS, "utf8"));
  const environments = createProjectEnvironments({ ...options, direnvApproval: "manual", baseline: process.env });
  if (command === "list") {
    process.stdout.write(`${JSON.stringify((await resolveLsp(args[0] ?? process.cwd(), environments)).servers)}\n`);
    return;
  }
  if (command !== "serve" || !args[0]) throw new Error("usage: harbor-llm-lsp list [DIR] | serve SELECTOR[,...] [DIR]");
  const { root, env, servers } = await resolveLsp(args[1] ?? process.cwd(), environments);
  const [name, server] = pick(servers, args[0].split(",")) ?? [];
  if (!server) throw new Error(`no Harbor LSP server for ${args[0]} in ${root}`);
  // stdout carries the protocol: the server owns it from here.
  const child = spawn(server.command[0], server.command.slice(1), { cwd: root, env: { ...env, ...server.env }, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(`harbor-llm-lsp: cannot start ${name}: ${error.message}`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => process.exit(code ?? 128 + constants.signals[signal]));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`harbor-llm-lsp: ${error.message}`);
    process.exit(1);
  });
}
