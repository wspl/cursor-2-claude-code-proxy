// Cloudflare tunnel for public access (using cloudflared CLI)

import { spawn, type ChildProcess } from "child_process";
import { logger } from "./logger";

let tunnelProcess: ChildProcess | null = null;

export async function startTunnel(port: number, debug = false): Promise<string | null> {
  return new Promise((resolve) => {
    tunnelProcess = spawn("cloudflared", [
      "tunnel",
      "--url", `http://127.0.0.1:${port}`,
      "--protocol", "http2",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolved = false;
    const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

    const handleOutput = (data: Buffer) => {
      const output = data.toString();
      if (debug) {
        process.stderr.write(output);
      }
      const match = output.match(urlRegex);
      if (match && !resolved) {
        resolved = true;
        resolve(match[0]);
      }
    };

    tunnelProcess.stdout?.on("data", handleOutput);
    tunnelProcess.stderr?.on("data", handleOutput);

    tunnelProcess.on("error", (err) => {
      if (!resolved) {
        logger.error(`Tunnel failed: ${err.message}`);
        resolved = true;
        resolve(null);
      }
    });

    tunnelProcess.on("exit", (code) => {
      if (!resolved) {
        logger.error(`Tunnel exited with code ${code}`);
        resolved = true;
        resolve(null);
      }
    });

    // Timeout after 30s
    setTimeout(() => {
      if (!resolved) {
        logger.error("Tunnel timeout");
        resolved = true;
        resolve(null);
      }
    }, 30000);

    // Graceful shutdown
    const cleanup = () => {
      logger.info("Shutting down tunnel...");
      tunnelProcess?.kill();
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  });
}
