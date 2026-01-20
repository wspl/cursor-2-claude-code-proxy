// Request/Response transformation between OpenAI API format and Internal format

import type { InternalRequest, InternalMessage, InternalContentBlock, InternalTool, OpenAIChatResponse, OpenAIToolCall } from "./types";
import { crc32 } from "zlib";
import { logger } from "./logger";

// ============================================================================
// Utils
// ============================================================================

/**
 * Calculate CRC32 of a string and return as hex
 */
export function calculateCrc32(text: string): string {
  const checksum = crc32(Buffer.from(text, "utf-8"));
  return checksum.toString(16).padStart(8, "0");
}

interface ContentBlock {
  type: string;
  text?: string;
  cache_control?: unknown;
}

/**
 * Extract text content from message content (handles both string and array formats)
 */
function extractTextContent(content: string | ContentBlock[] | null | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is ContentBlock => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text!)
      .join("\n");
  }
  return "";
}

/**
 * Parse text content and extract thinking blocks, converting them to proper content blocks
 *
 * Format:
 * ```thinking
 * [Thinking]
 * content
 * [SIG=<signature>,CRC=<crc>]
 * ```
 */
function parseThinkingFromText(text: string): InternalContentBlock[] {
  const blocks: InternalContentBlock[] = [];
  const thinkingBlockRegex = /```thinking\n\[Thinking\]\n([\s\S]*?)(?:\n\[SIG=([^,\]]+),CRC=([^\]]+)\])?\n```/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = thinkingBlockRegex.exec(text)) !== null) {
    const textBefore = text.slice(lastIndex, match.index).trim();
    if (textBefore) {
      blocks.push({ type: "text", text: textBefore });
    }

    const thinkingContent = match[1]?.trim() || "";
    const signature = match[2] || undefined;
    const crc = match[3] || undefined;

    if (thinkingContent) {
      if (signature && crc) {
        const calculatedCrc = calculateCrc32(thinkingContent);
        if (calculatedCrc === crc) {
          blocks.push({ type: "thinking", thinking: thinkingContent, signature });
        } else {
          logger.debug(`[Transform] CRC mismatch: expected ${crc}, got ${calculatedCrc} - discarding thinking`);
        }
      } else {
        logger.debug(`[Transform] No valid signature - discarding thinking`);
      }
    }

    lastIndex = match.index + match[0].length;
  }

  const textAfter = text.slice(lastIndex).trim();
  if (textAfter) {
    blocks.push({ type: "text", text: textAfter });
  }

  if (blocks.length === 0 && text.trim()) {
    blocks.push({ type: "text", text: text.trim() });
  }

  return blocks;
}

/**
 * Map Cursor/custom model names to standard Anthropic model names
 */
function mapModelName(model: string): { model: string; enableThinking: boolean } {
  const modelMap: Record<string, { model: string; enableThinking: boolean }> = {
    "claude-4.5-opus-high-thinking": { model: "claude-opus-4-5-20251101", enableThinking: true },
    "claude-4.5-opus": { model: "claude-opus-4-5-20251101", enableThinking: false },
    "claude-4-opus": { model: "claude-opus-4-20250514", enableThinking: false },
    "claude-4-sonnet": { model: "claude-sonnet-4-20250514", enableThinking: false },
    "claude-3.5-sonnet": { model: "claude-sonnet-4-20250514", enableThinking: false },
    "claude-3-opus": { model: "claude-3-opus-20240229", enableThinking: false },
    "claude-3-sonnet": { model: "claude-3-sonnet-20240229", enableThinking: false },
    "claude-3-haiku": { model: "claude-3-haiku-20240307", enableThinking: false },
  };

  if (modelMap[model]) {
    return modelMap[model];
  }

  const enableThinking = model.toLowerCase().includes("thinking");
  return { model, enableThinking };
}

// ============================================================================
// Anthropic Format Types
// ============================================================================

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicContentBlock[];
}

interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock | AnthropicThinkingBlock;

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

interface AnthropicStyleRequest {
  model: string;
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string | AnthropicContentBlock[];
  }>;
  system?: string | Array<{ type: string; text?: string }>;
  tools?: AnthropicTool[];
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
}

