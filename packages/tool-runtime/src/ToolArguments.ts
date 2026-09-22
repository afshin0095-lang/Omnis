/**
 * Argument validation against a tool's declared parameter schema.
 *
 * Tool schemas are closed: an argument the tool did not declare is rejected rather than
 * ignored. That is not pedantry. A permission model reasons about declared fields, so a tool
 * that quietly accepted `{"path": "...", "adminOverride": true}` would be permission-checked
 * against a shape it did not actually run with.
 *
 * Validation produces a list of problems rather than throwing on the first one. A model that
 * called a tool wrongly gets the whole correction in one turn instead of discovering the second
 * mistake only after fixing the first.
 */

import type { JsonValue } from "@omnis/types";
import type { ToolParameterSchema, ToolParameterSpec } from "@omnis/ai-core-types";
import { invalidToolArguments } from "./errors.js";

/** One reason an argument list does not satisfy a schema. */
export interface ArgumentProblem {
  /** Dotted path to the offending argument, e.g. `"filter.tags.2"`. */
  readonly path: string;
  /** Stable problem code, so a caller can branch without parsing prose. */
  readonly code: "missing" | "unknown" | "type" | "enum" | "null";
  readonly message: string;
}

/** The argument bag a handler receives. */
export type ToolArguments = Readonly<Record<string, JsonValue>>;

/** Validates one value against one parameter declaration. */
function checkValue(
  path: string,
  spec: ToolParameterSpec,
  value: JsonValue,
  problems: ArgumentProblem[],
): void {
  if (value === null) {
    if (!spec.nullable) {
      problems.push({ path, code: "null", message: `${path} must not be null` });
    }
    return;
  }

  switch (spec.type) {
    case "string": {
      if (typeof value !== "string") {
        problems.push({ path, code: "type", message: `${path} must be a string` });
        return;
      }
      if (spec.enumValues.length > 0 && !spec.enumValues.includes(value)) {
        problems.push({
          path,
          code: "enum",
          message: `${path} must be one of ${spec.enumValues.join(", ")}`,
        });
      }
      return;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        problems.push({ path, code: "type", message: `${path} must be a finite number` });
      }
      return;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        problems.push({ path, code: "type", message: `${path} must be an integer` });
      }
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        problems.push({ path, code: "type", message: `${path} must be a boolean` });
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) {
        problems.push({ path, code: "type", message: `${path} must be an array` });
        return;
      }
      if (spec.items === null) {
        return;
      }
      value.forEach((entry, index) => {
        checkValue(
          `${path}.${String(index)}`,
          spec.items as ToolParameterSpec,
          entry as JsonValue,
          problems,
        );
      });
      return;
    }
    case "object": {
      // A declared `object` parameter is opaque: the tool interprets its contents, and this
      // validator has no schema for them. What it can check is that the value is a JSON object
      // rather than an array or a scalar dressed up as one.
      if (typeof value !== "object" || Array.isArray(value)) {
        problems.push({ path, code: "type", message: `${path} must be an object` });
      }
      return;
    }
  }
}

/**
 * Validates an argument bag against a closed parameter schema.
 *
 * Returns every problem found, in a deterministic order: declared required keys first, then the
 * remaining declared keys, then unknown keys — each group alphabetically where the schema does
 * not already impose an order.
 */
export function validateToolArguments(
  schema: ToolParameterSchema,
  args: ToolArguments,
): readonly ArgumentProblem[] {
  const problems: ArgumentProblem[] = [];
  const declared = Object.keys(schema.properties).sort();

  for (const key of schema.required) {
    const value = args[key];
    if (value === undefined) {
      problems.push({ path: key, code: "missing", message: `${key} is required` });
    }
  }

  for (const key of declared) {
    const spec = schema.properties[key];
    const value = args[key];
    if (spec === undefined || value === undefined) {
      continue;
    }
    checkValue(key, spec, value, problems);
  }

  for (const key of Object.keys(args).sort()) {
    if (!(key in schema.properties)) {
      problems.push({
        path: key,
        code: "unknown",
        message: `${key} is not a declared argument of this tool`,
      });
    }
  }

  return Object.freeze(problems);
}

/** True when an argument bag satisfies a schema. */
export function argumentsSatisfy(schema: ToolParameterSchema, args: ToolArguments): boolean {
  return validateToolArguments(schema, args).length === 0;
}

/** Validates and throws a single error listing every problem. */
export function assertToolArguments(
  name: string,
  schema: ToolParameterSchema,
  args: ToolArguments,
): void {
  const problems = validateToolArguments(schema, args);
  if (problems.length > 0) {
    throw invalidToolArguments(
      name,
      problems.map((problem) => problem.message),
    );
  }
}

/**
 * The argument *keys*, sorted, for an audit record.
 *
 * Keys and never values: arguments carry search text, credentials and personal data, and an
 * audit trail that copies them becomes the least-protected store of the most sensitive data in
 * the system.
 */
export function argumentKeys(args: ToolArguments): readonly string[] {
  return Object.freeze(Object.keys(args).sort());
}

/** Renders problems as one line, for a failure message. */
export function describeArgumentProblems(problems: readonly ArgumentProblem[]): string {
  return problems.map((problem) => problem.message).join("; ");
}
