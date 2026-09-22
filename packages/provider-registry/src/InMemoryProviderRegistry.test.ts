import { describe, expect, it, vi } from "vitest";
import { createProviderId } from "@omnis/types";
import { MAX_FALLBACK_CANDIDATES } from "@omnis/ai-core-types";
import { ConflictError, ContractError, NotFoundError, ValidationError } from "@omnis/errors";
import { InMemoryProviderRegistry } from "./InMemoryProviderRegistry.js";
import {
  isLegalProviderStatusTransition,
  PROVIDER_STATUS_TRANSITIONS,
} from "./ProviderRegistry.js";
import type { ProviderRegistrationInput } from "./providerValidation.js";
import { isProviderSlug } from "./providerValidation.js";
import { scriptedAdapter } from "./testSupport.js";

const AT = "2026-03-01T12:00:00.000Z";

/** A registration input with sensible defaults for these suites. */
function input(
  slug: string,
  overrides: Partial<ProviderRegistrationInput> = {},
): ProviderRegistrationInput {
  return {
    slug,
    displayName: `${slug} provider`,
    capabilities: {
      operations: ["chat", "streaming"],
      inputModalities: ["text"],
      outputModalities: ["text"],
      modelCapabilities: ["chat", "streaming"],
    },
    credentialsConfigured: true,
    registeredAt: AT,
    ...overrides,
  };
}

/** A registry with a fixed clock so timestamps are predictable. */
function registry(): InMemoryProviderRegistry {
  return new InMemoryProviderRegistry({ clock: () => AT });
}

/** Registers a provider and returns its descriptor and adapter. */
function registered(
  reg: InMemoryProviderRegistry,
  slug: string,
  overrides: Partial<ProviderRegistrationInput> = {},
) {
  const providerId = createProviderId();
  const adapter = scriptedAdapter({
    providerId,
    slug,
    capabilities: overrides.capabilities?.modelCapabilities ?? ["chat", "streaming"],
  });
  const descriptor = reg.register(input(slug, { id: providerId, ...overrides }), adapter);
  return { descriptor, adapter };
}