// ============================================================================
// OpenAI Format Types
// ============================================================================

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface OpenAIStyleRequest {
  model: string;
  messages: Array<{
    role: "user" | "assistant" | "system" | "tool";
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: {
        name: string;
        arguments: string;
      };
    }>;
    tool_call_id?: string;
  }>;
  tools?: OpenAITool[];
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
}

// ============================================================================
// Format Detection
// ============================================================================

interface BaseContentBlock {
  type: string;
}

interface BaseMessage {
  role: string;
  content?: string | BaseContentBlock[] | null;
}

interface BaseTool {
  type?: string;
  input_schema?: unknown;
  function?: unknown;
}

interface BaseRequest {
  model: string;
  messages: BaseMessage[];
  system?: unknown;
  tools?: BaseTool[];
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
}

/**
 * Detect if request is in Anthropic format (as used by Cursor)
 */
function isAnthropicFormat(request: BaseRequest): boolean {
  if (request.system !== undefined) {
    return true;
  }

  if (request.tools && request.tools.length > 0) {
    const firstTool = request.tools[0];
    if (firstTool && firstTool.input_schema !== undefined) {
      return true;
    }
  }

  for (const msg of request.messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use" || block.type === "tool_result") {
          return true;
        }
      }
    }
  }

  return false;
}

// ============================================================================
// Transform: Anthropic → Internal
// ============================================================================

function anthropicToInternal(request: AnthropicStyleRequest): InternalRequest {
  const messages: InternalMessage[] = [];
  let systemPrompt: string | undefined;

  if (request.system) {
    if (typeof request.system === "string") {
      systemPrompt = request.system;
    } else if (Array.isArray(request.system)) {
      systemPrompt = request.system
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text!)
        .join("\n");
    }
  }

  for (const msg of request.messages) {
    if (msg.role === "system") {
      const textContent = extractTextContent(msg.content as string | ContentBlock[]);
      if (systemPrompt) {
        systemPrompt += "\n\n" + textContent;
      } else {
        systemPrompt = textContent;
      }
      continue;
    }

    const content: InternalContentBlock[] = [];

    if (msg.role === "user") {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") {
            content.push({ type: "text", text: block.text });
          } else if (block.type === "tool_result") {
            let resultText = "";
            if (typeof block.content === "string") {
              resultText = block.content;
            } else if (Array.isArray(block.content)) {
              resultText = block.content
                .filter((c): c is AnthropicTextBlock => c.type === "text")
                .map((c) => c.text)
                .join("\n");
            }
            content.push({
              type: "tool_result",
              tool_use_id: block.tool_use_id,
              content: resultText,
            });
          }
        }
      } else {
        const textContent = extractTextContent(msg.content as string | ContentBlock[]);
        if (textContent) {
          content.push({ type: "text", text: textContent });
        }
      }
      if (content.length > 0) {
        messages.push({ role: "user", content });
      }
    } else if (msg.role === "assistant") {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") {
            const parsedBlocks = parseThinkingFromText(block.text);
            content.push(...parsedBlocks);
          } else if (block.type === "thinking") {
            continue; // Discard native thinking blocks
          } else if (block.type === "tool_use") {
            content.push({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }
      } else {
        const textContent = extractTextContent(msg.content as string | ContentBlock[]);
        if (textContent) {
          const parsedBlocks = parseThinkingFromText(textContent);
          content.push(...parsedBlocks);
        }
      }
      if (content.length > 0) {
        messages.push({ role: "assistant", content });
      }
    }
  }

  const tools: InternalTool[] | undefined = request.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description || "",
    parameters: tool.input_schema || { type: "object", properties: {} },
  }));

  const { model: mappedModel, enableThinking } = mapModelName(request.model);

  return {
    messages,
    ...(tools && { tools }),
    model: mappedModel,
    maxTokens: request.max_tokens || 4096,
    ...(systemPrompt && { system: systemPrompt }),
    stream: request.stream ?? false,
    ...(request.temperature !== undefined && { temperature: request.temperature }),
    ...(enableThinking && { maxThinkingTokens: 10000 }),
  };
}

// ============================================================================
// Transform: OpenAI → Internal
// ============================================================================

