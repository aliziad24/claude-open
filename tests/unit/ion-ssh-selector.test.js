import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("SSH picker patch passes config.id instead of coercing the object", async () => {
  const source = await readFile(new URL("../../scripts/apply-ion-patches.mjs", import.meta.url), "utf8");
  assert.match(source, /onSelect:\(\)=>zs\(c\.id\)/);
  assert.doesNotMatch(source, /onSelect:\(\)=>zs\(c\)(?:,|\})/);
});
