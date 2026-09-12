/**
 * ULID generation — the identifier substrate for all of OMNIS.
 *
 * WHY ULID
 * --------
 * Sprint 0 requirement: identifiers must be globally unique, appropriate for a
 * distributed system, serializable, and must never be coupled to a database
 * auto-increment sequence. ULID satisfies all four:
 *
 * - 128 bits: 48-bit big-endian millisecond timestamp + 80 bits of CSPRNG
 *   randomness, so IDs can be minted by any service, offline, with no
 *   coordination and no collision risk worth engineering around.
 * - Lexicographically sortable: the timestamp occupies the most significant
 *   bits, so a plain string sort of Crockford base32 ULIDs is a chronological
 *   sort. That property is what lets event streams, audit trails and character
 *   timelines be ordered without a separate sequence column.
 * - 26 characters, alphanumeric only: safe in URLs, filenames, log lines, JSON
 *   and every social platform's ID field. No escaping, no base64 padding.
 *
 * INVARIANTS
 * ----------
 * - Randomness always comes from a CSPRNG. There is deliberately no
 *   `Math.random()` fallback: a weak identifier is a security defect (guessable
 *   tenant/execution IDs enable enumeration attacks), and failing loudly is
 *   better than silently downgrading.
 * - `createMonotonicUlid` never returns a lexicographically smaller ID than one
 *   it previously returned, even if the wall clock jumps backwards.
 */

/** Crockford base32 alphabet. Excludes I, L, O and U to avoid ambiguity. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Mask selecting the low 5 bits of a byte. 256 / 32 == 8, so this is uniform. */
const CHAR_MASK = 0x1f;

/** Characters used by the 48-bit timestamp component. */
export const ULID_TIME_LENGTH = 10;

/** Characters used by the 80-bit randomness component. */
export const ULID_RANDOM_LENGTH = 16;

/** Total length of an encoded ULID. */
export const ULID_LENGTH = ULID_TIME_LENGTH + ULID_RANDOM_LENGTH;

/**
 * Injected clock and entropy source.
 *
 * Both are injectable so identifier generation is deterministic under test
 * without any module-level mocking, and so a future runtime can supply a
 * hardware RNG or a replay clock for event-sourced reconstruction.
 */
export interface EntropySource {
  /** Current wall-clock time in milliseconds since the Unix epoch. */
  now(): number;
  /** `length` cryptographically secure random bytes. */
  randomBytes(length: number): Uint8Array;
}

function systemNow(): number {
  return Date.now();
}

function systemRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const webcrypto = globalThis.crypto;
  if (webcrypto === undefined || typeof webcrypto.getRandomValues !== "function") {
    throw new Error(
      "OMNIS requires a Web Crypto implementation to generate identifiers. " +
        "globalThis.crypto.getRandomValues is unavailable in this runtime.",
    );
  }
  webcrypto.getRandomValues(bytes);
  return bytes;
}

/** Resolves a partial entropy source against the system default. */
function resolveEntropy(entropy: Partial<EntropySource> = {}): EntropySource {
  return {
    now: entropy.now ?? systemNow,
    randomBytes: entropy.randomBytes ?? systemRandomBytes,
  };
}

/** Encodes a millisecond timestamp as fixed-width big-endian base32. */
function encodeTime(time: number, length: number): string {
  if (!Number.isSafeInteger(time) || time < 0) {
    throw new RangeError(
      `Cannot encode ${time} as a ULID timestamp: expected a non-negative integer.`,
    );
  }
  let remaining = time;
  let encoded = "";
  for (let index = 0; index < length; index += 1) {
    encoded = ALPHABET.charAt(remaining % 32) + encoded;
    remaining = Math.floor(remaining / 32);
  }
  return encoded;
}

/** Encodes freshly drawn entropy as fixed-width base32. */
function encodeRandom(length: number, entropy: EntropySource): string {
  const bytes = entropy.randomBytes(length);
  let encoded = "";
  for (let index = 0; index < length; index += 1) {
    encoded += ALPHABET.charAt((bytes[index] ?? 0) & CHAR_MASK);
  }
  return encoded;
}

/**
 * Generates a single ULID.
 *
 * Use {@link createMonotonicUlid} instead when several IDs may be minted within
 * the same millisecond and their relative order matters (event streams, audit
 * logs, character timelines).
 */
export function ulid(entropy: Partial<EntropySource> = {}): string {
  const source = resolveEntropy(entropy);
  return encodeTime(source.now(), ULID_TIME_LENGTH) + encodeRandom(ULID_RANDOM_LENGTH, source);
}

/** Matches a syntactically valid ULID. */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Structural check for an encoded ULID. */
export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

/**
 * Recovers the millisecond timestamp embedded in a ULID.
 *
 * This is what makes time-ordered reads cheap: no database round-trip and no
 * secondary sort key are needed to place an event on a timeline.
 */
export function ulidTimestamp(value: string): number {
  if (!isUlid(value)) {
    throw new RangeError(`Not a valid ULID: ${value}`);
  }
  let time = 0;
  for (let index = 0; index < ULID_TIME_LENGTH; index += 1) {
    const characterValue = ALPHABET.indexOf(value.charAt(index));
    time = time * 32 + characterValue;
  }
  return time;
}

/**
 * Creates a monotonic ULID generator.
 *
 * Within a single millisecond the randomness component is incremented rather
 * than redrawn, so IDs stay strictly increasing and collision-free regardless of
 * generation rate. If the wall clock moves backwards (NTP correction, VM
 * migration, container clock skew) the generator keeps the last observed
 * timestamp and continues incrementing, which preserves ordering at the cost of
 * the timestamp being slightly ahead of the real clock. That trade-off is
 * correct for OMNIS: ordering guarantees matter more than absolute clock
 * fidelity, and every record also carries an explicit authoritative timestamp.
 *
 * The returned closure is NOT safe to share across threads/workers; create one
 * per execution context.
 */
export function createMonotonicUlid(entropy: Partial<EntropySource> = {}): () => string {
  const source = resolveEntropy(entropy);
  let lastTime = -1;
  let carry: number[] = [];

  return function monotonicUlid(): string {
    const now = source.now();

    if (now > lastTime) {
      lastTime = now;
      carry = Array.from(source.randomBytes(ULID_RANDOM_LENGTH), (byte) => byte & CHAR_MASK);
    } else {
      // Same millisecond, or the clock moved backwards: keep `lastTime` and
      // advance the randomness component so the result is strictly greater than
      // the previously returned ID.
      incrementCarry(carry);
    }

    return encodeTime(lastTime, ULID_TIME_LENGTH) + decodeCarry(carry);
  };
}

/** Big-endian increment of the base32 digit array, wrapping on overflow. */
function incrementCarry(carry: number[]): void {
  for (let index = carry.length - 1; index >= 0; index -= 1) {
    const current = carry[index] ?? 0;
    if (current < ALPHABET.length - 1) {
      carry[index] = current + 1;
      return;
    }
    carry[index] = 0;
  }
  // Overflowing 32^16 IDs inside one millisecond is not reachable in practice;
  // if it ever were, the sequence wraps and uniqueness degrades to the entropy
  // of the timestamp alone. Surfaced here so the behaviour is documented rather
  // than discovered.
}

/** Renders base32 digits back to characters. */
function decodeCarry(carry: number[]): string {
  let encoded = "";
  for (const digit of carry) {
    encoded += ALPHABET.charAt(digit & CHAR_MASK);
  }
  return encoded;
}
