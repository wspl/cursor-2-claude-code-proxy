#!/usr/bin/env bun

/**
 * Patch claude-code to support magic resume string and fix extended thinking issues
 *
 * ============================================================================
 * BACKGROUND
 * ============================================================================
 *
 * When using claude-code CLI with --resume flag to continue a conversation,
 * it normally requires user input via stdin. This input gets converted into
 * a new user message that's appended to the conversation history.
 *
 * Problem: We want to resume a conversation (with tool_result) WITHOUT adding
 * a new user message - just continue from where we left off.
 *
 * Solution: We use a "magic string" that our wrapper sends to stdin. When
 * claude-code sees this magic string, it skips creating the user message
 * but still triggers the API query.
 *
 * ============================================================================
 * PATCH STRATEGY
 * ============================================================================
 *
 * Uses pattern matching instead of hardcoded function names to be robust
 * against version updates where minified/obfuscated names change.
 *
 * Key insight: While function names like `Xm2`, `fvA`, variable names like
 * `A`, `Q`, `B` change between versions, the following are stable:
 *   - String literals: "No response requested.", "user", "assistant"
 *   - Object property names: messages, shouldQuery, maxThinkingTokens
 *   - Code structure patterns: return statements, if conditions
 *
 * ============================================================================
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";

const projectDir = dirname(import.meta.dirname);
const CLAUDE_CODE_CLI = join(projectDir, "node_modules/@anthropic-ai/claude-code/cli.js");
const CLAUDE_AGENT_SDK_CLI = join(projectDir, "node_modules/@anthropic-ai/claude-agent-sdk/cli.js");
const CLAUDE_AGENT_SDK_SDK = join(projectDir, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs");

// Magic string - must match cli-wrapper.ts
const RESUME_NO_USER_MSG = "__RESUME_NO_USER_MSG__";

/**
 * ============================================================================
 * PATCH 1: User Message Creation Function
 * ============================================================================
 *
 * TARGET FUNCTION CHARACTERISTICS:
 * --------------------------------
 * - Purpose: Converts user input (from stdin) into message objects for the API
 * - Location: Called when user submits input in CLI interactive mode
 * - Signature: Has 9 parameters, first param is the user input string/object
 * - Key behavior: Returns object with { messages, shouldQuery, maxThinkingTokens }
 *
 * EXAMPLE (from v2.1.9, function name "Xm2"):
 * ```javascript
 * function Xm2(A, Q, B, G, Z, Y, J, X, I) {
 *   Z(!0);  // Callback to set loading state
 *   // ... processes user input A ...
 *   return { messages: [...], shouldQuery: !0, maxThinkingTokens: ... };
 * }
 * ```
 *
 * MATCHING STRATEGY:
 * 1. Find unique return pattern: `return { messages: [...], shouldQuery: !0, maxThinkingTokens:`
 * 2. Search backwards to find the function definition containing this return
 * 3. Extract parameter names dynamically from the function signature
 * 4. Insert our magic string check at the function start
 *
 * PATCH EFFECT:
 * When input equals magic string, immediately return empty messages but
 * with shouldQuery: true, which triggers API call without adding user message.
 */
function applyPatch1(content: string): string {
  const PATCH_MARKER = "PATCHED: Check for magic resume string";

  if (content.includes(PATCH_MARKER)) {
    console.log("    Patch 1 (user message): Already applied.");
    return content;
  }

  // Find the return statement pattern: return { messages: X, shouldQuery: !0, maxThinkingTokens
  // This is unique to the user message creation function
  const returnPattern = /return\s*\{\s*messages:\s*\[([^\]]*)\],\s*shouldQuery:\s*!0,\s*maxThinkingTokens:/;
  const returnMatch = content.match(returnPattern);

  if (!returnMatch) {
    console.error("ERROR: Could not find return { messages, shouldQuery } pattern.");
    process.exit(1);
  }

  // Find the function that contains this return statement
  // Look backwards from the match position to find `function XXX(`
  const returnIndex = content.indexOf(returnMatch[0]);

  // Search backwards for `function XXX(` pattern
  const beforeReturn = content.substring(0, returnIndex);
  const funcMatches = [...beforeReturn.matchAll(/function\s+(\w+)\s*\(([^)]*)\)\s*\{/g)];

  if (funcMatches.length === 0) {
    console.error("ERROR: Could not find function definition before return statement.");
    process.exit(1);
  }

  // Get the last (closest) function definition
  const lastFuncMatch = funcMatches[funcMatches.length - 1]!;
  const funcName = lastFuncMatch[1];
  const funcParams = lastFuncMatch[2]!;
  const funcStart = lastFuncMatch[0];

  // Extract parameter names
  const params = funcParams.split(",").map((p) => p.trim());
  const firstParam = params[0]; // First param is the user input
  const fifthParam = params[4]; // Fifth param is typically the callback like Z(!0)

  console.log(`    Found function: ${funcName}(${params.slice(0, 3).join(", ")}...)`);

  // Build the patch - handle both string and array content formats
  const replacePattern = `${funcStart}
  // ${PATCH_MARKER} - skip user message but continue query
  const RESUME_NO_USER_MSG = "${RESUME_NO_USER_MSG}";
  const _extractText = (input) => {
    if (typeof input === "string") return input;
    if (Array.isArray(input)) {
      const textBlock = input.find(b => b.type === "text");
      return textBlock?.text || "";
    }
    return "";
  };
  const _inputText = _extractText(${firstParam});
  if (_inputText === RESUME_NO_USER_MSG || _inputText.trim() === RESUME_NO_USER_MSG) {
    ${fifthParam}(!0);
    return { messages: [], shouldQuery: !0, maxThinkingTokens: void 0 };
  }`;

  content = content.replace(funcStart, replacePattern);
  console.log("    Patch 1 (user message): Applied.");
  return content;
}

