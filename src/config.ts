import { randomBytes } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import os from "os";

export interface AccountConfig {
  name: string;
  configDir: string;
}

export interface Config {
  port: number;
  host: string;
  bearerToken: string;
  accounts: AccountConfig[];
  timeoutMs: number;
  defaultModel: string;
}

const CONFIG_DIR = path.join(os.homedir(), ".claw-proxy");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
  }
}

export function loadConfig(): Config {
  ensureConfigDir();

  if (existsSync(CONFIG_FILE)) {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    return {
      port: raw.port ?? 3456,
      host: raw.host ?? "127.0.0.1",
      bearerToken: raw.bearerToken ?? "",
      accounts: raw.accounts ?? [],
      timeoutMs: raw.timeoutMs ?? 900_000,
      defaultModel: raw.defaultModel ?? "sonnet",
    };
  }

  // Generate default config with random bearer token
  const config: Config = {
    port: 3456,
    host: "127.0.0.1",
    bearerToken: randomBytes(24).toString("hex"),
    accounts: [
      { name: "account-1", configDir: path.join(os.homedir(), ".claude-account-1") },
      { name: "account-2", configDir: path.join(os.homedir(), ".claude-account-2") },
      { name: "account-3", configDir: path.join(os.homedir(), ".claude-account-3") },
    ],
    timeoutMs: 900_000,
    defaultModel: "sonnet",
  };

  saveConfig(config);
  return config;
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}
