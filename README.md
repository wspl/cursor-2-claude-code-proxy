# Cursor to Claude Code Proxy

A proxy server that enables [Cursor IDE](https://cursor.sh/) to use your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) subscription quota when working with Claude models.

## Overview

This project bridges Cursor IDE with Claude Code CLI:

1. Exposes an **OpenAI-compatible API** endpoint that Cursor can connect to
2. Translates requests to the **Claude Agent SDK** format
3. Routes them through your locally installed **Claude Code CLI**
4. Streams responses back in OpenAI format

```
┌─────────────┐              ┌─────────────┐              ┌─────────────────┐              ┌─────────────┐
│   Cursor    │  ─────────▶  │   Cursor    │  ─────────▶  │  Proxy Server   │  ─────────▶  │ Claude Code │
│    IDE      │  ◀─────────  │   Server    │  ◀─────────  │  (this project) │  ◀─────────  │    CLI      │
└─────────────┘              └─────────────┘              └─────────────────┘              └─────────────┘
                                   │                              │
                                   │         Tunnel URL           │
                                   └──────────────────────────────┘
```

## Prerequisites

- [Bun](https://bun.sh/) runtime
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) - Cloudflare Tunnel client
- [Cursor IDE](https://cursor.sh/)

## Installation

```bash
git clone https://github.com/wspl/cursor-2-claude-code-proxy.git
cd cursor-2-claude-code-proxy
bun install
```

## Usage

### 1. Start the Proxy Server

```bash
bun start --tunnel
```

This starts the proxy with a Cloudflare tunnel and outputs:
- **Tunnel URL**: A public URL like `https://xxx.trycloudflare.com`
- **Access Token**: Auto-generated authentication token

> **Why tunnel?** Cursor routes custom API endpoint requests through its own servers, which cannot access your `localhost`. A public tunnel URL is required.

### 2. Configure Cursor

1. Open Cursor Settings → Models
2. Set OpenAI API Key:
   - **Base URL**: The tunnel URL from step 1
   - **API Key**: The access token from step 1
3. Select Claude model names (e.g., `Opus 4.5`)

## Known Issues

- Aborting a request may cause partial information loss (needs further debugging)
- After Cursor performs context summarization, you need to send the continue command twice to proceed
- Tool use with image responses may not work correctly

## License

MIT