/**
 * ============================================================================
 * PATCH 2: Remove Auto-Added Assistant Message
 * ============================================================================
 *
 * TARGET CODE CHARACTERISTICS:
 * ----------------------------
 * - Purpose: When loading a session for --print mode, if the last message is
 *   from the user, claude-code auto-adds an assistant message saying
 *   "No response requested." to make the transcript complete.
 * - Location: In the session loading/processing pipeline (function "fvA" in v2.1.9)
 * - Problem: This auto-added assistant message has NO thinking block, which
 *   breaks extended thinking mode where ALL assistant messages must start
 *   with a thinking block.
 *
 * EXAMPLE (from v2.1.9):
 * ```javascript
 * function fvA(A) {
 *   // ... process messages ...
 *   if (G[G.length - 1]?.type === "user") G.push(FU({ content: o9A }));
 *   //                                                         ^^^
 *   //                        o9A = "No response requested."
 *   return G;
 * }
 * ```
 *
 * API ERROR WITHOUT PATCH:
 * ```
 * messages.5.content.0.type: Expected `thinking` or `redacted_thinking`, but found `text`.
 * When `thinking` is enabled, a final `assistant` message must start with a thinking block.
 * ```
 *
 * MATCHING STRATEGY:
 * 1. Find the string constant "No response requested." and get its variable name
 * 2. Find the code that uses this constant: `if (X[X.length - 1]?.type === "user") X.push(...)`
 * 3. Comment out this line to prevent auto-adding the problematic assistant message
 *
 * PATCH EFFECT:
 * Session loading no longer auto-adds an assistant message when the last
 * message is from the user. This allows extended thinking mode to work
 * correctly with resumed sessions.
 */
function applyPatch2(content: string): string {
  const PATCH_MARKER = "PATCHED: Removed auto-add of assistant message";

  if (content.includes(PATCH_MARKER)) {
    console.log("    Patch 2 (no-response-requested): Already applied.");
    return content;
  }

  // First find the constant that holds "No response requested."
  // Pattern: XXX = "No response requested.",
  const constMatch = content.match(/(\w+)\s*=\s*"No response requested\."/);
  if (!constMatch) {
    console.error('ERROR: Could not find "No response requested." constant.');
    process.exit(1);
  }
  const constName = constMatch[1];
  console.log(`    Found constant: ${constName} = "No response requested."`);

  // Now find the code that uses this constant to auto-add assistant message
  // Pattern: if (X[X.length - 1]?.type === "user") X.push(YYY({ content: constName }));
  // We need flexible matching for variable names
  const usageRegex = new RegExp(
    `if\\s*\\((\\w+)\\[(\\w+)\\.length\\s*-\\s*1\\]\\?\\.type\\s*===\\s*"user"\\)\\s*(\\w+)\\.push\\((\\w+)\\(\\{\\s*content:\\s*${constName}\\s*\\}\\)\\);`
  );
  const usageMatch = content.match(usageRegex);

  // Replace with no-op instead of comment (comments break minified code on single line)
  // Need semicolon because the original if statement ended with one
  const noOpReplacement = `0/*${PATCH_MARKER}*/;`;

  if (!usageMatch) {
    // Try alternate pattern without optional chaining
    const altRegex = new RegExp(
      `if\\s*\\((\\w+)\\[(\\w+)\\.length\\s*-\\s*1\\]\\?\\.type\\s*===\\s*"user"\\)\\s*(\\w+)\\.push\\([^)]+${constName}[^)]*\\);`
    );
    const altMatch = content.match(altRegex);
    if (!altMatch) {
      console.error("ERROR: Could not find auto-add assistant message pattern.");
      process.exit(1);
    }
    content = content.replace(altMatch[0], noOpReplacement);
  } else {
    content = content.replace(usageMatch[0], noOpReplacement);
  }

  console.log("    Patch 2 (no-response-requested): Applied.");
  return content;
}

