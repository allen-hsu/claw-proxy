#!/usr/bin/env node

import { loadConfig, getConfigPath } from "./config.js";
import { createServer } from "./server.js";
import { checkClaude, runSetup } from "./setup.js";

const config = loadConfig();

// --setup mode
if (process.argv.includes("--setup")) {
  runSetup(config);
  process.exit(0);
}

// Verify Claude CLI
const cli = checkClaude();
if (!cli.ok) {
  console.error(cli.error);
  process.exit(1);
}

// Fail fast if no accounts configured
if (!config.accounts.length) {
  console.error("Error: No accounts configured in", getConfigPath());
  console.error("Run with --setup for instructions.");
  process.exit(1);
}

// Validate each account has credentials
for (const acct of config.accounts) {
  const token = acct.oauthToken ?? "";
  const isPlaceholder = token.startsWith("PASTE_") || token === "";
  if (isPlaceholder && !acct.configDir) {
    console.error(`Error: Account "${acct.name}" is not configured. Run 'claude setup-token' and paste the token into ${getConfigPath()}`);
    process.exit(1);
  }
}

// Start server
const app = createServer(config);

const server = app.listen(config.port, config.host, () => {
  const endpoint = `http://${config.host}:${config.port}/v1`;
  const accounts = config.accounts.map((a) => a.name).join(", ");
  const token = config.bearerToken.slice(0, 16) + "...";
  console.log(`
  claw-proxy running

  Endpoint:  ${endpoint}
  Accounts:  ${accounts}
  Bearer:    ${token}
  Config:    ${getConfigPath()}

  Test: curl ${endpoint}/models -H "Authorization: Bearer ${config.bearerToken.slice(0, 8)}..."
  `);
});

// Graceful shutdown
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\n[${sig}] Shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => {
      console.error("Forced shutdown after timeout");
      process.exit(1);
    }, 5000);
  });
}
