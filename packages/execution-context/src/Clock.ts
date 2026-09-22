/**
 * The AI Core clock.
 *
 * Every time-dependent decision in the AI Core — deadline expiry, duration holds,
 * latency scoring, timeout races — reads time through a {@link Clock} rather than
 * calling `Date.now()` inline. Two reasons, both about testability:
 *
 * 1. A test that sleeps to observe a deadline is slow, flaky under load, and cannot
 *    assert the *exact* boundary. A test that advances a {@link fixedClock} asserts
 *    `remainingMs` at t=999 and t=1000 and finishes in microseconds.
 * 2. Determinism is a stated architectural property of the core. "Deterministic" is
 *    meaningless if the clock is an uncontrolled ambient input.
 *
 * The clock returns epoch milliseconds as an integer. It is a *read* only: nothing
 * here schedules work, so there are no timers to leak.
 */

/** A source of the current time in epoch milliseconds. */
export type Clock = () => number;

/** The real clock. The only clock production code should use. */
export const systemClock: Clock = () => Date.now();

/**
 * A controllable clock for tests and for deterministic replay.
 *
 * Callable, so it can be used wherever a {@link Clock} is expected, and additionally
 * carrying the controls that move it.
 */
export interface ManualClock {
  (): number;
  /** The current reading, counted as a read. */
  now(): number;
  /** Advances the clock by a non-negative integer number of milliseconds. */
  advance(ms: number): void;
  /** Sets the clock to an exact reading. */
  set(epochMs: number): void;
  /**
   * The number of times the clock has been read.
   *
   * A method rather than a property so the value is read when asked for: a test uses it
   * to prove an implementation is not busy-polling the clock, which in production would
   * mean a hot loop burning CPU while waiting for a deadline.
   */
  readCount(): number;
}

/**
 * Creates a clock that only moves when told to.
 *
 * Reads are counted so a test can prove an implementation is not busy-polling the
 * clock, which in production would mean a hot loop burning CPU while waiting.
 */
export function manualClock(startMs: number = 0): ManualClock {
  if (!Number.isInteger(startMs)) {
    throw new RangeError(
      `clock start must be an integer number of milliseconds, received ${String(startMs)}`,
    );
  }
  let current = startMs;
  let reads = 0;

  const read = (): number => {
    reads += 1;
    return current;
  };

  // Object.assign over the read function: the clock *is* the read, with the controls
  // attached, so it satisfies both `Clock` and `ManualClock` without a cast.
  return Object.assign(read, {
    now: read,
    advance(ms: number): void {
      if (!Number.isInteger(ms) || ms < 0) {
        throw new RangeError(
          `clock advance must be a non-negative integer, received ${String(ms)}`,
        );
      }
      current += ms;
    },
    set(epochMs: number): void {
      if (!Number.isInteger(epochMs)) {
        throw new RangeError(`clock reading must be an integer, received ${String(epochMs)}`);
      }
      current = epochMs;
    },
    readCount: (): number => reads,
  });
}

/** A clock permanently fixed at one reading, for tests that must not depend on time at all. */
export function fixedClock(epochMs: number): Clock {
  if (!Number.isInteger(epochMs)) {
    throw new RangeError(`clock reading must be an integer, received ${String(epochMs)}`);
  }
  return () => epochMs;
}

/** Formats an epoch-millisecond reading as a UTC ISO 8601 timestamp. */
export function toIso(epochMs: number): string {
  if (!Number.isFinite(epochMs)) {
    throw new RangeError(`timestamp must be finite, received ${String(epochMs)}`);
  }
  return new Date(epochMs).toISOString();
}
