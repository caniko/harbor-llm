// OpenCode v2 parses `lsp` config but has no LSP runtime. This serves a
// project's Harbor LSP map through the pinned opencode-v2-lsp-support plugin
// (MIT, ./upstream), with every server started by `harbor-llm-lsp serve` so it
// runs in the project environment. The package build substitutes @cli@.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import upstream from "./upstream/index.ts";
import { resolveSettings } from "./upstream/src/config.ts";

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

export default {
  id: "harbor-llm.lsp",
  async setup(ctx) {
    const root = ctx.location.directory;
    let options = ctx.options ?? {};
    try {
      const servers = JSON.parse((await promisify(execFile)(cli, ["list", root], { maxBuffer: 8 << 20 })).stdout);
      options = harborOptions(root, options, servers);
    } catch (error) {
      console.error(`[harbor-llm.lsp] ${root}: ${error.message}`);
    }
    return upstream.setup({ ...ctx, options });
  },
};