describe("registration", () => {
  it("stores a frozen descriptor with the contract defaults", () => {
    const reg = registry();
    const providerId = createProviderId();
    const adapter = scriptedAdapter({ providerId, slug: "openai-compatible" });
    const descriptor = reg.register(input("openai-compatible", { id: providerId }), adapter);

    expect(descriptor.id.startsWith("prv_")).toBe(true);
    expect(descriptor.slug).toBe("openai-compatible");
    expect(descriptor.transport).toBe("http");
    // Registering never puts an unverified endpoint into rotation.
    expect(descriptor.status).toBe("registered");
    expect(descriptor.priority).toBe(100);
    expect(descriptor.latencyClass).toBe("unknown");
    expect(descriptor.rateLimit).toEqual({
      requestsPerMinute: null,
      tokensPerMinute: null,
      maxConcurrentRequests: null,
    });
    expect(descriptor.region).toBeNull();
    expect(descriptor.registeredAt).toBe(AT);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.capabilities)).toBe(true);
    expect(Object.isFrozen(descriptor.capabilities.operations)).toBe(true);
    expect(Object.isFrozen(descriptor.metadata)).toBe(true);
    expect(reg.size).toBe(1);
  });

  it("takes the identity from the adapter, which is the object that gets called", () => {
    const reg = registry();
    const providerId = createProviderId();
    const descriptor = reg.register(
      input("local", {}),
      scriptedAdapter({ providerId, slug: "local" }),
    );
    expect(descriptor.id).toBe(providerId);
    expect(reg.idForSlug("local")).toBe(providerId);
  });

  it("rejects an adapter belonging to a different provider", () => {
    const reg = registry();
    const declared = createProviderId();
    const actual = createProviderId();
    expect(() =>
      reg.register(
        input("mismatch", { id: declared }),
        scriptedAdapter({ providerId: actual, slug: "mismatch" }),
      ),
    ).toThrow(ContractError);
    expect(reg.size).toBe(0);
  });

  it("rejects a descriptor that is not a valid adapter", () => {
    const reg = registry();
    const providerId = createProviderId();
    const notAnAdapter = { providerId, slug: "broken" } as unknown as ReturnType<
      typeof scriptedAdapter
    >;
    expect(() => reg.register(input("broken", { id: providerId }), notAnAdapter)).toThrow(
      ContractError,
    );
  });

  it("rejects a duplicate slug", () => {
    const reg = registry();
    const first = registered(reg, "primary");
    expect(() => registered(reg, "primary")).toThrow(ConflictError);
    try {
      registered(reg, "primary");
      expect.unreachable("duplicate slug must be rejected");
    } catch (error) {
      const conflict = error as ConflictError;
      expect(conflict.code).toBe("conflict");
      expect(conflict.message).toContain("primary");
      // The identifier of the holder is in the metadata, not the message: a message is what
      // reaches a log line, and identifiers belong in structured context.
      expect(conflict.metadata["existingProviderId"]).toBe(first.descriptor.id);
      expect(conflict.retryable).toBe(false);
    }
    expect(reg.size).toBe(1);
  });

  it("rejects a duplicate provider id", () => {
    const reg = registry();
    const providerId = createProviderId();
    const adapter = scriptedAdapter({ providerId, slug: "one" });
    reg.register(input("one", { id: providerId }), adapter);
    expect(() =>
      reg.register(input("two", { id: providerId }), scriptedAdapter({ providerId, slug: "two" })),
    ).toThrow(ConflictError);
    expect(reg.size).toBe(1);
    // The rejected registration must not have taken the other slug.
    expect(reg.hasSlug("two")).toBe(false);
  });

  it("enforces capacity", () => {
    const reg = new InMemoryProviderRegistry({ clock: () => AT, maxEntries: 2 });
    registered(reg, "aa");
    registered(reg, "bb");
    expect(() => registered(reg, "cc")).toThrow(ConflictError);
    expect(reg.size).toBe(2);
  });

  it("rejects an invalid capacity and invalid health tuning", () => {
    expect(() => new InMemoryProviderRegistry({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => new InMemoryProviderRegistry({ maxEntries: 1.5 })).toThrow(RangeError);
    expect(() => new InMemoryProviderRegistry({ health: { failureThreshold: 0 } })).toThrow(
      RangeError,
    );
  });

  it("validates the slug, display name and capabilities", () => {
    const reg = registry();
    const providerId = createProviderId();
    const adapter = scriptedAdapter({ providerId, slug: "Bad Slug" });
    expect(() => reg.register(input("Bad Slug", { id: providerId }), adapter)).toThrow(
      ValidationError,
    );
    expect(() =>
      reg.register(
        input("ok", { displayName: "", id: createProviderId() }),
        scriptedAdapter({ providerId: createProviderId(), slug: "ok" }),
      ),
    ).toThrow(ValidationError);
    expect(() =>
      reg.register(
        input("caps", {
          id: createProviderId(),
          capabilities: {
            operations: [],
            inputModalities: ["text"],
            outputModalities: ["text"],
            modelCapabilities: [],
          },
        }),
        scriptedAdapter({ providerId: createProviderId(), slug: "caps" }),
      ),
    ).toThrow(ValidationError);
    expect(reg.size).toBe(0);
  });

  it("redacts secret-looking metadata instead of storing it", () => {
    const reg = registry();
    const { descriptor } = registered(reg, "redacted", {
      metadata: { apiKey: "AIza" + "A".repeat(35), note: "on-prem" },
    });
    expect(String(descriptor.metadata["apiKey"])).not.toContain("AIza");
    expect(descriptor.metadata["note"]).toBe("on-prem");
  });

  it("keeps the descriptor JSON-safe", () => {
    const reg = registry();
    const { descriptor } = registered(reg, "jsonsafe", { metadata: { tags: ["a", "b"] } });
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual({
      ...descriptor,
      metadata: { tags: ["a", "b"] },
    });
  });

  it("uses an injectable clock when registeredAt is absent", () => {
    const reg = new InMemoryProviderRegistry({ clock: () => "2026-04-02T08:30:00.000Z" });
    const { descriptor } = registered(reg, "clocked", { registeredAt: undefined });
    expect(descriptor.registeredAt).toBe("2026-04-02T08:30:00.000Z");
  });
});

