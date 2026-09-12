/**
 * A typed in-memory event bus.
 *
 * STATUS: local development and tests only.
 *
 * This is explicitly **not** a production transport. It has no persistence, no
 * delivery guarantees, no retry, no dead-letter handling and no cross-process
 * reach: if the process dies, every in-flight event is lost. Shipping it as the
 * real event infrastructure would be exactly the kind of fake production
 * behaviour Sprint 0 forbids.
 *
 * What it *is* is the reference implementation of the {@link EventBus} contract.
 * That matters for two reasons:
 *
 * 1. Domains can be built and tested against the real contract now, without
 *    waiting for a broker to be chosen. A later Sprint supplies a durable
 *    implementation of the same interface and no domain code changes.
 * 2. It encodes the invariants every implementation must uphold — validate before
 *    dispatch, isolate handler failures, deliver in order — so the durable one
 *    can be tested against the same expectations.
 */

import { ExecutionError } from "@omnis/errors";
import type { EventType } from "@omnis/types";
import type { EventEnvelope } from "@omnis/contracts";
import type { EventRegistry } from "./registry.js";

/** A consumer of events. May be synchronous or asynchronous. */
export type EventHandler = (event: EventEnvelope) => void | Promise<void>;

/** A cancellable subscription. */
export interface Subscription {
  /** The type subscribed to, or `null` for a wildcard subscription. */
  readonly type: EventType | null;
  /** Stops delivery. Idempotent. */
  unsubscribe(): void;
}

/** The transport-agnostic publishing contract. */
export interface EventBus {
  /**
   * Validates and delivers an event.
   *
   * Implementations must reject an event whose type is not registered, and must
   * not let one failing handler prevent the others from running.
   */
  publish(event: EventEnvelope): Promise<void>;
  /** Subscribes to one event type. */
  subscribe(type: EventType, handler: EventHandler): Subscription;
  /** Subscribes to every event, for auditing, tracing and debugging. */
  subscribeAll(handler: EventHandler): Subscription;
  /** Number of active subscriptions, for a type or in total. */
  subscriberCount(type?: EventType): number;
}

interface HandlerRecord {
  readonly type: EventType | null;
  readonly handler: EventHandler;
}

/**
 * An {@link EventBus} backed by in-process arrays.
 *
 * Handlers for a given event run **sequentially in subscription order**. That is
 * a deliberate choice for the reference implementation: it makes causality
 * observable and reproducible in tests, which parallel dispatch would not. A
 * production transport will deliver concurrently across processes and must
 * therefore not be assumed to preserve handler ordering — anything that needs
 * ordering must derive it from the event's own identifiers and timestamps, not
 * from delivery sequence.
 */
export class InMemoryEventBus implements EventBus {
  private readonly handlers: HandlerRecord[] = [];
  private readonly registry: EventRegistry;
  private published = 0;

  constructor(registry: EventRegistry) {
    this.registry = registry;
  }

  async publish(event: EventEnvelope): Promise<void> {
    // Validate before dispatch, always. An event that cannot be parsed against
    // its registered contract must never reach a consumer: the consumer would
    // either crash or, worse, silently misinterpret it.
    this.registry.validateEnvelope(event);

    const type = String(event.type);
    const targets = this.handlers.filter(
      (record) => record.type === null || String(record.type) === type,
    );

    const failures: unknown[] = [];
    for (const record of targets) {
      try {
        await record.handler(event);
      } catch (error) {
        // Isolate the failure. One broken consumer must not blind every other
        // consumer to the same event; in a durable transport this is what makes
        // per-consumer retry and dead-lettering possible.
        failures.push(error);
      }
    }

    this.published += 1;

    if (failures.length > 0) {
      throw new ExecutionError(
        `${failures.length} of ${targets.length} handler(s) failed for "${type}".`,
        {
          cause: failures[0],
          metadata: {
            eventType: type,
            eventId: String(event.id),
            correlationId: String(event.correlationId),
            handlerCount: targets.length,
            failureCount: failures.length,
          },
          retryable: false,
        },
      );
    }
  }

  subscribe(type: EventType, handler: EventHandler): Subscription {
    return this.add({ type, handler });
  }

  subscribeAll(handler: EventHandler): Subscription {
    return this.add({ type: null, handler });
  }

  subscriberCount(type?: EventType): number {
    if (type === undefined) {
      return this.handlers.length;
    }
    const wanted = String(type);
    return this.handlers.filter((record) => record.type !== null && String(record.type) === wanted)
      .length;
  }

  /** Total number of events successfully validated and dispatched. */
  get publishedCount(): number {
    return this.published;
  }

  /** Removes every subscription. Used to reset state between tests. */
  clear(): void {
    this.handlers.length = 0;
    this.published = 0;
  }

  private add(record: HandlerRecord): Subscription {
    this.handlers.push(record);
    let active = true;
    return {
      type: record.type,
      unsubscribe: () => {
        if (!active) {
          return;
        }
        active = false;
        const index = this.handlers.indexOf(record);
        if (index !== -1) {
          this.handlers.splice(index, 1);
        }
      },
    };
  }
}

/** Creates an in-memory bus bound to a registry. */
export function createInMemoryEventBus(registry: EventRegistry): InMemoryEventBus {
  return new InMemoryEventBus(registry);
}
