#!/usr/bin/env bun

// Reinstall and format Claude Code and Agent SDK in node_modules
// Note: bun i will trigger postinstall (patch), but we need to patch again after oxfmt

import { $ } from "bun";
import { existsSync, rmSync } from "fs";
import { join, dirname } from "path";

const projectDir = dirname(import.meta.dirname);
const claudeCodeDir = join(projectDir, "node_modules/@anthropic-ai/claude-code");
const claudeAgentSdkDir = join(projectDir, "node_modules/@anthropic-ai/claude-agent-sdk");

console.log("==> Step 1: Removing @anthropic-ai packages...");
if (existsSync(claudeCodeDir)) {
  rmSync(claudeCodeDir, { recursive: true });
  console.log(`    Removed: ${claudeCodeDir}`);
}
if (existsSync(claudeAgentSdkDir)) {
  rmSync(claudeAgentSdkDir, { recursive: true });
  console.log(`    Removed: ${claudeAgentSdkDir}`);
}

console.log("\n==> Step 2: Reinstalling dependencies with bun (will auto-patch via postinstall)...");
await $`bun i`.cwd(projectDir);

console.log("\n==> Step 3: Formatting with oxfmt...");
if (existsSync(claudeCodeDir)) {
  await $`bunx oxfmt ${claudeCodeDir} --write --with-node-modules`;
  console.log(`    Formatted: ${claudeCodeDir}`);
}
if (existsSync(claudeAgentSdkDir)) {
  await $`bunx oxfmt ${claudeAgentSdkDir} --write --with-node-modules`;
  console.log(`    Formatted: ${claudeAgentSdkDir}`);
}

console.log("\n==> Step 4: Re-patching (after format)...");
await import("./patch.ts");

console.log("\n==> Done!");
