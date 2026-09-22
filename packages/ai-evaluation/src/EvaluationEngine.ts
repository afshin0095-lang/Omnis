/**
 * The evaluation engine: named rule sets, and one call that grades an execution.
 *
 * Rule sets are versioned and replaced rather than mutated in place, for the same reason the
 * policy engine does it: a result records which rules produced it, and a set that changed
 * underneath a stored result would make that record unreadable. `version` increments on every
 * edit and the stored object is frozen, so a result can be re-explained later against the exact
 * rule text that produced it.
 *
 * The engine holds no execution state and calls nothing. It is given measured facts and returns a
 * verdict, which is why it can run inside a request path, inside a test, and inside a batch job
 * over last month's audit rows without behaving differently in any of them.
 */

import { createEvaluationId } from "@omnis/types";
import { MAX_EVALUATION_RULES } from "@omnis/ai-core-types";
import type { EvaluationInput, EvaluationResult, EvaluationRuleSpec } from "@omnis/ai-core-types";
import { sanitizeMetadata, systemClock, toIso } from "@omnis/execution-context";
import type { Clock, ExecutionContext } from "@omnis/execution-context";
import { validate } from "@omnis/validation";
import {
  duplicateRuleId,
  duplicateRuleSet,
  invalidRuleSet,
  ruleNotFound,
  ruleSetCapacityExceeded,
  ruleSetNotFound,
} from "./errors.js";
import { DEFAULT_EVALUATION_RULES, requireRuleImplementation } from "./EvaluationRules.js";
import { assertEvaluationInput } from "./input.js";
import { evaluateRules } from "./scoring.js";
import {
  evaluationRuleSetInputSchema,
  evaluationRuleSetSchema,
  evaluationRuleSpecSchema,
} from "./evaluationValidation.js";
import type { EvaluationRuleSet, EvaluationRuleSetInput } from "./ruleSets.js";
import { createRuleSet, ruleSetName } from "./ruleSets.js";

/** The rule set an evaluation uses when the caller does not name one. */
export const DEFAULT_EVALUATION_RULE_SET_NAME = "default";

/** Options for one evaluation. */
export interface EvaluationOptions {
  /** Rule set name. Defaults to {@link DEFAULT_EVALUATION_RULE_SET_NAME}. */
  readonly ruleSet?: string | null;
  /** Restricts the run to these rule identifiers. Unknown identifiers are an error. */
  readonly rules?: readonly string[] | null;
  /** Supplies correlation identity for the result's metadata. Never scored. */
  readonly context?: ExecutionContext | null;
  /** Extra JSON-safe tags for the result's metadata. Redacted before storage. */
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

/** The engine's public surface. */
export interface EvaluationEngine {
  /** Number of registered rule sets. */
  readonly size: number;

  registerRuleSet(input: EvaluationRuleSetInput): EvaluationRuleSet;
  getRuleSet(name: string): EvaluationRuleSet | null;
  requireRuleSet(name: string): EvaluationRuleSet;
  hasRuleSet(name: string): boolean;
  removeRuleSet(name: string): boolean;
  listRuleSets(): readonly EvaluationRuleSet[];

  /** Replaces a set's rules, incrementing its version. */
  setRules(name: string, rules: readonly EvaluationRuleSpec[]): EvaluationRuleSet;
  /** Appends or replaces one rule, incrementing the version. */
  upsertRule(name: string, rule: EvaluationRuleSpec): EvaluationRuleSet;
  /** Removes one rule, incrementing the version. */
  removeRule(name: string, ruleId: string): EvaluationRuleSet;

  /** Grades one execution. */
  evaluate(input: EvaluationInput, options?: EvaluationOptions): EvaluationResult;
}

/** Engine configuration. */
export interface EvaluationEngineOptions {
  readonly clock?: Clock;
  /** Upper bound on stored rule sets. */
  readonly maxRuleSets?: number;
  /** Whether to pre-register the shipped default rule set. Defaults to `true`. */
  readonly registerDefaults?: boolean;
}

/** The in-memory engine. */
export class InMemoryEvaluationEngine implements EvaluationEngine {
  readonly #ruleSets = new Map<string, EvaluationRuleSet>();
  readonly #clock: Clock;
  readonly #maxRuleSets: number;

