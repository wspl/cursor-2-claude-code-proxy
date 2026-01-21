// Enable SDK debug logging - writes to ~/.claude/debug/sdk-*.txt
process.env.DEBUG_CLAUDE_AGENT_SDK = "true";

import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import { bearerAuth } from "hono/bearer-auth";
import { openaiRouter } from "./openai-route";
import { config } from "./config";
import { startTunnel } from "./tunnel";
import { logger } from "./logger";

const app = new Hono();

// Middleware
app.use("*", honoLogger());

// Health check (no auth required)
app.get("/", (c) => {
  return c.json({});
});

// Auth middleware for API routes
app.use("/chat/completions/*", bearerAuth({ token: config.accessToken }));
app.use("/chat/completions", bearerAuth({ token: config.accessToken }));

// Routes - OpenAI API
app.route("/chat/completions", openaiRouter);

// Start server
const port = config.port;


let tunnelUrl: string | null = null;

// Start tunnel if enabled
if (config.tunnel) {
  logger.info("Starting tunnel...");
  tunnelUrl = await startTunnel(port, config.debugTunnel);
}

logger.info(`
======================================================
  Claude Agent SDK API Wrapper
======================================================
  Local: http://localhost:${port}${tunnelUrl ? `\n  Tunnel: ${tunnelUrl}` : ""}
  Debug: ${config.debug ? "enabled" : "disabled"}

  Access Token: ${config.accessToken}

  OpenAI API:
    POST /chat/completions
======================================================
`);


export default {
  port,
  hostname: "127.0.0.1",
  fetch: app.fetch,
  idleTimeout: 0,
};