/**
 * ============================================================================
 * PATCH 3: SDK query() function - Skip user message for magic string
 * ============================================================================
 *
 * The SDK's query() function in sdk.mjs directly writes user messages to
 * the transport, bypassing the CLI's interactive mode. We need to patch
 * this to also recognize the magic resume string.
 *
 * TARGET CODE:
 * ```javascript
 * if (typeof prompt === "string") {
 *   transport.write(
 *     jsonStringify({
 *       type: "user",
 *       ...
 * ```
 *
 * PATCH EFFECT:
 * When prompt equals magic string, skip sending the user message entirely.
 */
function applyPatch3(content: string): string {
  const PATCH_MARKER = "PATCHED: SDK query skip magic resume string";

  if (content.includes(PATCH_MARKER)) {
    console.log("    Patch 3 (SDK query): Already applied.");
    return content;
  }

  // Find the pattern: if (typeof prompt === "string") { transport.write(
  const pattern = 'if (typeof prompt === "string") {\n    transport.write(';

  if (!content.includes(pattern)) {
    console.error("ERROR: Could not find SDK query pattern.");
    process.exit(1);
  }

  const replacement = `// ${PATCH_MARKER}
  const RESUME_NO_USER_MSG = "${RESUME_NO_USER_MSG}";
  if (typeof prompt === "string" && (prompt === RESUME_NO_USER_MSG || prompt.trim() === RESUME_NO_USER_MSG)) {
    // Send magic string as user message - CLI will recognize and skip adding to history
    transport.write(
      jsonStringify({
        type: "user",
        session_id: "",
        message: {
          role: "user",
          content: [{ type: "text", text: RESUME_NO_USER_MSG }],
        },
        parent_tool_use_id: null,
      }) + "\\n",
    );
  } else if (typeof prompt === "string") {
    transport.write(`;

  content = content.replace(pattern, replacement);
  console.log("    Patch 3 (SDK query): Applied.");
  return content;
}

function patchSdkFile(filePath: string, name: string): boolean {
  console.log(`==> Patching ${name}...`);

  if (!existsSync(filePath)) {
    console.log(`    Skipped: File not found: ${filePath}`);
    return false;
  }

  let content = readFileSync(filePath, "utf-8");
  content = applyPatch3(content);
  writeFileSync(filePath, content, "utf-8");

  // Verify
  const verifyContent = readFileSync(filePath, "utf-8");
  if (!verifyContent.includes("PATCHED: SDK query skip magic resume string")) {
    console.error("ERROR: Verification failed - Patch 3 not found.");
    process.exit(1);
  }

  console.log("    Patched and verified successfully!");
  return true;
}

function patchFile(filePath: string, name: string): boolean {
  console.log(`==> Patching ${name}...`);

  if (!existsSync(filePath)) {
    console.log(`    Skipped: File not found: ${filePath}`);
    return false;
  }

  let content = readFileSync(filePath, "utf-8");
  content = applyPatch1(content);
  content = applyPatch2(content);
  writeFileSync(filePath, content, "utf-8");

  // Verify
  const verifyContent = readFileSync(filePath, "utf-8");
  if (!verifyContent.includes("PATCHED: Check for magic resume string")) {
    console.error("ERROR: Verification failed - Patch 1 not found.");
    process.exit(1);
  }
  if (!verifyContent.includes("PATCHED: Removed auto-add of assistant message")) {
    console.error("ERROR: Verification failed - Patch 2 not found.");
    process.exit(1);
  }

  console.log("    Patched and verified successfully!");
  return true;
}

function main() {
  let patched = false;

  // Patch claude-code CLI if exists
  if (patchFile(CLAUDE_CODE_CLI, "claude-code cli.js")) {
    patched = true;
  }

  // Patch claude-agent-sdk CLI if exists
  if (patchFile(CLAUDE_AGENT_SDK_CLI, "claude-agent-sdk cli.js")) {
    patched = true;
  }

  // Patch claude-agent-sdk SDK (sdk.mjs) if exists
  if (patchSdkFile(CLAUDE_AGENT_SDK_SDK, "claude-agent-sdk sdk.mjs")) {
    patched = true;
  }

  if (!patched) {
    console.error("ERROR: No CLI files found to patch.");
    console.error("Run 'bun i' first to install dependencies.");
    process.exit(1);
  }
}

main();
