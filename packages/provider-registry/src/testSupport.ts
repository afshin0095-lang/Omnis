/**
 * Test doubles for this package's suites.
 *
 * A scripted adapter is the only honest way to test provider selection and health: a real
 * adapter's behavior depends on a network and a vendor, so a test against one would be
 * testing the vendor. This double returns exactly what it was told to return, in the order
 * it was told, and records what it was asked — which is also how the tests assert that the
 * registry never invokes an adapter itself.
 *
 * Excluded from the published build by `tsconfig.build.json`.
 */

import type {
  ModelCapability,
  ModelId,
  ModelRequest,
  ModelResponse,
  ProviderAdapter,
  ProviderInvocationContext,
  ProviderInvocationResult,
  ProviderId,
} from "@omnis/ai-core-types";
import { EMPTY_USAGE } from "@omnis/ai-core-types";
import { providerInvocationError } from "@omnis/ai-core-types";

/** One recorded invocation. */
export interface RecordedInvocation {
  readonly request: ModelRequest;
  readonly context: ProviderInvocationContext;
}

/** How a scripted adapter behaves. */
export interface ScriptedAdapterOptions {
  readonly providerId: ProviderId;
  readonly slug: string;
  /** Capabilities the adapter confirms for every model. */
  readonly capabilities?: readonly ModelCapability[];
  /** Responses to return, in order. The last one repeats once the list is exhausted. */
  readonly responses?: readonly ProviderInvocationResult[];
  /** When set, every invocation fails with this message instead. */
  readonly failWith?: string;
  /** When true, the adapter also implements `stream`. */
  readonly streaming?: boolean;
}

/** A deterministic adapter, and the record of what it was asked to do. */
export interface ScriptedAdapter extends ProviderAdapter {
  readonly invocations: readonly RecordedInvocation[];
  readonly supportsCalls: number;
}

/** Creates a scripted adapter. */
export function scriptedAdapter(options: ScriptedAdapterOptions): ScriptedAdapter {
  const capabilities = options.capabilities ?? ["chat"];
  const responses = options.responses ?? [];
  const invocations: RecordedInvocation[] = [];
  let supportsCalls = 0;

  const nextResult = (index: number): ProviderInvocationResult => {
    if (options.failWith !== undefined) {
      return {
        status: "failed",
        failure: {
          class: "provider_failure",
          code: "provider_failure",
          message: options.failWith,
          retryable: true,
          retryAfterMs: null,
          attempt: 1,
          stepId: null,
          executionId: null,
          modelId: null,
          providerId: options.providerId,
          toolId: null,
          details: {},
          occurredAt: "2026-01-01T00:00:00.000Z",
        },
        usage: EMPTY_USAGE,
        latencyMs: 5,
      };
    }
    const scripted = responses[Math.min(index, Math.max(0, responses.length - 1))];
    if (scripted !== undefined) {
      return scripted;
    }
    return {
      status: "failed",
      failure: {
        class: "provider_failure",
        code: "provider_failure",
        message: "scripted adapter has no response configured",
        retryable: false,
        retryAfterMs: null,
        attempt: 1,
        stepId: null,
        executionId: null,
        modelId: null,
        providerId: options.providerId,
        toolId: null,
        details: {},
        occurredAt: "2026-01-01T00:00:00.000Z",
      },
      usage: EMPTY_USAGE,
      latencyMs: 0,
    };
  };

  const adapter: ScriptedAdapter = {
    providerId: options.providerId,
    slug: options.slug,
    async invoke(
      request: ModelRequest,
      context: ProviderInvocationContext,
    ): Promise<ProviderInvocationResult> {
      invocations.push({ request, context });
      return nextResult(invocations.length - 1);
    },
    supports(capability: ModelCapability, _modelId: ModelId): boolean {
      supportsCalls += 1;
      return capabilities.includes(capability);
    },
    get invocations(): readonly RecordedInvocation[] {
      return invocations;
    },
    get supportsCalls(): number {
      return supportsCalls;
    },
  };

  if (options.streaming === true) {
    return Object.assign(adapter, {
      async *stream(request: ModelRequest, context: ProviderInvocationContext) {
        invocations.push({ request, context });
        yield {
          type: "started",
          modelId: request.modelId,
          providerId: request.providerId,
        } as const;
        yield { type: "delta", text: "streamed" } as const;
        yield { type: "completed", stopReason: "stop", latencyMs: 1 } as const;
      },
    });
  }

  return adapter;
}

/** Builds a completed invocation result for a scripted adapter. */
export function completedResult(
  modelId: ModelId,
  providerId: ProviderId,
  text: string,
): ProviderInvocationResult {
  const response: ModelResponse = {
    modelId,
    providerId,
    message: { role: "assistant", content: [{ type: "text", text }], name: null, metadata: {} },
    stopReason: "stop",
    usage: {
      ...EMPTY_USAGE,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      requests: 1,
      costMicro: 100,
    },
    latencyMs: 12,
    streamed: false,
    providerDetails: null,
    servedAt: "2026-01-01T00:00:00.000Z",
  };
  return { status: "completed", response, usage: response.usage, latencyMs: response.latencyMs };
}

/** A provider error result, for adapters that must fail. */
export function failedResult(providerId: ProviderId, message: string): ProviderInvocationResult {
  const error = providerInvocationError(providerId, message);
  return {
    status: "failed",
    failure: {
      class: "provider_failure",
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs ?? null,
      attempt: 1,
      stepId: null,
      executionId: null,
      modelId: null,
      providerId,
      toolId: null,
      details: {},
      occurredAt: "2026-01-01T00:00:00.000Z",
    },
    usage: EMPTY_USAGE,
    latencyMs: 3,
  };
}