  constructor(options: EvaluationEngineOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    const maxRuleSets = options.maxRuleSets ?? 64;
    if (!Number.isInteger(maxRuleSets) || maxRuleSets < 1) {
      throw new RangeError(
        `maxRuleSets must be a positive integer, received ${String(maxRuleSets)}`,
      );
    }
    this.#maxRuleSets = maxRuleSets;
    if (options.registerDefaults ?? true) {
      this.registerRuleSet({
        name: DEFAULT_EVALUATION_RULE_SET_NAME,
        description: "The shipped deterministic rule set: one rule per measured dimension.",
        rules: DEFAULT_EVALUATION_RULES,
      });
    }
  }

  get size(): number {
    return this.#ruleSets.size;
  }

  registerRuleSet(input: EvaluationRuleSetInput): EvaluationRuleSet {
    const parsed = validate(evaluationRuleSetInputSchema, input, "EvaluationRuleSet");
    const name = ruleSetName(parsed.name);
    if (this.#ruleSets.has(name)) {
      throw duplicateRuleSet(name);
    }
    if (this.#ruleSets.size >= this.#maxRuleSets) {
      throw ruleSetCapacityExceeded(this.#maxRuleSets);
    }
    const rules = validateRules(parsed.rules ?? []);
    const now = parsed.createdAt ?? toIso(this.#clock());
    const set = createRuleSet({
      name,
      description: parsed.description ?? "",
      version: parsed.version ?? 1,
      rules,
      createdAt: now,
      updatedAt: now,
    });
    validate(evaluationRuleSetSchema, set, "EvaluationRuleSet");
    this.#ruleSets.set(name, set);
    return set;
  }

  getRuleSet(name: string): EvaluationRuleSet | null {
    return this.#ruleSets.get(ruleSetName(name)) ?? null;
  }

  requireRuleSet(name: string): EvaluationRuleSet {
    const key = ruleSetName(name);
    const set = this.#ruleSets.get(key);
    if (set === undefined) {
      throw ruleSetNotFound(key);
    }
    return set;
  }

  hasRuleSet(name: string): boolean {
    return this.#ruleSets.has(ruleSetName(name));
  }

  removeRuleSet(name: string): boolean {
    return this.#ruleSets.delete(ruleSetName(name));
  }

  listRuleSets(): readonly EvaluationRuleSet[] {
    return Object.freeze(
      [...this.#ruleSets.values()].sort((left, right) => left.name.localeCompare(right.name)),
    );
  }

  setRules(name: string, rules: readonly EvaluationRuleSpec[]): EvaluationRuleSet {
    return this.#replace(name, validateRules(rules));
  }

  upsertRule(name: string, rule: EvaluationRuleSpec): EvaluationRuleSet {
    const validated = validateRules([rule]);
    const replacement = validated[0];
    if (replacement === undefined) {
      throw invalidRuleSet("no rule was supplied", name);
    }
    const current = this.requireRuleSet(name);
    const exists = current.rules.some((rule) => rule.id === replacement.id);
    const next = exists
      ? current.rules.map((rule) => (rule.id === replacement.id ? replacement : rule))
      : [...current.rules, replacement];
    if (next.length > MAX_EVALUATION_RULES) {
      throw invalidRuleSet(
        `adding "${replacement.id}" would exceed ${String(MAX_EVALUATION_RULES)} rules`,
        name,
      );
    }
    return this.#replace(name, validateRules(next));
  }

  removeRule(name: string, ruleId: string): EvaluationRuleSet {
    const current = this.requireRuleSet(name);
    if (!current.rules.some((rule) => rule.id === ruleId)) {
      throw ruleNotFound(name, ruleId);
    }
    return this.#replace(
      name,
      current.rules.filter((rule) => rule.id !== ruleId),
    );
  }

  evaluate(input: EvaluationInput, options: EvaluationOptions = {}): EvaluationResult {
    assertEvaluationInput(input);
    const setName = options.ruleSet ?? DEFAULT_EVALUATION_RULE_SET_NAME;
    const set = this.requireRuleSet(setName);
    const specs = selectRules(set, options.rules ?? null);
    const outcome = evaluateRules(input, specs);

    const metadata = sanitizeMetadata(
      {
        ...(options.metadata ?? {}),
        ruleSet: set.name,
        ruleSetVersion: set.version,
        rulesApplied: outcome.rulesApplied.length,
        rulesAvailable: set.rules.length,
        correlationId: options.context?.correlationId ?? null,
        tenantId: options.context?.tenantId ?? null,
      },
      "evaluation metadata",
    );

    return Object.freeze({
      id: createEvaluationId(),
      executionId: input.executionId,
      verdict: outcome.verdict,
      overallScore: outcome.overallScore,
      scores: outcome.scores,
      rulesApplied: outcome.rulesApplied,
      evaluatedAt: toIso(this.#clock()),
      // Determinism is the contract, not a claim: see the module comment on ai-core-types'
      // evaluation contracts. Nothing here reads a clock, a random source or a model.
      deterministic: true,
      metadata,
    });
  }

  #replace(name: string, rules: readonly EvaluationRuleSpec[]): EvaluationRuleSet {
    const current = this.requireRuleSet(name);
    const now = toIso(this.#clock());
    const next = createRuleSet({
      name: current.name,
      description: current.description,
      version: current.version + 1,
      rules,
      createdAt: current.createdAt,
      updatedAt: now,
    });
    validate(evaluationRuleSetSchema, next, "EvaluationRuleSet");
    this.#ruleSets.set(next.name, next);
    return next;
  }
}

/** Builds an engine. */
export function createEvaluationEngine(options: EvaluationEngineOptions = {}): EvaluationEngine {
  return new InMemoryEvaluationEngine(options);
}

/** Validates a rule list: shape, unique identifiers, and an implementation for every rule. */
function validateRules(rules: readonly EvaluationRuleSpec[]): readonly EvaluationRuleSpec[] {
  if (rules.length > MAX_EVALUATION_RULES) {
    throw invalidRuleSet(
      `declares ${String(rules.length)} rules, the maximum is ${String(MAX_EVALUATION_RULES)}`,
    );
  }
  const validated = rules.map((rule, index) =>
    validate(evaluationRuleSpecSchema, rule, `rules[${String(index)}]`),
  );
  const seen = new Set<string>();
  for (const rule of validated) {
    if (seen.has(rule.id)) {
      throw duplicateRuleId("<evaluation>", rule.id);
    }
    seen.add(rule.id);
    // A disabled rule is still validated: it can be enabled later, and finding out then that it
    // was never applicable is the worst possible time to discover it.
    requireRuleImplementation(rule);
  }
  return Object.freeze(
    validated.map((rule) =>
      Object.freeze({ ...rule, parameters: Object.freeze({ ...rule.parameters }) }),
    ),
  );
}

/** Selects the rules a run applies, in the set's own order. */
function selectRules(
  set: EvaluationRuleSet,
  requested: readonly string[] | null,
): readonly EvaluationRuleSpec[] {
  if (requested === null) {
    return set.rules;
  }
  const wanted = new Set(requested);
  for (const ruleId of requested) {
    if (!set.rules.some((rule) => rule.id === ruleId)) {
      throw ruleNotFound(set.name, ruleId);
    }
  }
  // Set order rather than request order, so two callers asking for the same rules in a different
  // order get byte-identical results.
  return set.rules.filter((rule) => wanted.has(rule.id));
}
