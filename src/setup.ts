import { execSync } from "child_process";
import type { Config } from "./config.js";

/** Check if Claude CLI is installed. */
export function checkClaude(): { ok: boolean; version?: string; error?: string } {
  try {
    const out = execSync("claude --version", { encoding: "utf-8", timeout: 10_000 });
    return { ok: true, version: out.trim() };
  } catch {
    return { ok: false, error: "Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code" };
  }
}

/** Run setup — just prints instructions since tokens go in config.json. */
export function runSetup(config: Config): void {
  console.log(`
=== Claw Proxy Setup ===

Step 1: Generate a token for each account

  For each Claude Max account, run:

    claude setup-token

  This opens a browser, you log in, and it prints a long OAuth token.
  Copy it.

Step 2: Paste tokens into config

  Edit: ~/.claw-proxy/config.json

  Put each token in the "oauthToken" field:

    {
      "accounts": [
        { "name": "account-1", "oauthToken": "<token from account A>" },
        { "name": "account-2", "oauthToken": "<token from account B>" },
        { "name": "account-3", "oauthToken": "<token from account C>" }
      ]
    }

Step 3: Start the proxy

  npm start

  That's it. The proxy rotates between your accounts automatically.

---
Config file: ~/.claw-proxy/config.json
Bearer token: ${config.bearerToken}
(Use this as your API key in OpenClaw / other clients)
`);
}
