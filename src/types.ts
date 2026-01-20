// All type definitions

// ============================================================================
// Internal Types (unified format for SDK wrapper)
// ============================================================================

export interface InternalMessage {
  role: "user" | "assistant";
  content: InternalContentBlock[];
}

export type InternalContentBlock =
  | InternalTextBlock
  | InternalToolUseBlock
  | InternalToolResultBlock
  | InternalThinkingBlock
  | InternalRedactedThinkingBlock;

export interface InternalThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface InternalRedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export interface InternalTextBlock {
  type: "text";
  text: string;
}

export interface InternalToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface InternalToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export interface InternalTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface InternalRequest {
  messages: InternalMessage[];
  tools?: InternalTool[];
  model?: string;
  maxTokens?: number;
  system?: string;
  stream?: boolean;
  temperature?: number;
  maxThinkingTokens?: number;
}

export interface InternalResponse {
  id: string;
  content: InternalContentBlock[];
  model?: string;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
}

// ============================================================================
// Anthropic API Types
// ============================================================================

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

// ============================================================================
// OpenAI API Types
// ============================================================================

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: string };
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  system?: string | AnthropicSystemBlock[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  user?: string;
  tools?: OpenAITool[];
  tool_choice?: "none" | "auto" | { type: "function"; function: { name: string } };
}

export interface OpenAIChatChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChatChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  system_fingerprint?: string;
}

export interface OpenAIStreamToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface OpenAIStreamChoice {
  index: number;
  delta: {
    role?: "assistant";
    content?: string;
    tool_calls?: OpenAIStreamToolCallDelta[];
  };
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface OpenAIStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIStreamChoice[];
  system_fingerprint?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
