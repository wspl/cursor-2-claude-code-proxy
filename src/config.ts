// CLI argument parsing using Bun/Node.js built-in util.parseArgs

import { parseArgs } from "util";
import { randomBytes } from "crypto";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: {
      type: "string",
      short: "p",
      default: process.env["PORT"] ?? "7162",
    },
    debug: {
      type: "boolean",
      short: "d",
      default: false,
    },
    tunnel: {
      type: "boolean",
      short: "t",
      default: false,
    },
    "debug-tunnel": {
      type: "boolean",
      default: false,
    },
    token: {
      type: "string",
    },
  },
  strict: true,
  allowPositionals: false,
});

// Use provided token or generate random one (32 bytes = 64 hex chars)
const accessToken = values.token || randomBytes(32).toString("hex");

export const config = {
  port: parseInt(values.port as string),
  debug: values.debug as boolean,
  tunnel: values.tunnel as boolean,
  debugTunnel: values["debug-tunnel"] as boolean,
  accessToken,
};
