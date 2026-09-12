/**
 * Domain-neutral value primitives shared across every OMNIS boundary.
 *
 * These are the types that appear in contracts, events, logs and telemetry. Each
 * one is branded so a `Percentage` cannot be passed where a `SemVer` is expected,
 * and each one has a non-throwing `tryParse*` plus a throwing `parse*` factory so
 * validation is enforced at runtime rather than assumed from a cast.
 *
 * NOTHING in this module knows about characters, content, publishing or any
 * other OMNIS domain. Domain vocabulary belongs in `@omnis/contracts` or in the
 * owning service. That constraint is enforced by the architecture tests.
 */

import type { Branded } from "./brand.js";
import { unsafeBrand } from "./brand.js";
import { InvalidValueError } from "./errors.js";
import { parseFailure, parseSuccess, type ParseResult } from "./parse.js";

// --- Non-empty / trimmed strings -------------------------------------------

/** A string guaranteed to contain at least one non-whitespace character. */
export type NonEmptyString = Branded<string, "NonEmptyString">;

/** A {@link NonEmptyString} with no leading or trailing whitespace. */
export type TrimmedString = Branded<string, "TrimmedString">;

/** Validates and trims into a {@link TrimmedString}. */
export function tryParseTrimmedString(value: unknown): ParseResult<TrimmedString> {
  if (typeof value !== "string") {
    return parseFailure(`expected a string, received ${typeof value}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return parseFailure("string is empty or whitespace-only");
  }
  return parseSuccess(unsafeBrand<TrimmedString>(trimmed));
}

/** Throwing variant of {@link tryParseTrimmedString}. */
export function parseTrimmedString(value: unknown, label = "string"): TrimmedString {
  const result = tryParseTrimmedString(value);
  if (!result.ok) {
    throw new InvalidValueError("TrimmedString", `${label}: ${result.reason}`);
  }
  return result.value;
}

/** Validates that a string has at least one non-whitespace character. */
export function tryParseNonEmptyString(value: unknown): ParseResult<NonEmptyString> {
  if (typeof value !== "string") {
    return parseFailure(`expected a string, received ${typeof value}`);
  }
  if (value.trim().length === 0) {
    return parseFailure("string is empty or whitespace-only");
  }
  return parseSuccess(unsafeBrand<NonEmptyString>(value));
}

/** Throwing variant of {@link tryParseNonEmptyString}. */
export function parseNonEmptyString(value: unknown, label = "string"): NonEmptyString {
  const result = tryParseNonEmptyString(value);
  if (!result.ok) {
    throw new InvalidValueError("NonEmptyString", `${label}: ${result.reason}`);
  }
  return result.value;
}

// --- Time -------------------------------------------------------------------

/**
 * An RFC 3339 / ISO 8601 UTC timestamp, always ending in `Z`.
 *
 * WHY UTC-only: OMNIS ingests audience signals from every timezone and schedules
 * publishing across regional peaks. Storing anything other than UTC makes
 * ordering, retention windows and cross-platform analytics ambiguous. Local
 * presentation is a rendering concern and lives in the client layer.
 */
export type IsoDateTimeString = Branded<string, "IsoDateTimeString">;

/** A millisecond-precision {@link IsoDateTimeString}. */
export type UtcTimestamp = IsoDateTimeString;

const ISO_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/** Validates an ISO 8601 UTC timestamp. */
export function tryParseIsoDateTime(value: unknown): ParseResult<IsoDateTimeString> {
  if (typeof value !== "string") {
    return parseFailure(`expected a string, received ${typeof value}`);
  }
  const match = ISO_UTC_PATTERN.exec(value);
  if (match === null) {
    return parseFailure("expected an ISO 8601 UTC timestamp such as 2026-09-11T12:00:00.000Z");
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return parseFailure("syntactically valid but not a real calendar instant");
  }
  // `Date.parse` rolls an out-of-range day forward rather than rejecting it:
  // 2026-02-31 parses as 2026-03-03. Comparing each stated component against the
  // instant that was actually produced catches that, so a calendar date which never
  // existed cannot be branded and cannot end up ordering an audit trail.
  const instant = new Date(parsed);
  const stated = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  ];
  const actual = [
    instant.getUTCFullYear(),
    instant.getUTCMonth() + 1,
    instant.getUTCDate(),
    instant.getUTCHours(),
    instant.getUTCMinutes(),
    instant.getUTCSeconds(),
  ];
  if (!stated.every((component, index) => component === actual[index])) {
    return parseFailure("syntactically valid but not a real calendar instant");
  }
  return parseSuccess(unsafeBrand<IsoDateTimeString>(value));
}

/** Throwing variant of {@link tryParseIsoDateTime}. */
export function parseIsoDateTime(value: unknown): IsoDateTimeString {
  const result = tryParseIsoDateTime(value);
  if (!result.ok) {
    throw new InvalidValueError(
      "IsoDateTimeString",
      result.reason,
      typeof value === "string" ? value : undefined,
    );
  }
  return result.value;
}

/** The current instant as a branded UTC timestamp. */
export function nowIso(): UtcTimestamp {
  return unsafeBrand<UtcTimestamp>(new Date().toISOString());
}

/** Converts a `Date` into a branded UTC timestamp. */
export function toIso(date: Date): UtcTimestamp {
  return unsafeBrand<UtcTimestamp>(date.toISOString());
}

// --- URIs and contact -------------------------------------------------------

/** An absolute URI (https, http or any registered scheme). */
export type Uri = Branded<string, "Uri">;

/** Validates an absolute URI. */
export function tryParseUri(value: unknown): ParseResult<Uri> {
  if (typeof value !== "string") {
    return parseFailure(`expected a string, received ${typeof value}`);
  }
  if (value.length === 0 || value.length > 2048) {
    return parseFailure(`expected 1-2048 characters, received ${value.length}`);
  }
  try {
    const url = new URL(value);
    if (url.protocol.length < 2) {
      return parseFailure("missing scheme");
    }
    return parseSuccess(unsafeBrand<Uri>(url.toString()));
  } catch {
    return parseFailure("not an absolute URI");
  }
}

/** Throwing variant of {@link tryParseUri}. */
export function parseUri(value: unknown): Uri {
  const result = tryParseUri(value);
  if (!result.ok) {
    throw new InvalidValueError(
      "Uri",
      result.reason,
      typeof value === "string" ? value : undefined,
    );
  }
  return result.value;
}

/** An RFC 5322-lite email address, lowercased. */
export type EmailAddress = Branded<string, "EmailAddress">;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** Validates and normalises an email address to lowercase. */
export function tryParseEmailAddress(value: unknown): ParseResult<EmailAddress> {
  if (typeof value !== "string") {
    return parseFailure(`expected a string, received ${typeof value}`);
  }
  const normalised = value.trim().toLowerCase();
  if (normalised.length > 254 || !EMAIL_PATTERN.test(normalised)) {
    return parseFailure("not a syntactically valid email address");
  }
  return parseSuccess(unsafeBrand<EmailAddress>(normalised));
}

/** Throwing variant of {@link tryParseEmailAddress}. */
export function parseEmailAddress(value: unknown): EmailAddress {
  const result = tryParseEmailAddress(value);
  if (!result.ok) {
    // The rejected value is deliberately not echoed: an email address is personal
    // data and has no business appearing in a log line or an error payload.
    throw new InvalidValueError("EmailAddress", result.reason);
  }
  return result.value;
}

// --- Numeric vocabulary -----------------------------------------------------

/** A percentage constrained to the closed interval 0-100. */
export type Percentage = Branded<number, "Percentage">;

/** Validates a number in `[0, 100]`. */
export function tryParsePercentage(value: unknown): ParseResult<Percentage> {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return parseFailure("expected a finite number");
  }
  if (value < 0 || value > 100) {
    return parseFailure(`expected a value between 0 and 100, received ${value}`);
  }
  return parseSuccess(unsafeBrand<Percentage>(value));
}

/** Throwing variant of {@link tryParsePercentage}. */
export function parsePercentage(value: unknown): Percentage {
  const result = tryParsePercentage(value);
  if (!result.ok) {
    throw new InvalidValueError("Percentage", result.reason);
  }
  return result.value;
}

/** A normalised ratio constrained to the closed interval 0-1. */
export type Ratio = Branded<number, "Ratio">;

/** Validates a number in `[0, 1]`. */
export function tryParseRatio(value: unknown): ParseResult<Ratio> {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return parseFailure("expected a finite number");
  }
  if (value < 0 || value > 1) {
    return parseFailure(`expected a value between 0 and 1, received ${value}`);
  }
  return parseSuccess(unsafeBrand<Ratio>(value));
}

/** Throwing variant of {@link tryParseRatio}. */
export function parseRatio(value: unknown): Ratio {
  const result = tryParseRatio(value);
  if (!result.ok) {
    throw new InvalidValueError("Ratio", result.reason);
  }
  return result.value;
}

// --- Versioning -------------------------------------------------------------

/**
 * A semantic version string (`MAJOR.MINOR.PATCH` with optional pre-release).
 *
 * Used for contract versions, package versions and published content revisions.
 * See docs/03-contracts/VERSIONING.md for the compatibility rules.
 */
export type SemVer = Branded<string, "SemVer">;

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][\w-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][\w-]*))*))?$/;

/** Validates a semantic version string. */
export function tryParseSemVer(value: unknown): ParseResult<SemVer> {
  if (typeof value !== "string") {
    return parseFailure(`expected a string, received ${typeof value}`);
  }
  if (!SEMVER_PATTERN.test(value)) {
    return parseFailure("expected MAJOR.MINOR.PATCH with an optional pre-release tag");
  }
  return parseSuccess(unsafeBrand<SemVer>(value));
}

/** Throwing variant of {@link tryParseSemVer}. */
export function parseSemVer(value: unknown): SemVer {
  const result = tryParseSemVer(value);
  if (!result.ok) {
    throw new InvalidValueError(
      "SemVer",
      result.reason,
      typeof value === "string" ? value : undefined,
    );
  }
  return result.value;
}

/** Parsed components of a {@link SemVer}. */
export interface SemVerParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string | null;
}

/** Splits a validated version into its numeric components. */
export function semVerParts(version: SemVer): SemVerParts {
  const separatorIndex = version.indexOf("-");
  const core = separatorIndex === -1 ? version : version.slice(0, separatorIndex);
  const prerelease = separatorIndex === -1 ? null : version.slice(separatorIndex + 1);
  const segments = core.split(".");
  return {
    major: Number(segments[0] ?? 0),
    minor: Number(segments[1] ?? 0),
    patch: Number(segments[2] ?? 0),
    prerelease,
  };
}

/**
 * Orders two versions.
 *
 * Returns a negative number when `left` precedes `right`, a positive number when
 * it follows, and `0` when they are equal. Pre-release versions sort before the
 * corresponding release, matching the SemVer specification.
 */
export function compareSemVer(left: SemVer, right: SemVer): number {
  const a = semVerParts(left);
  const b = semVerParts(right);

  if (a.major !== b.major) {
    return a.major < b.major ? -1 : 1;
  }
  if (a.minor !== b.minor) {
    return a.minor < b.minor ? -1 : 1;
  }
  if (a.patch !== b.patch) {
    return a.patch < b.patch ? -1 : 1;
  }

  if (a.prerelease === b.prerelease) {
    return 0;
  }
  if (a.prerelease === null) {
    return 1;
  }
  if (b.prerelease === null) {
    return -1;
  }
  return a.prerelease < b.prerelease ? -1 : 1;
}

// --- Locale -----------------------------------------------------------------

/**
 * A BCP 47 language tag, e.g. `en`, `en-GB`, `fa-IR`.
 *
 * Audience Intelligence needs this because comment and DM ingestion is
 * multilingual; language detection feeds sentiment, intent and clustering.
 */
export type LanguageTag = Branded<string, "LanguageTag">;

const LANGUAGE_TAG_PATTERN = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/;

/** Validates a BCP 47 language tag. */
export function tryParseLanguageTag(value: unknown): ParseResult<LanguageTag> {
  if (typeof value !== "string") {
    return parseFailure(`expected a string, received ${typeof value}`);
  }
  if (!LANGUAGE_TAG_PATTERN.test(value)) {
    return parseFailure("expected a BCP 47 language tag such as en, en-GB or fa-IR");
  }
  return parseSuccess(unsafeBrand<LanguageTag>(value));
}

/** Throwing variant of {@link tryParseLanguageTag}. */
export function parseLanguageTag(value: unknown): LanguageTag {
  const result = tryParseLanguageTag(value);
  if (!result.ok) {
    throw new InvalidValueError(
      "LanguageTag",
      result.reason,
      typeof value === "string" ? value : undefined,
    );
  }
  return result.value;
}

// --- JSON -------------------------------------------------------------------

/** The set of values representable in JSON. */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** A JSON object (never an array or a scalar). */
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Runtime check for JSON-serializable data.
 *
 * Event payloads and log context travel through serializers, queues and
 * third-party observability backends. Rejecting `undefined`, functions, symbols,
 * `BigInt`, circular structures and lossy objects (`Date`, `Map`, class instances) at
 * the boundary prevents the class of failure where an event is accepted locally and
 * then silently dropped — or silently emptied — by a transport.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonWithin(value, new WeakSet<object>());
}

/**
 * True for objects that serialise as a JSON object rather than as something lossy.
 *
 * A `Date` serialises to a string, and a `Map`, `Set` or class instance serialises to
 * `{}`. All three pass a naive "every own value is JSON" walk while silently losing
 * data, which is precisely the failure this guard exists to prevent: the event is
 * accepted locally, published, and arrives empty.
 */
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Recursive JSON check with cycle detection.
 *
 * `active` holds the objects on the current branch only — an entry is removed once its
 * subtree has been walked — so the same object appearing in two places is fine while a
 * genuine cycle is rejected. Tracking every visited object instead would misreport a
 * diamond as a cycle, and `JSON.stringify` handles diamonds without complaint.
 */
function isJsonWithin(value: unknown, active: WeakSet<object>): boolean {
  if (value === null) {
    return true;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      // NaN and Infinity have no JSON representation and would serialise to null.
      return Number.isFinite(value);
    case "object": {
      // A cycle makes JSON.stringify throw; a transport would drop the record.
      if (active.has(value)) {
        return false;
      }
      if (Array.isArray(value)) {
        active.add(value);
        const serialisable = value.every((entry) => isJsonWithin(entry, active));
        active.delete(value);
        return serialisable;
      }
      if (!isPlainObject(value)) {
        return false;
      }
      active.add(value);
      const serialisable = Object.values(value).every((entry) => isJsonWithin(entry, active));
      active.delete(value);
      return serialisable;
    }
    default:
      // undefined, function, symbol and bigint are not JSON-serializable.
      return false;
  }
}