function openaiToInternal(request: OpenAIStyleRequest): InternalRequest {
  const messages: InternalMessage[] = [];
  let systemPrompt: string | undefined;

  for (const msg of request.messages) {
    if (msg.role === "system") {
      const textContent = extractTextContent(msg.content as string | ContentBlock[]);
      if (systemPrompt) {
        systemPrompt += "\n\n" + textContent;
      } else {
        systemPrompt = textContent;
      }
      continue;
    }

    const content: InternalContentBlock[] = [];

    if (msg.role === "user") {
      const textContent = extractTextContent(msg.content as string | ContentBlock[]);
      if (textContent) {
        content.push({ type: "text", text: textContent });
      }
      if (content.length > 0) {
        messages.push({ role: "user", content });
      }
    } else if (msg.role === "assistant") {
      if (msg.tool_calls) {
        for (const toolCall of msg.tool_calls) {
          content.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function.name,
            input: JSON.parse(toolCall.function.arguments || "{}"),
          });
        }
      }

      if (msg.content) {
        const textContent = extractTextContent(msg.content as string | ContentBlock[]);
        if (textContent) {
          const parsedBlocks = parseThinkingFromText(textContent);
          content.push(...parsedBlocks);
        }
      }

      if (content.length > 0) {
        messages.push({ role: "assistant", content });
      }
    } else if (msg.role === "tool") {
      if (msg.tool_call_id) {
        const textContent = extractTextContent(msg.content as string | ContentBlock[]);
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.tool_call_id,
              content: textContent,
            },
          ],
        });
      }
    }
  }

  const tools: InternalTool[] | undefined = request.tools?.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description || "",
    parameters: tool.function.parameters || { type: "object", properties: {} },
  }));

  const { model: mappedModel, enableThinking } = mapModelName(request.model);

  return {
    messages,
    ...(tools && { tools }),
    model: mappedModel,
    maxTokens: request.max_tokens || 4096,
    ...(systemPrompt && { system: systemPrompt }),
    stream: request.stream ?? false,
    ...(request.temperature !== undefined && { temperature: request.temperature }),
    ...(enableThinking && { maxThinkingTokens: 10000 }),
  };
}

// ============================================================================
// Transform: Request → Internal (auto-detect format)
// ============================================================================

/**
 * Transform request to Internal format
 * Auto-detects format and dispatches to appropriate handler
 */
export function toInternal(request: BaseRequest): InternalRequest {
  if (isAnthropicFormat(request)) {
    return anthropicToInternal(request as unknown as AnthropicStyleRequest);
  }
  return openaiToInternal(request as unknown as OpenAIStyleRequest);
}

// ============================================================================
// Transform: Internal → OpenAI Response
// ============================================================================

import type { InternalResponse } from "./types";

/**
 * Transform Internal response to OpenAI API format
 */
export function internalToOpenai(response: InternalResponse, requestModel: string): OpenAIChatResponse {
  const textContent: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      textContent.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    } else if (block.type === "thinking") {
      const escapedThinking = block.thinking.replace(/```/g, "\\`\\`\\`");
      let sigTag = "";
      if (block.signature) {
        const crc = calculateCrc32(escapedThinking);
        sigTag = `\n[SIG=${block.signature},CRC=${crc}]`;
      }
      textContent.push(`\`\`\`thinking\n[Thinking]\n${escapedThinking}${sigTag}\n\`\`\`\n\n`);
    } else if (block.type === "redacted_thinking") {
      const escapedContent = block.data.replace(/```/g, "\\`\\`\\`");
      textContent.push(`\`\`\`thinking\n[Thinking]\n${escapedContent}\n\`\`\`\n\n`);
    }
  }

  let finishReason: "stop" | "length" | "tool_calls" | null = null;
  if (response.stopReason === "end_turn") {
    finishReason = "stop";
  } else if (response.stopReason === "max_tokens") {
    finishReason = "length";
  } else if (response.stopReason === "tool_use") {
    finishReason = "tool_calls";
  }

  return {
    id: `chatcmpl-${response.id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textContent.length > 0 ? textContent.join("") : null,
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: response.usage.inputTokens + (response.usage.cacheCreationInputTokens || 0) + (response.usage.cacheReadInputTokens || 0),
      completion_tokens: response.usage.outputTokens,
      total_tokens: response.usage.inputTokens + (response.usage.cacheCreationInputTokens || 0) + (response.usage.cacheReadInputTokens || 0) + response.usage.outputTokens,
    },
  };
}
