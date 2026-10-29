#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";

const sourceRoot = new URL("./", import.meta.url).href;
NodeModule.registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith(sourceRoot) || !url.endsWith(".ts")) return nextLoad(url, context);
    const source = NodeModule.stripTypeScriptTypes(NodeFS.readFileSync(new URL(url), "utf8"));
    return { format: "module", source, shortCircuit: true };
  },
});
await import("./cli.ts");
