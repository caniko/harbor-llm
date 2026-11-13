// OpenCode v2 parses `lsp` config but has no LSP runtime. This serves a
// project's Harbor LSP map through the pinned opencode-v2-lsp-support plugin
// (MIT, ./upstream), with every server started by `harbor-llm-lsp serve` so it
// runs in the project environment. Plugin `lsp` options outrank config files
// per server, so the committed file's entries are replaced, not duplicated.
// The package build substitutes @cli@.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import upstream from "./upstream/index.ts";

const cli = "@cli@";

export default {
  id: "harbor-llm.lsp",
  async setup(ctx) {
    const root = ctx.location.directory;
    let lsp = {};
    try {
      const servers = JSON.parse((await promisify(execFile)(cli, ["list", root], { maxBuffer: 8 << 20 })).stdout);
      for (const [name, server] of Object.entries(servers)) {
        lsp[name] = { command: [cli, "serve", name, root], extensions: server.extensions, ...(server.initialization && { initialization: server.initialization }) };
      }
    } catch (error) {
      console.error(`[harbor-llm.lsp] ${root}: ${error.message}`);
    }
    return upstream.setup({ ...ctx, options: { ...ctx.options, lsp: { ...ctx.options?.lsp, ...lsp } } });
  },
};
