// Starts every server in each workspace folder's Harbor LSP map
// (`harbor-llm-lsp list`), each through `harbor-llm-lsp serve` so it runs in
// the project's devshell environment. The package build substitutes @cli@.
const { execFile } = require("node:child_process");
const { window, workspace } = require("vscode");
const { LanguageClient } = require("vscode-languageclient/node");

const cli = "@cli@";
const clients = [];

exports.activate = async () => {
  const output = window.createOutputChannel("Harbor LSP");
  // ponytail: folders added after startup are not served; reload the window.
  for (const folder of workspace.workspaceFolders ?? []) {
    const root = folder.uri.fsPath;
    let servers;
    try {
      servers = JSON.parse(await new Promise((resolve, reject) =>
        execFile(cli, ["list", root], { maxBuffer: 8 << 20 }, (error, stdout, stderr) =>
          error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout))));
    } catch (error) {
      output.appendLine(`${root}: ${error.message}`);
      continue;
    }
    for (const [name, server] of Object.entries(servers)) {
      const client = new LanguageClient(`harbor-${name}`, `Harbor ${name}`,
        { command: cli, args: ["serve", name, root], options: { cwd: root } },
        {
          documentSelector: server.extensions.map((extension) => ({ scheme: "file", pattern: `${root}/**/*${extension}` })),
          workspaceFolder: folder,
          initializationOptions: server.initialization,
          outputChannel: output,
        });
      clients.push(client);
      client.start().catch((error) => output.appendLine(`${name}: ${error.message}`));
    }
  }
};

exports.deactivate = () => Promise.all(clients.map((client) => client.stop()));
