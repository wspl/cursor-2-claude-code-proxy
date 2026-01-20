// SDK Wrapper - Core logic for wrapping Claude Agent SDK

import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKPartialAssistantMessage,
  McpSdkServerConfigWithInstance,
  HookInput,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  InternalRequest,
  InternalResponse,
  InternalContentBlock,
  InternalMessage,
  AnthropicTool,
} from "./types";
import { logger } from "./logger";
import { randomUUID } from "crypto";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

// ============================================================================
// MCP Server Factory
// ============================================================================

const PENDING_TOOL_MARKER = "__PENDING_TOOL_EXECUTION__";

function createToolsMcpServer(apiTools: AnthropicTool[]) {
  logger.debug(`[MCP] createToolsMcpServer called with ${apiTools?.length || 0} tools`);

  if (!apiTools || apiTools.length === 0) {
    logger.debug(`[MCP] No tools provided, returning null`);
    return null;
  }

  logger.debug(`[MCP] Tool names: ${apiTools.map(t => t.name).join(", ")}`);

  const mcpTools = apiTools.map((t) => {
    let rawShape;
    try {
      const zodSchema = z.fromJSONSchema(t.input_schema as Parameters<typeof z.fromJSONSchema>[0]);
      rawShape = zodSchema instanceof z.ZodObject
        ? (zodSchema as z.ZodObject<z.ZodRawShape>).shape
        : { _input: zodSchema };
    } catch (err) {
      logger.error(`[MCP] Failed to parse schema for ${t.name}:`, err);
      rawShape = {};
    }

    return tool(
      t.name,
      t.description || `Tool: ${t.name}`,
      rawShape,
      async (args) => {
        logger.debug(`[MCP] Tool ${t.name} called with args:`, JSON.stringify(args));
        return {
          content: [{ type: "text" as const, text: PENDING_TOOL_MARKER }],
        };
      }
    );
  });

  logger.debug(`[MCP] Creating MCP server with ${mcpTools.length} tools`);

  const server = createSdkMcpServer({
    name: "api-tools",
    version: "1.0.0",
    tools: mcpTools,
  });

  logger.debug(`[MCP] MCP server created successfully`);
  return server;
}

// ============================================================================
// SDK Wrapper
// ============================================================================

function sdkToApi(name: string): string {
  const prefix = "mcp__api-tools__";
  if (name.startsWith(prefix)) {
    return name.slice(prefix.length);
  }
  return name;
}

export const RESUME_NO_USER_MSG = "__RESUME_NO_USER_MSG__";

function hasToolResult(messages: InternalMessage[]): boolean {
  return messages.some((msg) =>
    msg.content.some((block) => block.type === "tool_result")
  );
}

