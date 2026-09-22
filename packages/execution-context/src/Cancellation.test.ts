import { describe, expect, it } from "vitest";
import { classifyError } from "@omnis/ai-core-types";
import {
  alreadyCancelled,
  createCancellationSource,
  linkTokens,
  NEVER_CANCELLED,
  type CancellationToken,
} from "./Cancellation.js";

describe("a cancellation source", () => {
  it("starts uncancelled with no reason", () => {
    const source = createCancellationSource();
    expect(source.cancelled).toBe(false);
    expect(source.reason).toBeNull();
    expect(source.token.cancelled).toBe(false);
  });

  it("cancels once and keeps the first reason", () => {
    const source = createCancellationSource();
    source.cancel("operator stopped it");
    source.cancel("a second, later reason");
    expect(source.cancelled).toBe(true);
    expect(source.token.reason).toBe("operator stopped it");
  });

  it("notifies every listener with the reason", () => {
    const source = createCancellationSource();
    const seen: string[] = [];
    source.token.onCancelled((reason) => seen.push(`a:${reason}`));
    source.token.onCancelled((reason) => seen.push(`b:${reason}`));
    source.cancel("budget exhausted");
    expect(seen).toEqual(["a:budget exhausted", "b:budget exhausted"]);
  });

  it("notifies a listener registered after cancellation immediately", () => {
    // Without this, a caller that checks `cancelled` and then subscribes could lose the
    // notification between the two steps and wait forever.
    const source = createCancellationSource();
    source.cancel("already done");
    let seen: string | null = null;
    source.token.onCancelled((reason) => {
      seen = reason;
    });
    expect(seen).toBe("already done");
  });

  it("stops notifying a listener that unsubscribed", () => {
    const source = createCancellationSource();
    let calls = 0;
    const unsubscribe = source.token.onCancelled(() => {
      calls += 1;
    });
    unsubscribe();
    unsubscribe();
    source.cancel("stopped");
    expect(calls).toBe(0);
  });

  it("releases listeners when it cancels, so a late subscriber cannot resurrect them", () => {
    const source = createCancellationSource();
    let late = 0;
    source.token.onCancelled(() => {
      source.token.onCancelled(() => {
        late += 1;
      });
    });
    source.cancel("stopped");
    expect(late).toBe(1);
  });

  it("throws a typed error that classifies as cancelled", () => {
    const source = createCancellationSource();
    expect(() => source.token.throwIfCancelled()).not.toThrow();
    source.cancel("operator");
    let caught: unknown;
    try {
      source.token.throwIfCancelled();
    } catch (error) {
      caught = error;
    }
    expect(classifyError(caught)).toBe("cancelled");
  });
});

describe("cancellation propagation", () => {
  it("cancels a child when its parent is cancelled", () => {
    const parent = createCancellationSource();
    const child = createCancellationSource(parent.token);
    expect(child.cancelled).toBe(false);
    parent.cancel("root cancelled");
    expect(child.cancelled).toBe(true);
    expect(child.reason).toContain("root cancelled");
  });

  it("propagates through a chain of three", () => {
    const root = createCancellationSource();
    const middle = createCancellationSource(root.token);
    const leaf = createCancellationSource(middle.token);
    root.cancel("stop everything");
    expect(middle.cancelled).toBe(true);
    expect(leaf.cancelled).toBe(true);
  });

  it("does not cancel a parent when a child is cancelled", () => {
    const parent = createCancellationSource();
    const child = createCancellationSource(parent.token);
    child.cancel("only this branch");
    expect(child.cancelled).toBe(true);
    expect(parent.cancelled).toBe(false);
  });

  it("starts cancelled when the parent already was", () => {
    const parent = createCancellationSource();
    parent.cancel("too late");
    const child = createCancellationSource(parent.token);
    expect(child.cancelled).toBe(true);
    expect(child.reason).toContain("too late");
  });

  it("detaches from the parent on dispose, so a finished child is not held", () => {
    const parent = createCancellationSource();
    const child = createCancellationSource(parent.token);
    child.dispose();
    parent.cancel("root cancelled");
    // Disposing without cancelling leaves the child uncancelled but unreachable from the
    // parent's listener list — which is the point: the parent must not accumulate
    // references to completed work.
    expect(child.cancelled).toBe(false);
  });
});

describe("linkTokens", () => {
  it("cancels when any linked token cancels", () => {
    const first = createCancellationSource();
    const second = createCancellationSource();
    const linked = linkTokens([first.token, second.token]);
    expect(linked.cancelled).toBe(false);
    second.cancel("second owner stopped");
    expect(linked.cancelled).toBe(true);
    expect(linked.reason).toContain("second owner stopped");
    expect(linked.token.cancelled).toBe(true);
  });

  it("starts cancelled when a linked token already was", () => {
    const done = alreadyCancelled("finished earlier");
    const linked = linkTokens([done, NEVER_CANCELLED]);
    expect(linked.cancelled).toBe(true);
    expect(linked.reason).toBe("finished earlier");
  });

  it("reports live state after linking rather than a snapshot", () => {
    const owner = createCancellationSource();
    const linked = linkTokens([owner.token]);
    expect(linked.cancelled).toBe(false);
    linked.cancel("self cancelled");
    expect(linked.cancelled).toBe(true);
    expect(linked.reason).toBe("self cancelled");
  });

  it("stops listening to linked tokens after dispose", () => {
    const owner = createCancellationSource();
    const linked = linkTokens([owner.token]);
    linked.dispose();
    owner.cancel("late");
    expect(linked.cancelled).toBe(false);
  });
});

describe("standalone tokens", () => {
  it("provides a token that never cancels", () => {
    expect(NEVER_CANCELLED.cancelled).toBe(false);
    expect(() => NEVER_CANCELLED.throwIfCancelled()).not.toThrow();
    const unsubscribe = NEVER_CANCELLED.onCancelled(() => {});
    expect(typeof unsubscribe).toBe("function");
  });

  it("provides an already-cancelled token that notifies synchronously", () => {
    const token: CancellationToken = alreadyCancelled("replayed");
    expect(token.cancelled).toBe(true);
    expect(token.reason).toBe("replayed");
    let seen: string | null = null;
    token.onCancelled((reason) => {
      seen = reason;
    });
    expect(seen).toBe("replayed");
    expect(() => token.throwIfCancelled()).toThrow(/replayed/);
  });
});