describe("lookup", () => {
  it("finds by id and by slug, and reports absence", () => {
    const reg = registry();
    const { descriptor } = registered(reg, "primary");
    expect(reg.get(descriptor.id)).toBe(descriptor);
    expect(reg.require(descriptor.id)).toBe(descriptor);
    expect(reg.has(descriptor.id)).toBe(true);
    expect(reg.getBySlug("primary")).toBe(descriptor);
    expect(reg.hasSlug("primary")).toBe(true);
    expect(reg.idForSlug("primary")).toBe(descriptor.id);

    const missing = createProviderId();
    expect(reg.get(missing)).toBeNull();
    expect(reg.has(missing)).toBe(false);
    expect(reg.getBySlug("missing")).toBeNull();
    expect(reg.hasSlug("missing")).toBe(false);
    expect(reg.idForSlug("missing")).toBeNull();
    expect(() => reg.require(missing)).toThrow(NotFoundError);
    expect(() => reg.requireAdapter(missing)).toThrow(NotFoundError);
  });

  it("exposes the adapter only through the adapter accessors", () => {
    const reg = registry();
    const { descriptor, adapter } = registered(reg, "with-adapter");
    expect(reg.adapterFor(descriptor.id)).toBe(adapter);
    expect(reg.requireAdapter(descriptor.id)).toBe(adapter);
    expect(Object.isFrozen(descriptor)).toBe(true);
    // The descriptor carries no reference to the adapter.
    expect(JSON.stringify(descriptor)).not.toContain("invoke");
  });

  it("resolves an id reference and a slug reference", () => {
    const reg = registry();
    const { descriptor } = registered(reg, "resolvable");
    expect(reg.resolve({ kind: "id", providerId: descriptor.id })).toBe(descriptor);
    expect(reg.resolve({ kind: "slug", slug: "resolvable" })).toBe(descriptor);
    expect(reg.resolve({ kind: "slug", slug: "nope" })).toBeNull();
  });

  it("lists in canonical order and filters by operation and capability", () => {
    const reg = registry();
    const embedding = registered(reg, "embedder", {
      capabilities: {
        operations: ["embeddings"],
        inputModalities: ["text"],
        outputModalities: ["text"],
        modelCapabilities: ["embeddings"],
      },
      priority: 5,
    });
    const chat = registered(reg, "chatter", { priority: 20 });

    expect(reg.list().map((descriptor) => descriptor.slug)).toEqual(["embedder", "chatter"]);
    expect(reg.findByOperation("embeddings").map((descriptor) => descriptor.id)).toEqual([
      embedding.descriptor.id,
    ]);
    expect(reg.findByOperation("chat").map((descriptor) => descriptor.id)).toEqual([
      chat.descriptor.id,
    ]);
    expect(reg.findByCapability("embeddings")).toHaveLength(1);
    expect(reg.findByCapability("chat")).toHaveLength(1);
    expect(reg.findByCapability("vision")).toEqual([]);
    expect(Object.isFrozen(reg.list())).toBe(true);
  });

  it("returns the same ordering every time", () => {
    const reg = registry();
    for (const slug of ["delta", "alpha", "charlie", "bravo"]) {
      registered(reg, slug, { priority: 50 });
    }
    const first = reg.list().map((descriptor) => descriptor.slug);
    const second = reg.list().map((descriptor) => descriptor.slug);
    expect(first).toEqual(second);
    expect(first).toEqual(["alpha", "bravo", "charlie", "delta"]);
  });
});

describe("lifecycle", () => {
  it("moves a provider through the published transition table", () => {
    const reg = registry();
    const { descriptor } = registered(reg, "lifecycle");
    const initializing = reg.setStatus(descriptor.id, "initializing");
    expect(initializing.status).toBe("initializing");
    expect(reg.setStatus(initializing.id, "ready").status).toBe("ready");
    expect(reg.get(descriptor.id)?.status).toBe("ready");
  });

  it("returns the same descriptor when the status is unchanged", () => {
    const reg = registry();
    const { descriptor } = registered(reg, "noop");
    const ready = reg.setStatus(descriptor.id, "ready");
    expect(reg.setStatus(ready.id, "ready")).toBe(ready);
  });

  it("rejects an illegal transition", () => {
    const reg = registry();
    const { descriptor } = registered(reg, "illegal");
    // `registered` may not become `degraded` without being initialized first.
    expect(() => reg.setStatus(descriptor.id, "degraded")).toThrow(ValidationError);
    expect(reg.get(descriptor.id)?.status).toBe("registered");
  });

  it("requires a disabled provider to be re-initialized", () => {
    const reg = registry();
    const { descriptor } = registered(reg, "disablable");
    const disabled = reg.setStatus(descriptor.id, "disabled");
    expect(() => reg.setStatus(disabled.id, "ready")).toThrow(ValidationError);
    expect(reg.setStatus(disabled.id, "initializing").status).toBe("initializing");
  });

  it("throws for an unknown provider", () => {
    expect(() => registry().setStatus(createProviderId(), "ready")).toThrow(NotFoundError);
  });

  it("agrees with the transition table for every status pair", () => {
    const statuses = Object.keys(
      PROVIDER_STATUS_TRANSITIONS,
    ) as (keyof typeof PROVIDER_STATUS_TRANSITIONS)[];
    for (const from of statuses) {
      expect(isLegalProviderStatusTransition(from, from)).toBe(true);
      for (const to of PROVIDER_STATUS_TRANSITIONS[from] ?? []) {
        expect(isLegalProviderStatusTransition(from, to), `${from}->${to}`).toBe(true);
      }
    }
    expect(isLegalProviderStatusTransition("registered", "degraded")).toBe(false);
    expect(isLegalProviderStatusTransition("disabled", "ready")).toBe(false);
  });
});

