import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("public declarations preserve schema literals and replace stale binding types", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  execFileSync(fileURLToPath(new URL("../node_modules/.bin/tsc", import.meta.url)), [
    "--noEmit", "--strict", "--module", "NodeNext", "--target", "ES2023", "test/mcp-admission.types.mts",
  ], { cwd: root, stdio: "pipe" });
});
