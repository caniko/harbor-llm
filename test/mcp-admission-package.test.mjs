import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("packed MCP exports work without OpenCode or installed dependencies", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "harbor-mcp-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const [packed] = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
    { cwd: repo, encoding: "utf8" }));
  const packageRoot = path.join(root, "node_modules", "harbor-llm");
  await mkdir(packageRoot, { recursive: true });
  execFileSync("tar", ["-xzf", path.join(root, packed.filename), "--strip-components=1", "-C", packageRoot]);
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { bindMcpServersToRun, requireMcpRunBinding } from "harbor-llm/mcp-admission";
    import vectors from "harbor-llm/contracts/mcp-admission-conformance.v1.json" with { type: "json" };
    const [server] = bindMcpServersToRun({servers: [vectors.server], policy: vectors.policy,
      runId: "packed-run", executionHostId: "host-a"});
    assert.equal(requireMcpRunBinding(server.runBinding, server.runBinding).runId, "packed-run");
    console.log("isolated MCP package accepted");
  `], { cwd: root, encoding: "utf8" });
  assert.match(result, /isolated MCP package accepted/);
  for (const file of ["src/mcp-admission.d.mts", "src/mcp-admission-schema.d.mts",
    "src/mcp-admission.LICENSE", "contracts/mcp-run-binding.v1.schema.json"]) {
    assert.ok(packed.files.some((entry) => entry.path === file), `${file} must survive packing`);
  }
});
