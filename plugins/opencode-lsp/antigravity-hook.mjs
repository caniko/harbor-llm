// Antigravity (agy-acp-server) PreToolUse hook: Harbor LSP errors in the files
// the agent edited. Antigravity discards PostToolUse output, so a PreToolUse
// denial is the only way back to the model: edit calls record their target
// files, and the first other call (a read, a command) checks them, so errors a
// later edit fixes are never reported. Clean files pass silently; errors deny
// that one call with the report. Checked files are forgotten either way, so
// the agent is never held. Any failure allows the call: Antigravity treats
// a failing hook as a denial. The package build substitutes @cli@ (via
// server.js) and places upstream/ beside this file.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { cli, harborOptions } from "./server.js";
import { resolveSettings } from "./upstream/src/config.ts";
import { diagnosticsReport } from "./upstream/src/format.ts";
import { LspManager, insideProject } from "./upstream/src/manager.ts";

// Below the 90 s handler timeout in the hooks.json this ships with.
const BUDGET_MS = 75_000;
// ponytail: edit tools by name; extend when Antigravity renames or adds one.
const EDIT_TOOL = /write|replace|edit|create|patch/i;
const PATH_ARG = /file|path/i;

/** Files an edit call names, resolved against the workspace. */
export function editedFiles(call, root) {
  if (!call || !EDIT_TOOL.test(call.name ?? "") || !call.args || typeof call.args !== "object") return [];
  return Object.entries(call.args)
    .filter(([key, value]) => PATH_ARG.test(key) && typeof value === "string" && value)
    .map(([, value]) => path.resolve(root, value));
}

/** The report for files with errors, or "" when they are clean. */
export async function check(root, files) {
  const servers = JSON.parse((await promisify(execFile)(cli, ["list", root], { maxBuffer: 8 << 20 })).stdout);
  const settings = resolveSettings(root, harborOptions(root, {}, servers));
  const manager = new LspManager(settings, root);
  try {
    const sections = [];
    for (const file of files) {
      if (!manager.serversFor(file).length || !(await insideProject(root, file))) continue;
      if (!(await stat(file).then((s) => s.isFile(), () => false))) continue;
      const report = diagnosticsReport(file, (await manager.diagnostics(file)).file ?? []);
      if (report) sections.push(report);
    }
    return sections.length ? `LSP errors in files you edited, please fix:\n${sections.join("\n")}` : "";
  } finally {
    await manager.shutdown();
  }
}

async function main(input) {
  const root = process.cwd();
  const state = path.join(tmpdir(), "harbor-lsp-antigravity",
    `${createHash("sha256").update(String(input.conversationId ?? "")).digest("hex").slice(0, 16)}`);
  const edited = editedFiles(input.toolCall, root);
  if (edited.length) {
    // Appends, not rewrites: Antigravity may run hooks for parallel edits at once.
    await mkdir(path.dirname(state), { recursive: true });
    await appendFile(state, edited.map((file) => `${file}\n`).join(""));
    return {};
  }
  // Claim the pending list atomically, and forget it before checking: a check
  // that fails or times out must not repeat on every call.
  const claimed = `${state}.${process.pid}`;
  if (!(await rename(state, claimed).then(() => true, () => false))) return {};
  const pending = [...new Set((await readFile(claimed, "utf8")).split("\n").filter(Boolean))];
  await rm(claimed, { force: true });
  const report = await check(root, pending);
  return report ? { decision: "deny", reason: report } : {};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // Exit once the reply is flushed: a cut-off reply is invalid JSON, which denies.
  const done = (result) => process.stdout.write(JSON.stringify(result), () => process.exit(0));
  setTimeout(() => done({}), BUDGET_MS).unref();
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  main(JSON.parse(Buffer.concat(chunks).toString() || "{}")).then(done, (error) => {
    console.error(`harbor-lsp antigravity hook: ${error.message}`);
    done({});
  });
}