describe("health", () => {
  it("starts unknown and reduces observations through the configured thresholds", () => {
    const reg = registry();
    const { descriptor } = registered(reg, "healthy-provider");
    expect(reg.health(descriptor.id).state).toBe("unknown");
    expect(reg.healthOptions.failureThreshold).toBe(3);

    expect(reg.recordSuccess(descriptor.id, 120).state).toBe("healthy");
    expect(reg.recordFailure(descriptor.id, "provider_failure").state).toBe("degraded");
    expect(reg.recordFailure(descriptor.id, "provider_failure").state).toBe("degraded");
    expect(reg.recordFailure(descriptor.id, "deadline_exceeded").state).toBe("unavailable");
    expect(reg.health(descriptor.id).consecutiveFailures).toBe(3);
  });

  it("returns the same snapshot until the next observation", () => {
    const reg = registry();
    const { descriptor } = registered(reg, "snapshot");
    const after = reg.recordObservation(descriptor.id, {
      kind: "success",
      latencyMs: 90,
      observedAt: AT,
    });
    expect(reg.health(descriptor.id)).toBe(after);
    expect(reg.health(descriptor.id).averageLatencyMs).toBe(90);
  });

  it("stamps observations with the registry clock when not given", () => {
    const reg = new InMemoryProviderRegistry({ clock: () => "2026-05-05T05:05:05.000Z" });
    const { descriptor } = registered(reg, "stamped");
    expect(reg.recordSuccess(descriptor.id, 10).lastSuccessAt).toBe("2026-05-05T05:05:05.000Z");
    expect(reg.recordFailure(descriptor.id, "provider_failure").lastFailureAt).toBe(
      "2026-05-05T05:05:05.000Z",
    );
  });

  it("reports unknown health for an unregistered provider instead of throwing", () => {
    // Reading health is a reporting operation; failing it would turn a status page into an
    // error page. Recording an observation is different, and that one does throw.
    const reg = registry();
    const missing = createProviderId();
    expect(reg.health(missing).state).toBe("unknown");
    expect(() =>
      reg.recordObservation(missing, { kind: "success", latencyMs: 1, observedAt: AT }),
    ).toThrow(NotFoundError);
  });
});

describe("removal", () => {
  it("frees the slug and disposes the adapter", async () => {
    const reg = registry();
    const { descriptor } = registered(reg, "removable");
    const adapter = reg.requireAdapter(descriptor.id);
    const dispose = vi.fn().mockResolvedValue(undefined);
    Object.assign(adapter, { dispose });

    expect(reg.remove(descriptor.id)).toBe(true);
    expect(reg.has(descriptor.id)).toBe(false);
    expect(reg.hasSlug("removable")).toBe(false);
    expect(reg.get(descriptor.id)).toBeNull();
    expect(reg.size).toBe(0);
    expect(dispose).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });

  it("is idempotent", () => {
    const reg = registry();
    const { descriptor } = registered(reg, "twice");
    expect(reg.remove(descriptor.id)).toBe(true);
    expect(reg.remove(descriptor.id)).toBe(false);
  });

  it("lets a removed slug be re-registered", () => {
    const reg = registry();
    const first = registered(reg, "reusable");
    reg.remove(first.descriptor.id);
    const second = registered(reg, "reusable");
    expect(second.descriptor.id).not.toBe(first.descriptor.id);
    expect(reg.hasSlug("reusable")).toBe(true);
  });
});

