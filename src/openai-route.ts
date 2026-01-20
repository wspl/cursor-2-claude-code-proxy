// OpenAI API compatible route handler

import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { OpenAIChatRequest, OpenAIStreamChunk } from "./types";
import { toInternal, internalToOpenai, calculateCrc32 } from "./transform";
import { processRequest, StreamEvent } from "./sdk";
import { randomUUID } from "crypto";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { config } from "./config";
import { logger } from "./logger";

async function saveRawRequest(body: unknown, sessionId: string): Promise<void> {
  const debugDir = join(process.cwd(), "debug-requests");
  await mkdir(debugDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = join(debugDir, `raw-${timestamp}-${sessionId.slice(0, 8)}.json`);
  await writeFile(filePath, JSON.stringify(body, null, 2), "utf-8");
  logger.debug(`[API] Raw request saved to: ${filePath}`);
}

export const openaiRouter = new Hono();

openaiRouter.post("/", async (c) => {
  try {
    const rawBody = await c.req.text();

    let body: OpenAIChatRequest;
    try {
      body = JSON.parse(rawBody);
    } catch (parseError) {
      logger.error("[API] JSON parse error:", parseError);
      return c.json({ error: { message: "Invalid JSON in request body", type: "invalid_request_error" } }, 400);
    }

    if (!body.model) {
      return c.json(
        { error: { message: "model is required", type: "invalid_request_error", code: "missing_required_parameter" } },
        400
      );
    }
    if (!body.messages || body.messages.length === 0) {
      return c.json(
        { error: { message: "messages is required", type: "invalid_request_error", code: "missing_required_parameter" } },
        400
      );
    }

    if (config.debug) {
      const debugSessionId = randomUUID();
      await saveRawRequest(body, debugSessionId);
    }

    let internalRequest;
    try {
      internalRequest = toInternal(body);
    } catch (e) {
      logger.error("[API] Transform error:", e);
      throw e;
    }

    let result;
    try {
      result = await processRequest(internalRequest);
    } catch (e) {
      logger.error("[API] processRequest error:", e);
      throw e;
    }

    if (body.stream && result.streamEvents) {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");
      c.header("X-Accel-Buffering", "no");

      return stream(c, async (s) => {
        const responseId = `chatcmpl-${randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);
        let isFirstChunk = true;
        let currentToolIndex = 0;
        let done = false;

        await s.write(": stream connected\n\n");

        const keepAliveInterval = setInterval(async () => {
          if (!done) {
            try {
              await s.write(": keep-alive\n\n");
            } catch {
              clearInterval(keepAliveInterval);
            }
          }
        }, 15000);

        let accumulatedThinking = "";

        try {
          for await (const event of result.streamEvents!) {
            if (event.type === "thinking_start") {
              accumulatedThinking = "";
            } else if (event.type === "thinking_delta") {
              accumulatedThinking += event.thinking.replace(/```/g, "\\`\\`\\`");
            }

            const chunk = streamEventToOpenAIChunk(event, responseId, created, body.model, isFirstChunk, currentToolIndex, accumulatedThinking);
            if (chunk) {
              await s.write(`data: ${JSON.stringify(chunk)}\n\n`);
              isFirstChunk = false;
              if (event.type === "tool_use_start") {
                currentToolIndex++;
              }
            }
            if (event.type === "message_stop") {
              await s.write("data: [DONE]\n\n");
              done = true;
            }
          }
          if (!done) {
            await s.write("data: [DONE]\n\n");
            done = true;
          }
        } catch (streamError) {
          logger.error("[API] Stream error:", streamError);
          try {
            const errorMessage = streamError instanceof Error ? streamError.message : "Stream error";
            await s.write(`data: ${JSON.stringify({ error: { message: errorMessage, type: "stream_error" } })}\n\n`);
            await s.write("data: [DONE]\n\n");
          } catch {
            // Connection already closed
          }
        } finally {
          done = true;
          clearInterval(keepAliveInterval);
        }
      });
    }

    const response = internalToOpenai(result.response, body.model);
    return c.json(response);
  } catch (error) {
    logger.error("[API] Error:", error);

    const message = error instanceof Error ? error.message : "Unknown error";
    const stack = error instanceof Error ? error.stack : undefined;
    return c.json(
      {
        error: {
          message,
          type: "api_error",
          code: "internal_error",
          stack,
        },
      },
      500
    );
  }
});

function streamEventToOpenAIChunk(
  event: StreamEvent,
  responseId: string,
  created: number,
  model: string,
  isFirst: boolean,
  toolIndex: number,
  accumulatedThinking: string = ""
): OpenAIStreamChunk | null {
  const baseChunk = {
    id: responseId,
    object: "chat.completion.chunk" as const,
    created,
    model,
  };

  if (event.type === "text_delta") {
    return {
      ...baseChunk,
      choices: [
        {
          index: 0,
          delta: {
            ...(isFirst && { role: "assistant" as const }),
            content: event.text,
          },
          finish_reason: null,
        },
      ],
    };
  }

  if (event.type === "thinking_delta") {
    const escapedThinking = event.thinking.replace(/```/g, "\\`\\`\\`");
    return {
      ...baseChunk,
      choices: [
        {
          index: 0,
          delta: {
            ...(isFirst && { role: "assistant" as const }),
            content: escapedThinking,
          },
          finish_reason: null,
        },
      ],
    };
  }

  if (event.type === "thinking_start") {
    return {
      ...baseChunk,
      choices: [
        {
          index: 0,
          delta: {
            ...(isFirst && { role: "assistant" as const }),
            content: "```thinking\n[Thinking]\n",
          },
          finish_reason: null,
        },
      ],
    };
  }

  if (event.type === "thinking_stop") {
    let sigTag = "";
    if (event.signature && accumulatedThinking) {
      const crc = calculateCrc32(accumulatedThinking);
      sigTag = `\n[SIG=${event.signature},CRC=${crc}]`;
    }
    return {
      ...baseChunk,
      choices: [
        {
          index: 0,
          delta: {
            content: `${sigTag}\n\`\`\`\n\n`,
          },
          finish_reason: null,
        },
      ],
    };
  }

  if (event.type === "tool_use_start") {
    return {
      ...baseChunk,
      choices: [
        {
          index: 0,
          delta: {
            ...(isFirst && { role: "assistant" as const }),
            tool_calls: [
              {
                index: toolIndex,
                id: event.id,
                type: "function" as const,
                function: { name: event.name, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
  }

  if (event.type === "tool_use_delta") {
    return {
      ...baseChunk,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: toolIndex - 1,
                function: { arguments: event.arguments },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
  }

  if (event.type === "message_stop") {
    const finishReason = event.stopReason === "tool_use" ? "tool_calls" : event.stopReason === "max_tokens" ? "length" : "stop";
    const promptTokens = event.usage.inputTokens + (event.usage.cacheCreationInputTokens || 0) + (event.usage.cacheReadInputTokens || 0);
    return {
      ...baseChunk,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: event.usage.outputTokens,
        total_tokens: promptTokens + event.usage.outputTokens,
      },
    };
  }

  return null;
}
