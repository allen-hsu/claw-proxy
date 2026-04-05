import type { AccountConfig } from "./config.js";

export interface AccountState {
  account: AccountConfig;
  cooldownUntil: number; // timestamp, 0 = available
  activeRequests: number;
}

/**
 * Round-robin account rotator with cooldown support.
 * When an account hits rate limits, it's cooled down and skipped.
 */
export class AccountRouter {
  private states: AccountState[];
  private nextIndex = 0;

  constructor(accounts: AccountConfig[]) {
    this.states = accounts.map((account) => ({
      account,
      cooldownUntil: 0,
      activeRequests: 0,
    }));
  }

  /** Pick the next available account (round-robin, skip cooled-down ones). */
  acquire(): AccountState | null {
    const now = Date.now();
    const len = this.states.length;

    for (let i = 0; i < len; i++) {
      const idx = (this.nextIndex + i) % len;
      const state = this.states[idx];
      if (state.cooldownUntil <= now) {
        this.nextIndex = (idx + 1) % len;
        state.activeRequests++;
        return state;
      }
    }

    // All accounts in cooldown — pick the one that recovers soonest
    let soonest = this.states[0];
    for (const s of this.states) {
      if (s.cooldownUntil < soonest.cooldownUntil) soonest = s;
    }
    soonest.activeRequests++;
    return soonest;
  }

  /** Release an account after request completes. */
  release(state: AccountState): void {
    state.activeRequests = Math.max(0, state.activeRequests - 1);
  }

  /** Put an account in cooldown (e.g. after rate limit). */
  cooldown(state: AccountState, durationMs: number = 60_000): void {
    state.cooldownUntil = Date.now() + durationMs;
    console.log(
      `[Router] ${state.account.name} cooled down for ${durationMs / 1000}s`
    );
  }

  status(): Array<{ name: string; active: number; cooldown: boolean }> {
    const now = Date.now();
    return this.states.map((s) => ({
      name: s.account.name,
      active: s.activeRequests,
      cooldown: s.cooldownUntil > now,
    }));
  }
}