describe("selection", () => {
  it("selects nothing while every provider is unproven", () => {
    const reg = registry();
    registered(reg, "unproven");
    expect(reg.select()).toEqual([]);
    expect(reg.selectable()).toEqual([]);
  });

  it("selects ready providers in ranked order", () => {
    const reg = registry();
    const preferred = registered(reg, "preferred", { priority: 1 });
    const backup = registered(reg, "backup", { priority: 200 });
    reg.setStatus(preferred.descriptor.id, "ready");
    reg.setStatus(backup.descriptor.id, "ready");
    reg.recordSuccess(preferred.descriptor.id, 80);
    reg.recordSuccess(backup.descriptor.id, 900);

    const selected = reg.select();
    expect(selected.map((candidate) => candidate.descriptor.slug)).toEqual(["preferred", "backup"]);
    expect(selected[0]?.score).toBeGreaterThan(selected[1]?.score ?? 0);
    expect(Object.isFrozen(selected)).toBe(true);
  });

  it("excludes providers that stopped being healthy", () => {
    const reg = registry();
    const good = registered(reg, "good");
    const bad = registered(reg, "bad");
    reg.setStatus(good.descriptor.id, "ready");
    reg.setStatus(bad.descriptor.id, "ready");
    for (let index = 0; index < 3; index += 1) {
      reg.recordFailure(bad.descriptor.id, "provider_failure");
    }
    expect(reg.select().map((candidate) => candidate.descriptor.slug)).toEqual(["good"]);
  });

  it("passes the selection request through to the scorer", () => {
    const reg = registry();
    const embedder = registered(reg, "embedder", {
      capabilities: {
        operations: ["embeddings"],
        inputModalities: ["text"],
        outputModalities: ["text"],
        modelCapabilities: ["embeddings"],
      },
    });
    const chatter = registered(reg, "chatter");
    reg.setStatus(embedder.descriptor.id, "ready");
    reg.setStatus(chatter.descriptor.id, "ready");
    expect(
      reg.select({ operations: ["embeddings"] }).map((candidate) => candidate.descriptor.slug),
    ).toEqual(["embedder"]);
    expect(
      reg.selectable({ capabilities: ["chat"] }).map((provider) => provider.descriptor.slug),
    ).toEqual(["chatter"]);
  });

  it("caps the candidate list", () => {
    const reg = new InMemoryProviderRegistry({
      clock: () => AT,
      maxEntries: MAX_FALLBACK_CANDIDATES + 4,
    });
    for (let index = 0; index < MAX_FALLBACK_CANDIDATES + 4; index += 1) {
      const { descriptor } = registered(reg, `p${String(index).padStart(2, "0")}`);
      reg.setStatus(descriptor.id, "ready");
    }
    expect(reg.select()).toHaveLength(MAX_FALLBACK_CANDIDATES);
  });

  it("lists selectable providers in canonical registry order", () => {
    const reg = registry();
    for (const slug of ["zulu", "yankee", "xray"]) {
      const { descriptor } = registered(reg, slug, { priority: 50 });
      reg.setStatus(descriptor.id, "ready");
    }
    expect(reg.selectable().map((provider) => provider.descriptor.slug)).toEqual([
      "xray",
      "yankee",
      "zulu",
    ]);
  });

  it("never invokes an adapter during registration, lookup or selection", () => {
    const reg = registry();
    const { descriptor, adapter } = registered(reg, "quiet");
    reg.setStatus(descriptor.id, "ready");
    reg.list();
    reg.select();
    expect(adapter.invocations).toEqual([]);
    expect(adapter.supportsCalls).toBe(0);
  });
});

describe("slug contract", () => {
  it("accepts kebab-case slugs and rejects everything else", () => {
    for (const valid of [
      "openai",
      "local-ollama",
      "anthropic-eu-1",
      "ab",
      "provider-123",
      "a.b_c-d",
    ]) {
      expect(isProviderSlug(valid), valid).toBe(true);
    }
    for (const invalid of [
      "OpenAI",
      "with space",
      "trailing-",
      "-leading",
      "",
      "a",
      "a".repeat(65),
      ".leading-dot",
    ]) {
      expect(isProviderSlug(invalid), invalid).toBe(false);
    }
  });
});
