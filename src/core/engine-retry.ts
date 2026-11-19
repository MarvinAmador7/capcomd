// The engine's "busy, ask again in N ms". Under load the Rivet engine refuses a command it never ran, e.g. a lookup
// while a storage volume moves: `group "depot", code "overloaded", "The storage host refused the command
// (volume_transition); retry after 100 ms."`, with `metadata: { reason, retry_after_ms: 100 }`. rivetkit's client
// passes that refusal on as it is (it retries only its own lifecycle errors), so a read of a run that exists failed as
// "unavailable". Every handle of relay's client() waits the time the engine asks and sends the call again, a few times
// and a couple of seconds at most, then throws the engine's refusal as it was.

/** How long to keep asking: attempts in all (the first included), and the most time spent waiting between them. */
export interface OverloadRetry {
  attempts: number;
  maxWaitMs: number;
  sleep?: (ms: number) => Promise<unknown>;
}
export const OVERLOAD_RETRY: OverloadRetry = { attempts: 5, maxWaitMs: 2000 };

const RETRY_AFTER = /retry after (\d+) ?ms/i;

/**
 * The wait the engine asked for when `e` is its overload refusal (code "overloaded" and a retry hint, in its metadata's
 * retry_after_ms or its text), else null. Only that: nothing ran, so the call can be sent again. An actor's own failure
 * never matches (capcomd's actions cross as group "user", src/utils/actor-errors.ts), nor does a not_found.
 */
export function overloadRetryAfterMs(e: unknown): number | null {
  const x = e as { code?: unknown; metadata?: unknown; message?: unknown } | null;
  if (!x || typeof x !== "object" || x.code !== "overloaded") return null;
  const hint = (x.metadata as { retry_after_ms?: unknown } | null | undefined)?.retry_after_ms;
  if (typeof hint === "number" && Number.isFinite(hint) && hint >= 0) return hint;
  const said = typeof x.message === "string" ? RETRY_AFTER.exec(x.message) : null;
  return said ? Number(said[1]) : null;
}

/** `run`, sent again after each overload refusal as the engine asks, within `opts`; any other error is thrown at once. */
export async function retryOverloaded<T>(run: () => Promise<T>, opts: OverloadRetry = OVERLOAD_RETRY): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let waited = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      const ms = overloadRetryAfterMs(e);
      if (ms === null || attempt >= opts.attempts || waited + ms > opts.maxWaitMs) throw e;
      waited += ms;
      await sleep(ms);
    }
  }
}

/** Handle methods never sent again: connect() answers at once (its connection reconnects by itself), and a raw
 *  fetch or WebSocket may have used up its body. */
const NOT_RETRIED = new Set(["connect", "fetch", "webSocket"]);
const HANDLE_FACTORIES = ["get", "getOrCreate", "getForId"] as const;

/** A handle whose calls (actions, resolve) retry the engine's overload refusals. */
function retryingHandle<H extends object>(handle: H, opts: OverloadRetry): H {
  return new Proxy(handle, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof prop !== "string" || typeof value !== "function" || NOT_RETRIED.has(prop)) return value;
      return new Proxy(value, {
        apply(fn, self, args) {
          const first = Reflect.apply(fn, self, args);
          if (!first || typeof (first as Promise<unknown>).then !== "function") return first;
          let sent = false;
          return retryOverloaded(() => (sent ? Reflect.apply(fn, self, args) : ((sent = true), first)), opts);
        },
      });
    },
  });
}

/**
 * rivetkit's client with every actor handle it makes (get, getOrCreate, getForId) retrying the engine's overload
 * refusals: the lookup that finds or creates the actor and the action sent to it. The client's own methods and
 * create/fork (not used by capcomd) are as they were.
 */
export function retryingClient<C extends object>(client: C, opts: OverloadRetry = OVERLOAD_RETRY): C {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || prop in target || !value || typeof value !== "object") return value;
      const accessor = value as Record<string, unknown>;
      const wrapped: Record<string, unknown> = { ...accessor };
      for (const name of HANDLE_FACTORIES) {
        const make = accessor[name];
        if (typeof make === "function") wrapped[name] = (...args: unknown[]) => retryingHandle(make.apply(accessor, args), opts);
      }
      return wrapped;
    },
  });
}
