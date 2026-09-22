/**
 * Deterministic facts about JSON values.
 *
 * Evaluation compares a produced output against an expectation and measures its shape. Both need
 * to be reproducible: the same output evaluated twice must yield the same score, on any machine,
 * in any key order. `JSON.stringify` alone does not give that — it preserves insertion order — so
 * serialization here sorts object keys, and comparison is structural rather than textual.
 *
 * Everything is iterative and capped. An output is model text, which means it can be a megabyte
 * deep in nested arrays, and an evaluator that walked it without a bound would be a denial of
 * service reachable from a prompt.
 */

import type { JsonValue } from "@omnis/types";

/** The most leaf paths one comparison walks. */
export const MAX_COMPARED_PATHS = 512;

/** The most characters one measurement renders from an output. */
export const MAX_RENDERED_CHARACTERS = 100_000;

/** The JSON kind of a value, as a stable label. */
export function kindOfJson(
  value: JsonValue | null | undefined,
): "null" | "boolean" | "number" | "string" | "array" | "object" {
  if (value === null || value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  const type = typeof value;
  if (type === "object") {
    return "object";
  }
  if (type === "string" || type === "number" || type === "boolean") {
    return type;
  }
  return "null";
}

/**
 * Serializes a value with object keys sorted, so two equal values render identically.
 *
 * Output is truncated at {@link MAX_RENDERED_CHARACTERS}: a measurement needs the shape and a
 * length, not a copy of a megabyte of model text sitting in an audit row.
 */
export function stableJson(value: JsonValue | null | undefined): string {
  const rendered = render(value);
  return rendered.length > MAX_RENDERED_CHARACTERS
    ? `${rendered.slice(0, MAX_RENDERED_CHARACTERS)}…`
    : rendered;
}

function render(value: JsonValue | null | undefined): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => render(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${render((value as Record<string, JsonValue>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The rendered length of an output, in characters.
 *
 * Strings are measured as themselves; anything else is measured as its stable serialization. A
 * number is therefore worth one or two characters, which is what a length rule should see: it is
 * grading the text a reader would receive.
 */
export function renderedLength(value: JsonValue | null | undefined): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (value === null || value === undefined) {
    return 0;
  }
  return stableJson(value).length;
}

/** Structural equality over JSON values. */
export function jsonEquals(
  left: JsonValue | null | undefined,
  right: JsonValue | null | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null || left === undefined || right === undefined) {
    return false;
  }
  const leftIsArray = Array.isArray(left);
  const rightIsArray = Array.isArray(right);
  if (leftIsArray !== rightIsArray) {
    return false;
  }
  if (leftIsArray && rightIsArray) {
    if (left.length !== right.length) {
      return false;
    }
    return left.every((entry, index) => jsonEquals(entry, right[index]));
  }
  if (typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, JsonValue>;
    const rightRecord = right as Record<string, JsonValue>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    if (
      leftKeys.length !== rightKeys.length ||
      leftKeys.some((key, index) => key !== rightKeys[index])
    ) {
      return false;
    }
    return leftKeys.every((key) => jsonEquals(leftRecord[key], rightRecord[key]));
  }
  return false;
}

/**
 * Dotted paths to every leaf of a value, capped at {@link MAX_COMPARED_PATHS}.
 *
 * Used by the subset expectation rule: "every fact the caller expected is present and equal" is
 * expressed as a ratio over these paths, which makes a partially correct answer score partially
 * instead of collapsing to zero.
 */
export function leafPaths(
  value: JsonValue | null | undefined,
  maxPaths: number = MAX_COMPARED_PATHS,
): readonly string[] {
  const paths: string[] = [];
  const stack: Array<{ readonly value: JsonValue | null | undefined; readonly path: string }> = [
    { value, path: "" },
  ];

  while (stack.length > 0 && paths.length < maxPaths) {
    const current = stack.pop();
    if (current === undefined) {
      continue;
    }
    const node = current.value;
    if (Array.isArray(node)) {
      // Pushed in reverse so the walk visits elements in order, which keeps the path list — and
      // therefore every finding that quotes it — deterministic.
      for (let index = node.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: node[index],
          path: current.path.length === 0 ? String(index) : `${current.path}.${String(index)}`,
        });
      }
      continue;
    }
    if (node !== null && typeof node === "object") {
      const record = node as Record<string, JsonValue>;
      const keys = Object.keys(record).sort();
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];
        if (key === undefined) {
          continue;
        }
        stack.push({
          value: record[key],
          path: current.path.length === 0 ? key : `${current.path}.${key}`,
        });
      }
      continue;
    }
    paths.push(current.path);
  }

  return Object.freeze(paths);
}

/** Reads a dotted path out of a value, tolerating array indices. */
export function readJsonPath(
  value: JsonValue | null | undefined,
  path: string,
): JsonValue | null | undefined {
  if (path.length === 0) {
    return value;
  }
  let current: JsonValue | null | undefined = value;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, JsonValue>)[segment];
  }
  return current;
}
