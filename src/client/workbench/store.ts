export { byId, el, type ElementOptions } from "./dom.ts";

/**
 * Fine-grained dirty-key gate replacing repeated brute-force DOM rebuilds and
 * full-tree JSON serialization on every state poll.
 */
export function createRenderGate() {
  const keys = new Map<string, string>();

  function changed(slot: string, signature: string): boolean {
    if (keys.get(slot) === signature) return false;
    keys.set(slot, signature);
    return true;
  }

  function reset(prefix?: string): void {
    if (!prefix) {
      keys.clear();
      return;
    }
    for (const key of keys.keys()) {
      if (key.startsWith(prefix)) keys.delete(key);
    }
  }

  return { changed, reset };
}

/**
 * Dual-channel action coordinator isolating explicit user interactions
 * (`userBusy`) from 2-second background state polls (`pollInFlight`) so active
 * polling never swallows clicks or clears error notices.
 */
export function createActionCoordinator() {
  let userBusy = false;
  let pollInFlight = false;
  let userEpoch = 0;

  async function runUserAction(
    work: () => Promise<unknown> | void,
    onError: (error: unknown) => void,
    clearNotice: () => void,
  ): Promise<boolean> {
    if (userBusy) return false;
    userBusy = true;
    userEpoch += 1;
    clearNotice();
    try {
      await work();
      return true;
    } catch (error) {
      onError(error);
      return false;
    } finally {
      userBusy = false;
    }
  }

  async function runBackgroundPoll(work: () => Promise<unknown>): Promise<boolean> {
    if (userBusy || pollInFlight) return false;
    pollInFlight = true;
    try {
      await work();
      return true;
    } catch {
      return false;
    } finally {
      pollInFlight = false;
    }
  }

  return {
    runUserAction,
    runBackgroundPoll,
    isUserBusy: () => userBusy,
    isPollInFlight: () => pollInFlight,
    epoch: () => userEpoch,
  };
}

export function formatCharCount(count: number): string {
  if (count >= 10_000) {
    return `${(count / 10_000).toFixed(1)} 万字`;
  }
  return `${count.toLocaleString("zh-Hans")} 字`;
}
