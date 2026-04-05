import { execSync, spawnSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
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

/** Check if an account config dir has credentials. */
export function isAccountLoggedIn(configDir: string): boolean {
  // On Linux, credentials are in .credentials.json
  // On macOS, they're in Keychain but the config dir should still exist with state
  if (!existsSync(configDir)) return false;
  // Check for .credentials.json (Linux) or settings files that indicate login
  const credFile = `${configDir}/.credentials.json`;
  const stateFile = `${configDir}/../.claude.json`;
  return existsSync(credFile) || existsSync(`${configDir}/settings.json`);
}

/** Interactive login for a specific account. */
export function loginAccount(configDir: string, name: string): boolean {
  console.log(`\n--- Logging in ${name} ---`);
  console.log(`Config dir: ${configDir}`);

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { mode: 0o700, recursive: true });
  }

  const result = spawnSync("claude", ["auth", "login"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    stdio: "inherit",
  });

  return result.status === 0;
}

/** Run interactive setup for all accounts. */
export function runSetup(config: Config): void {
  console.log("=== Claw Proxy Setup ===\n");

  const cli = checkClaude();
  if (!cli.ok) {
    console.error(cli.error);
    process.exit(1);
  }
  console.log(`Claude CLI: ${cli.version}`);

  for (const account of config.accounts) {
    const loggedIn = isAccountLoggedIn(account.configDir);
    if (loggedIn) {
      console.log(`\n[${account.name}] Already has config at ${account.configDir}`);
      console.log("  (re-run 'claude auth login' manually to refresh if needed)");
    } else {
      console.log(`\n[${account.name}] Not logged in.`);
      loginAccount(account.configDir, account.name);
    }
  }

  console.log("\n=== Setup complete ===");
  console.log(`Config: ~/.claw-proxy/config.json`);
  console.log(`Bearer token: ${config.bearerToken}`);
  console.log(`\nStart with: claw-proxy`);
}
