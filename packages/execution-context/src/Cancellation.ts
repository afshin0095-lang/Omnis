/**
 * Cooperative cancellation.
 *
 * Cancellation in OMNIS is *cooperative*: a token is a flag plus a listener list, and
 * the code doing the work is responsible for checking it. There is no `Thread.interrupt`
 * equivalent in JavaScript, and pretending otherwise — for example by racing a promise
 * and declaring the loser dead — leaves the abandoned work running, still spending
 * tokens and still holding its budget reservation.
 *
 * This module contains **no timers**. A deadline is a fact about time
 * (see `Deadline.ts`); deciding to cancel when that fact becomes true is the kernel's
 * job, and it does so with an explicit, testable call. Keeping timers out of the
 * context means a context can be created, inspected and asserted without anything
 * being scheduled behind the test's back.
 *
 * Listener hygiene is part of the contract: `onCancelled` returns an unsubscribe
 * function, listeners are released once cancellation fires, and a linked child token
 * detaches from its parent when it is cancelled or disposed. A context per execution
 * with a leaked listener each is a memory leak that grows exactly as fast as traffic.
 */

import { ExecutionError } from "@omnis/errors";

/** Removes a previously registered cancellation listener. Idempotent. */
export type Unsubscribe = () => void;

/** A read-only view of cancellation state. */
export interface CancellationToken {
  /** True once cancellation has been requested. */
  readonly cancelled: boolean;
  /** Why cancellation was requested, or `null` while it has not been. */
  readonly reason: string | null;
  /**
   * Registers a listener invoked once on cancellation.
   *
   * When the token is already cancelled the listener is invoked immediately and
   * synchronously, so a caller cannot register between the check and the subscription
   * and miss the event.
   */
  onCancelled(listener: (reason: string) => void): Unsubscribe;
  /** Throws {@link ExecutionCancelledError} when cancellation has been requested. */
  throwIfCancelled(): void;
}

/** The write side of a cancellation token. */
export interface CancellationSource {
  readonly token: CancellationToken;
  /** True once cancelled. */
  readonly cancelled: boolean;
  readonly reason: string | null;
  /**
   * Requests cancellation.
   *
   * Idempotent: the first reason wins and later calls are ignored, because the first
   * caller is the one whose intent actually stopped the work.
   */
  cancel(reason: string): void;
  /**
   * Releases listeners and detaches from any parent token without cancelling.
   *
   * Called when a scope finishes normally: the work is done, so nothing needs to be
   * told to stop, but the parent must not keep a reference to a finished child.
   */
  dispose(): void;
}

/** A token that is never cancelled, for executions with no cancellation owner. */
export const NEVER_CANCELLED: CancellationToken = Object.freeze({
  cancelled: false,
  reason: null,
  onCancelled: () => () => {},
  throwIfCancelled: () => {},
});

/** A token that is already cancelled, used by tests and by re-entry guards. */
export function alreadyCancelled(reason: string): CancellationToken {
  return Object.freeze({
    cancelled: true,
    reason,
    onCancelled(listener: (value: string) => void): Unsubscribe {
      // Invoked synchronously: a caller that checks `cancelled` first and subscribes
      // second must not be able to lose the notification between the two steps.
      listener(reason);
      return () => {};
    },
    throwIfCancelled(): void {
      throw cancelledError(reason);
    },
  });
}

/** Creates a cancellation source, optionally linked to a parent token. */
export function createCancellationSource(
  parent: CancellationToken | null = null,
): CancellationSource {
  let cancelled = false;
  let reason: string | null = null;
  let listeners = new Set<(value: string) => void>();
  let detachFromParent: Unsubscribe | null = null;

  const token: CancellationToken = {
    get cancelled(): boolean {
      return cancelled;
    },
    get reason(): string | null {
      return reason;
    },
    onCancelled(listener: (value: string) => void): Unsubscribe {
      if (cancelled) {
        listener(reason ?? "cancelled");
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    throwIfCancelled(): void {
      if (cancelled) {
        throw cancelledError(reason ?? "cancelled");
      }
    },
  };

  const release = (): void => {
    if (detachFromParent !== null) {
      detachFromParent();
      detachFromParent = null;
    }
    listeners = new Set();
  };

  const cancel = (cancelReason: string): void => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    reason = cancelReason;
    const toNotify = [...listeners];
    // Release before notifying: a listener that registers another listener during
    // notification must not resurrect a token that is already cancelled.
    release();
    for (const listener of toNotify) {
      listener(cancelReason);
    }
  };

  if (parent !== null && parent !== NEVER_CANCELLED) {
    if (parent.cancelled) {
      cancel(parent.reason ?? "parent cancelled");
    } else {
      detachFromParent = parent.onCancelled((parentReason) => {
        cancel(`parent cancelled: ${parentReason}`);
      });
    }
  }

  return {
    token,
    get cancelled(): boolean {
      return cancelled;
    },
    get reason(): string | null {
      return reason;
    },
    cancel,
    dispose(): void {
      release();
    },
  };
}

/**
 * Links several tokens: the result is cancelled as soon as any of them is.
 *
 * Used when an execution must stop for either its own caller's cancellation or its
 * parent scope's, without either owner knowing about the other.
 */
export function linkTokens(tokens: readonly CancellationToken[]): CancellationSource {
  const source = createCancellationSource(null);
  const detachers: Unsubscribe[] = [];

  for (const token of tokens) {
    if (token.cancelled) {
      source.cancel(token.reason ?? "linked token cancelled");
      break;
    }
    detachers.push(
      token.onCancelled((reason) => {
        source.cancel(`linked: ${reason}`);
      }),
    );
  }

  // Delegated rather than spread: `cancelled` and `reason` are live getters, and
  // spreading would snapshot them at link time and freeze the linked source in the
  // state it happened to be in when it was created.
  return {
    token: source.token,
    get cancelled(): boolean {
      return source.cancelled;
    },
    get reason(): string | null {
      return source.reason;
    },
    cancel(reason: string): void {
      source.cancel(reason);
    },
    dispose(): void {
      for (const detach of detachers) {
        detach();
      }
      detachers.length = 0;
      source.dispose();
    },
  };
}

/**
 * The error thrown by `throwIfCancelled`.
 *
 * An {@link ExecutionError} carrying the AI Core cancellation marker, so
 * `classifyError` in `@omnis/ai-core-types` reads it back as the `cancelled` failure
 * class. The platform's closed error-code set has no `cancelled` code — cancellation is
 * a *reason* an execution failed, not a new kind of failure — so the marker in metadata
 * carries the distinction instead of widening the wire contract.
 */
function cancelledError(reason: string): ExecutionError {
  return new ExecutionError(`execution cancelled: ${reason}`, {
    retryable: false,
    metadata: { reason, "omnis.cancelled": true, "omnis.failure.class": "cancelled" },
  });
}