async function buildJsonlHistory(
  messages: InternalMessage[],
  model?: string
): Promise<string> {
  const sessionId = randomUUID();
  const lines: string[] = [];
  let prevUuid: string | null = null;
  const cwd = process.cwd();
  const timestamp = new Date().toISOString();

  for (const msg of messages) {
    const hasToolUse = msg.content.some((b) => b.type === "tool_use");
    const hasText = msg.content.some((b) => b.type === "text");
    const hasThinking = msg.content.some((b) => b.type === "thinking" || b.type === "redacted_thinking");

    if (msg.role === "assistant" && hasToolUse && (hasText || hasThinking)) {
      const firstToolUseIndex = msg.content.findIndex((b) => b.type === "tool_use");
      let splitIndex = firstToolUseIndex;

      const prevBlockType = msg.content[firstToolUseIndex - 1]?.type;
      if (firstToolUseIndex > 0 && (prevBlockType === "thinking" || prevBlockType === "redacted_thinking")) {
        splitIndex = firstToolUseIndex - 1;
      }

      const firstPart = msg.content.slice(0, splitIndex);
      if (firstPart.length > 0) {
        const textUuid = randomUUID();
        const textMessage = {
          parentUuid: prevUuid,
          isSidechain: false,
          userType: "external",
          cwd,
          sessionId,
          version: "2.1.9",
          gitBranch: "master",
          type: "assistant",
          message: {
            model,
            id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
            type: "message",
            role: "assistant",
            content: firstPart,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 50, output_tokens: 20 },
          },
          uuid: textUuid,
          timestamp,
          requestId: `req_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        };
        lines.push(JSON.stringify(textMessage));
        prevUuid = textUuid;
      }

      const secondPart = msg.content.slice(splitIndex).map((b) => {
        if (b.type === "tool_use") {
          return { ...b, name: `mcp__api-tools__${(b as { name: string }).name}` };
        }
        return b;
      });
      const toolUuid = randomUUID();
      const toolMessage = {
        parentUuid: prevUuid,
        isSidechain: false,
        userType: "external",
        cwd,
        sessionId,
        version: "2.1.9",
        gitBranch: "master",
        type: "assistant",
        message: {
          model,
          id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
          type: "message",
          role: "assistant",
          content: secondPart,
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 50, output_tokens: 30 },
        },
        uuid: toolUuid,
        timestamp,
        requestId: `req_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      };
      lines.push(JSON.stringify(toolMessage));
      prevUuid = toolUuid;
      continue;
    }

    const uuid = randomUUID();
    let transformedContent = msg.content.map((block) => {
      if (block.type === "tool_use") {
        return { ...block, name: `mcp__api-tools__${block.name}` };
      }
      if (block.type === "tool_result") {
        return {
          type: "tool_result" as const,
          tool_use_id: block.tool_use_id,
          content: block.content,
        };
      }
      return block;
    });

    if (msg.role === "assistant") {
      const thinkingBlocks = transformedContent.filter((b) => b.type === "thinking" || b.type === "redacted_thinking");
      const otherBlocks = transformedContent.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
      transformedContent = [...thinkingBlocks, ...otherBlocks];
    }

    const stopReason = msg.role === "assistant" ? (hasToolUse ? "tool_use" : "end_turn") : null;

    const sdkMessage: Record<string, unknown> = {
      parentUuid: prevUuid,
      isSidechain: false,
      userType: "external",
      cwd,
      sessionId,
      version: "2.1.9",
      gitBranch: "master",
      type: msg.role,
      message:
        msg.role === "assistant"
          ? {
              model,
              id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
              type: "message",
              role: "assistant",
              content: transformedContent,
              stop_reason: stopReason,
              stop_sequence: null,
              usage: { input_tokens: 100, output_tokens: 50 },
            }
          : { role: "user", content: transformedContent },
      uuid,
      timestamp,
    };

    if (msg.role === "assistant") {
      sdkMessage["requestId"] = `req_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    }

    lines.push(JSON.stringify(sdkMessage));
    prevUuid = uuid;
  }

  const debugDir = join(process.cwd(), "debug-requests");
  await mkdir(debugDir, { recursive: true });
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const filePath = join(debugDir, `jsonl-${fileTimestamp}-${sessionId.slice(0, 8)}.jsonl`);
  await writeFile(filePath, lines.join("\n"), "utf-8");

  logger.debug(`[SDK] JSONL file: ${filePath}`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const parsed = JSON.parse(line);
    const content = parsed.message?.content;
    if (Array.isArray(content)) {
      const types = content.map((b: { type: string }) => b.type).join(", ");
      logger.debug(`[SDK] JSONL[${i}] type=${parsed.type} content=[${types}]`);
    } else {
      logger.debug(`[SDK] JSONL[${i}] type=${parsed.type}`);
    }
  }

  logger.debug(`[SDK] === Last 2 messages detail ===`);
  const lastTwo = lines.slice(-2);
  for (let i = 0; i < lastTwo.length; i++) {
    const line = lastTwo[i];
    if (!line) continue;
    const parsed = JSON.parse(line);
    const content = parsed.message?.content;
    const idx = lines.length - 2 + i;
    logger.debug(`[SDK] JSONL[${idx}] full content:`);
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text") {
          const preview = (block.text || "").slice(0, 200).replace(/\n/g, "\\n");
          logger.debug(`[SDK]   text: "${preview}${(block.text || "").length > 200 ? "..." : ""}"`);
        } else if (block.type === "thinking") {
          const preview = (block.thinking || "").slice(0, 100).replace(/\n/g, "\\n");
          logger.debug(`[SDK]   thinking: "${preview}..."`);
        } else if (block.type === "tool_use") {
          logger.debug(`[SDK]   tool_use: ${block.name}`);
        } else if (block.type === "tool_result") {
          const preview = typeof block.content === "string"
            ? block.content.slice(0, 100).replace(/\n/g, "\\n")
            : JSON.stringify(block.content).slice(0, 100);
          logger.debug(`[SDK]   tool_result: "${preview}..."`);
        } else {
          logger.debug(`[SDK]   ${block.type}: ${JSON.stringify(block).slice(0, 100)}`);
        }
      }
    }
  }

  return filePath;
}

export interface SdkWrapperResult {
  response: InternalResponse;
  streamEvents?: AsyncGenerator<StreamEvent, void>;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_start" }
  | { type: "thinking_delta"; thinking: string }
  | { type: "thinking_stop"; signature?: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; arguments: string }
  | { type: "tool_use_stop" }
  | {
      type: "message_stop";
      stopReason: InternalResponse["stopReason"];
      usage: InternalResponse["usage"];
    };

function logRequest(request: InternalRequest, needsResume: boolean): void {
  const { messages, tools, model, system, stream } = request;

  logger.debug("------------------------------------------------------------");
  logger.debug(`[SDK] Model: ${model || "default"}`);
  logger.debug(`[SDK] Messages: ${messages.length}, Tools: ${tools?.length || 0}, Resume: ${needsResume}, Stream: ${!!stream}`);

  if (system) {
    const preview = system.length > 100 ? system.slice(0, 100) + "..." : system;
    logger.debug(`[SDK] System: ${preview.replace(/\n/g, "\\n")}`);
  }

  const lastUserMsg = messages.filter((m) => m.role === "user").pop();
  if (lastUserMsg) {
    const textBlocks = lastUserMsg.content.filter(
      (b): b is { type: "text"; text: string } => b.type === "text"
    );
    const userText = textBlocks.map((b) => b.text).join("\n");
    if (userText) {
      const preview = userText.length > 100 ? userText.slice(0, 100) + "..." : userText;
      logger.debug(`[SDK] User: ${preview.replace(/\n/g, "\\n")}`);
    }
  }

  if (tools && tools.length > 0) {
    const names = tools.slice(0, 10).map((t) => t.name).join(", ");
    logger.debug(`[SDK] Tool defs: [${names}]`);
  }

  logger.debug(`[SDK] Input messages detail:`);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    const types = msg.content.map((b) => b.type).join(", ");
    logger.debug(`[SDK]   msg[${i}] role=${msg.role} content=[${types}]`);
  }

  const toolResultCount = messages.flatMap((m) =>
    m.content.filter((b) => b.type === "tool_result")
  ).length;
  if (toolResultCount > 0) {
    logger.debug(`[SDK] Tool results: ${toolResultCount}`);
  }
}

async function saveRequestBody(request: InternalRequest, sessionId: string): Promise<string> {
  const debugDir = join(process.cwd(), "debug-requests");
  await mkdir(debugDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = join(debugDir, `request-${timestamp}-${sessionId.slice(0, 8)}.json`);
  await writeFile(filePath, JSON.stringify(request, null, 2), "utf-8");
  logger.debug(`[SDK] Request saved to: ${filePath}`);
  return filePath;
}

export async function processRequest(request: InternalRequest): Promise<SdkWrapperResult> {
  const { messages, tools, model, system, stream, maxThinkingTokens } = request;

  const hasAssistantMessage = messages.some((m) => m.role === "assistant");
  const needsResume = hasToolResult(messages) || hasAssistantMessage;

  const debugSessionId = randomUUID();
  await saveRequestBody(request, debugSessionId);

  logRequest(request, needsResume);

  logger.debug(`[SDK] Creating MCP server: tools=${tools?.length || 0}`);
  const mcpServer = tools
    ? createToolsMcpServer(
        tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as { type: "object"; properties: Record<string, unknown> },
        }))
      )
    : null;
  logger.debug(`[SDK] MCP server created: ${mcpServer ? "yes" : "no"}`);

  let prompt: string;
  let resumePath: string | undefined;

  if (needsResume) {
    resumePath = await buildJsonlHistory(messages, model);
    prompt = RESUME_NO_USER_MSG;
  } else {
    const lastUserMsg = messages.filter((m) => m.role === "user").pop();
    if (!lastUserMsg) {
      throw new Error("No user message found");
    }
    prompt = lastUserMsg.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }

  const mcpServers: Record<string, McpSdkServerConfigWithInstance> = {};
  if (mcpServer) {
    mcpServers["api-tools"] = mcpServer;
    logger.debug(`[SDK] MCP server config:`, JSON.stringify({
      type: (mcpServer as { type?: string }).type,
      name: (mcpServer as { name?: string }).name,
      hasInstance: !!(mcpServer as { instance?: unknown }).instance,
    }));
  }

  const abortController = new AbortController();

  const postToolUseHook = async (input: HookInput): Promise<HookJSONOutput> => {
    logger.debug(`[SDK] PostToolUse hook called: event=${input.hook_event_name}`);

    if (input.hook_event_name !== "PostToolUse") {
      return { continue: true };
    }

    const toolName = (input as { tool_name: string }).tool_name;
    const toolResponse = (input as { tool_response: unknown }).tool_response;

    const responseText = typeof toolResponse === "string"
      ? toolResponse
      : (toolResponse as { content?: Array<{ type: string; text: string }> })?.content?.[0]?.text;

    logger.debug(`[SDK] PostToolUse hook: tool=${toolName}, responseText=${responseText?.slice(0, 50)}`);

    if (responseText === PENDING_TOOL_MARKER) {
      logger.debug(`[SDK] PostToolUse hook: detected PENDING_TOOL_MARKER for ${toolName}, stopping execution`);
      return {
        continue: false,
        stopReason: "Tool execution delegated to API client",
      };
    }

    logger.debug(`[SDK] PostToolUse hook: no marker found, continuing`);
    return { continue: true };
  };

  const debugHook = async (input: HookInput): Promise<HookJSONOutput> => {
    logger.debug(`[SDK] DEBUG HOOK: event=${input.hook_event_name} tool=${(input as { tool_name?: string }).tool_name}`);
    return { continue: true };
  };

  const queryOptions = {
    tools: [] as string[],
    disallowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "LS", "MultiEdit", "NotebookEdit", "TodoRead", "TodoWrite", "WebFetch", "WebSearch", "Task"],
    ...(model && { model }),
    mcpServers,
    includePartialMessages: stream ?? false,
    ...(system && { systemPrompt: system }),
    ...(resumePath && { resume: resumePath }),
    abortController,
    hooks: {
      PreToolUse: [{
        matcher: "mcp__api-tools__*",
        hooks: [async (input: HookInput): Promise<HookJSONOutput> => {
          const toolName = (input as { tool_name?: string }).tool_name;
          logger.debug(`[SDK] PRE TOOL USE: tool=${toolName} - BLOCKING to return PENDING_TOOL_MARKER`);
          return {
            continue: false,
            stopReason: PENDING_TOOL_MARKER,
          };
        }],
        timeout: 5,
      }],
      PostToolUse: [
        {
          matcher: "*",
          hooks: [debugHook],
          timeout: 5,
        },
        {
          matcher: "mcp__api-tools__*",
          hooks: [postToolUseHook],
          timeout: 5,
        }
      ],
    },
    ...(maxThinkingTokens && { maxThinkingTokens }),
  };

  logger.debug(`[SDK] Query: model=${model} mcpServers=[${Object.keys(mcpServers).join(",")}] resume=${resumePath ? "yes" : "no"} stream=${stream} tools=${queryOptions.tools.length} disallowed=${queryOptions.disallowedTools.length} hooks=PostToolUse`);

  const q = query({ prompt, options: queryOptions });

  if (stream) {
    return {
      response: null as unknown as InternalResponse,
      streamEvents: streamMessages(q, tools !== undefined, abortController),
    };
  }

  const contentBlocks: InternalContentBlock[] = [];
  let stopReason: InternalResponse["stopReason"] = null;
  let usage: InternalResponse["usage"] = { inputTokens: 0, outputTokens: 0 };
  let messageId = randomUUID();
  let hasToolUse = false;

  try {
    for await (const msg of q) {
      if (msg.type === "assistant") {
        const assistantMsg = msg as SDKAssistantMessage;

        const msgUsage = assistantMsg.message.usage;
        if (msgUsage) {
          usage = {
            inputTokens: msgUsage.input_tokens,
            outputTokens: msgUsage.output_tokens,
            cacheCreationInputTokens: msgUsage.cache_creation_input_tokens || 0,
            cacheReadInputTokens: msgUsage.cache_read_input_tokens || 0,
          };
        }

        for (const block of assistantMsg.message.content) {
          if (block.type === "tool_use") {
            contentBlocks.push({
              type: "tool_use",
              id: block.id,
              name: sdkToApi(block.name),
              input: block.input as Record<string, unknown>,
            });
            hasToolUse = true;
            stopReason = "tool_use";
          } else if (block.type === "text") {
            contentBlocks.push({ type: "text", text: block.text });
          } else if (block.type === "thinking") {
            const thinkingBlock = block as { type: "thinking"; thinking: string; signature?: string };
            contentBlocks.push({
              type: "thinking",
              thinking: thinkingBlock.thinking,
              ...(thinkingBlock.signature && { signature: thinkingBlock.signature }),
            });
          }
        }

        messageId = assistantMsg.uuid;

        if (hasToolUse && tools) {
          logger.debug("[SDK] Non-streaming: tool_use detected, aborting");
          abortController.abort();
        }
      }

      if (msg.type === "result") {
        const result = msg as SDKResultMessage;
        if ("usage" in result) {
          usage = {
            inputTokens: result.usage["input_tokens"],
            outputTokens: result.usage["output_tokens"],
            cacheCreationInputTokens: result.usage["cache_creation_input_tokens"] || 0,
            cacheReadInputTokens: result.usage["cache_read_input_tokens"] || 0,
          };
        }
        if (!stopReason) {
          stopReason = result.subtype === "success" ? "end_turn" : null;
        }
        break;
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      // Expected - tool use abort
    } else {
      logger.error("[SDK] Error:", error);
      throw error;
    }
  }

  logger.debug(`[SDK] Done: ${stopReason}`);
  const cachedIn = (usage.cacheCreationInputTokens || 0) + (usage.cacheReadInputTokens || 0);
  const totalIn = usage.inputTokens + cachedIn;
  logger.debug(`[SDK] Blocks: ${contentBlocks.length}, Tokens: ${totalIn} in (${usage.inputTokens} + ${cachedIn} cached) / ${usage.outputTokens} out`);
  const toolUses = contentBlocks.filter((b) => b.type === "tool_use");
  if (toolUses.length > 0) {
    logger.debug(`[SDK] Tool calls: [${toolUses.map((t) => (t as { name: string }).name).join(", ")}]`);
  }
  logger.debug("------------------------------------------------------------");

  return {
    response: {
      id: messageId,
      content: contentBlocks,
      model: model ?? "claude-sonnet-4-20250514",
      stopReason,
      usage,
    },
  };
}

async function* streamMessages(
  q: AsyncGenerator<SDKMessage, void>,
  hasTools: boolean,
  abortController: AbortController
): AsyncGenerator<StreamEvent, void> {
  let hasSeenToolUse = false;
  let currentToolId: string | undefined;
  let inThinkingBlock = false;
  let thinkingSignature: string | undefined;
  let usage: InternalResponse["usage"] = { inputTokens: 0, outputTokens: 0 };
  let messageStopSent = false;

  let msgCount = 0;
  let textChars = 0;
  let thinkingChars = 0;
  let toolJsonChars = 0;
  let lastLogTime = Date.now();

  const logProgress = (force = false) => {
    const now = Date.now();
    if (force || now - lastLogTime > 1000) {
      logger.debug(`[SDK] Progress: msgs=${msgCount} text=${textChars}c thinking=${thinkingChars}c toolJson=${toolJsonChars}c`);
      lastLogTime = now;
    }
  };

  logger.debug("[SDK] Stream started...");

  try {
    for await (const msg of q) {
      msgCount++;

      if (msg.type !== "stream_event") {
        logger.debug(`[SDK] msg[${msgCount}] type=${msg.type}`);
      }

      if (msg.type === "stream_event") {
        const streamMsg = msg as SDKPartialAssistantMessage;
        const event = streamMsg.event;

        if (event.type === "content_block_start") {
          const block = event.content_block;
          logger.debug(`[SDK] msg[${msgCount}] stream_event: content_block_start type=${block.type}`);
          if (block.type === "tool_use") {
            hasSeenToolUse = true;
            currentToolId = block.id;
            yield {
              type: "tool_use_start",
              id: block.id,
              name: sdkToApi(block.name),
            };
          } else if (block.type === "thinking") {
            inThinkingBlock = true;
            yield { type: "thinking_start" };
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            const text = event.delta.text;
            textChars += text.length;
            const preview = text.length > 50 ? text.slice(0, 50) + "..." : text;
            logger.debug(`[SDK] delta text: "${preview.replace(/\n/g, "\\n")}" (${text.length}c)`);
            yield { type: "text_delta", text };
          } else if (event.delta.type === "input_json_delta") {
            const json = event.delta.partial_json;
            toolJsonChars += json.length;
            const preview = json.length > 50 ? json.slice(0, 50) + "..." : json;
            logger.debug(`[SDK] delta json: "${preview}" (${json.length}c)`);
            yield { type: "tool_use_delta", arguments: json };
          } else if (event.delta.type === "thinking_delta") {
            const thinkingDelta = event.delta as { type: "thinking_delta"; thinking: string };
            const thinking = thinkingDelta.thinking;
            thinkingChars += thinking.length;
            const preview = thinking.length > 50 ? thinking.slice(0, 50) + "..." : thinking;
            logger.debug(`[SDK] delta thinking: "${preview.replace(/\n/g, "\\n")}" (${thinking.length}c)`);
            yield { type: "thinking_delta", thinking };
          } else if (event.delta.type === "signature_delta") {
            const signatureDelta = event.delta as { type: "signature_delta"; signature: string };
            logger.debug(`[SDK] delta signature: (${signatureDelta.signature.length}c)`);
            thinkingSignature = (thinkingSignature || "") + signatureDelta.signature;
          } else {
            logger.debug(`[SDK] delta unknown: ${event.delta.type}`);
          }
          logProgress();
        } else if (event.type === "content_block_stop") {
          logger.debug(`[SDK] msg[${msgCount}] stream_event: content_block_stop`);
          logProgress(true);
          if (currentToolId) {
            yield { type: "tool_use_stop" };
            currentToolId = undefined;
          }
          if (inThinkingBlock) {
            yield { type: "thinking_stop", ...(thinkingSignature && { signature: thinkingSignature }) };
            inThinkingBlock = false;
            thinkingSignature = undefined;
          }
        } else if (event.type === "message_start") {
          logger.debug(`[SDK] msg[${msgCount}] stream_event: ${event.type}`);
          const messageStartEvent = event as {
            message?: {
              usage?: {
                input_tokens: number;
                output_tokens: number;
                cache_creation_input_tokens?: number;
                cache_read_input_tokens?: number;
              };
            };
          };
          if (messageStartEvent.message?.usage) {
            usage = {
              inputTokens: messageStartEvent.message.usage.input_tokens,
              outputTokens: messageStartEvent.message.usage.output_tokens,
              cacheCreationInputTokens: messageStartEvent.message.usage.cache_creation_input_tokens || 0,
              cacheReadInputTokens: messageStartEvent.message.usage.cache_read_input_tokens || 0,
            };
            logger.debug(`[SDK] message_start usage: in=${usage.inputTokens} out=${usage.outputTokens} cacheCreate=${usage.cacheCreationInputTokens} cacheRead=${usage.cacheReadInputTokens}`);
          }
        } else if (event.type === "message_delta") {
          logger.debug(`[SDK] msg[${msgCount}] stream_event: ${event.type}`);
          const messageDeltaEvent = event as {
            delta: { stop_reason: string };
            usage: {
              output_tokens: number;
              input_tokens?: number;
              cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number;
            };
          };
          if (messageDeltaEvent.usage) {
            usage.outputTokens = messageDeltaEvent.usage.output_tokens;
            if (messageDeltaEvent.usage.input_tokens !== undefined) {
              usage.inputTokens = messageDeltaEvent.usage.input_tokens;
            }
            if (messageDeltaEvent.usage.cache_creation_input_tokens !== undefined) {
              usage.cacheCreationInputTokens = messageDeltaEvent.usage.cache_creation_input_tokens;
            }
            if (messageDeltaEvent.usage.cache_read_input_tokens !== undefined) {
              usage.cacheReadInputTokens = messageDeltaEvent.usage.cache_read_input_tokens;
            }
            logger.debug(`[SDK] message_delta usage: in=${usage.inputTokens} out=${usage.outputTokens} cacheCreate=${usage.cacheCreationInputTokens} cacheRead=${usage.cacheReadInputTokens}`);
          }
        } else if (event.type === "message_stop") {
          logger.debug(`[SDK] msg[${msgCount}] stream_event: ${event.type}`);
          if (hasSeenToolUse && hasTools && !messageStopSent) {
            logger.debug("[SDK] message_stop with tool_use - aborting NOW before tool execution");
            const stopReason = "tool_use";
            yield { type: "message_stop", stopReason, usage };
            messageStopSent = true;
            logger.debug(`[SDK] Stream done: ${stopReason}`);
            logger.debug(`[SDK] Total: ${msgCount} msgs, ${textChars}c text, ${thinkingChars}c thinking, ${toolJsonChars}c toolJson`);
            logger.debug("------------------------------------------------------------");
            abortController.abort();
            break;
          }
        }
      }

      if (msg.type === "result") {
        const result = msg as SDKResultMessage;
        logger.debug(`[SDK] msg[${msgCount}] result: subtype=${(result as { subtype?: string }).subtype}`);
        if ("usage" in result) {
          usage = {
            inputTokens: result.usage["input_tokens"],
            outputTokens: result.usage["output_tokens"],
            cacheCreationInputTokens: result.usage["cache_creation_input_tokens"] || 0,
            cacheReadInputTokens: result.usage["cache_read_input_tokens"] || 0,
          };
        }
        if (!messageStopSent) {
          const stopReason = hasSeenToolUse ? "tool_use" : "end_turn";
          yield { type: "message_stop", stopReason, usage };
          messageStopSent = true;
          logger.debug(`[SDK] Stream done: ${stopReason}`);
          const cachedIn = (usage.cacheCreationInputTokens || 0) + (usage.cacheReadInputTokens || 0);
          const totalIn = usage.inputTokens + cachedIn;
          logger.debug(`[SDK] Tokens: ${totalIn} in (${usage.inputTokens} + ${cachedIn} cached) / ${usage.outputTokens} out`);
          logger.debug(`[SDK] Total: ${msgCount} msgs, ${textChars}c text, ${thinkingChars}c thinking, ${toolJsonChars}c toolJson`);
          logger.debug("------------------------------------------------------------");
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logger.debug("[SDK] Stream AbortError caught (expected for tool_use)");
    } else {
      logger.error("[SDK] Stream error:", error);
      throw error;
    }
  }

  logger.debug(`[SDK] Stream generator exiting: msgCount=${msgCount} messageStopSent=${messageStopSent}`);

  if (!messageStopSent) {
    const stopReason = hasSeenToolUse ? "tool_use" : "end_turn";
    yield { type: "message_stop", stopReason, usage };
    logger.debug(`[SDK] Stream done (fallback): ${stopReason}`);
    logger.debug("------------------------------------------------------------");
  }
}
