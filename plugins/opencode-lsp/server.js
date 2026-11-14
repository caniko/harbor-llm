// OpenCode v2 parses `lsp` config but has no LSP runtime. This serves a
// project's Harbor LSP map through the pinned opencode-v2-lsp-support plugin
// (MIT, ./upstream), with every server started by `harbor-llm-lsp serve` so it
// runs in the project environment. The package build substitutes @cli@.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveSettings } from "./upstream/src/config.ts";
import { afterTool } from "./upstream/src/diagnostics.ts";
import { LspManager } from "./upstream/src/manager.ts";
import { lspTool } from "./upstream/src/tool.ts";

export const cli = "@cli@";

// Upstream deep-merges plugin options over every config document, so the
// Harbor map must be authoritative: switch off whatever else it would load and
// clear inherited `disabled` flags on Harbor's servers.
export function harborOptions(root, options, servers) {
  // An explicit `lsp: false` switches every server off, Harbor's included.
  if (options.lsp === false) return options;
  const lsp = {};
  for (const { id } of resolveSettings(root, options).servers) lsp[id] = { disabled: true };
  for (const [name, server] of Object.entries(servers)) {
    lsp[name] = {
      command: [cli, "serve", name, root],
      extensions: server.extensions,
      disabled: false,
      ...(server.initialization && { initialization: server.initialization }),
    };
  }
  return { ...options, lsp: { ...options.lsp, ...lsp } };
}

// OpenCode sets up a location for every session, and upstream starts one
// manager, and so one server process, each time. A manager is root-scoped and
// already shares startup and serializes each file, so sessions of one serve
// process share it per (root, settings, Harbor map) and the last one shuts it
// down. The map's fingerprints carry the command and environment that
// `harborOptions` hides behind the CLI wrapper.
const managers = new Map();
export function acquire(root, settings, servers) {
  const key = JSON.stringify([root, settings, servers]);
  let entry = managers.get(key);
  if (!entry) managers.set(key, (entry = { manager: new LspManager(settings, root), refs: 0 }));
  entry.refs++;
  let released = false;
  return {
    manager: entry.manager,
    async release() {
      if (released) return;
      released = true;
      if (--entry.refs > 0) return;
      managers.delete(key);
      await entry.manager.shutdown();
    },
  };
}

export default {
  id: "harbor-llm.lsp",
  async setup(ctx) {
    const root = ctx.location.directory;
    let options = ctx.options ?? {};
    let servers = {};
    try {
      servers = JSON.parse((await promisify(execFile)(cli, ["list", root], { maxBuffer: 8 << 20 })).stdout);
      options = harborOptions(root, options, servers);
    } catch (error) {
      console.error(`[harbor-llm.lsp] ${root}: ${error.message}`);
    }
    // Upstream's setup, over a shared manager.
    const settings = resolveSettings(root, options);
    if (settings.debug) console.error(`[lsp] servers: ${settings.servers.map((server) => server.id).join(", ") || "none"}`);
    if (settings.servers.length === 0) return;
    const { manager, release } = acquire(root, settings, servers);
    const disposers = [];
    try {
      disposers.push(await ctx.tool.transform((editor) => editor.add(lspTool(manager, root))));
      disposers.push(await ctx.tool.hook("execute.after", afterTool(manager, root, settings.diagnostics)));
    } catch (error) {
      for (const disposer of disposers.reverse()) await disposer.dispose();
      await release();
      throw error;
    }
    return async () => {
      for (const disposer of disposers.reverse()) await disposer.dispose();
      await release();
    };
  },
};
