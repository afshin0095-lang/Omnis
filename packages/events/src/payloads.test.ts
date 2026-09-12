/**
 * Event payload contract tests.
 *
 * These pin the modelling rules the payloads are built on, because each rule exists
 * to prevent a specific production failure: "null, never optional" keeps the wire
 * shape stable, "null, never zero" keeps a missing metric from being read as a bad
 * one, and "key names, never values" keeps configuration out of a broadcast event.
 */

import { ERROR_CODE_VALUES } from "@omnis/errors";
import {
  createAgentId,
  createCharacterId,
  createChannelId,
  createContentId,
  createContentRequestId,
  createJobId,
  createOpportunityId,
  createWorkspaceId,
} from "@omnis/types";
import { describe, expect, it } from "vitest";
import {
  agentExecutionCompletedPayloadSchema,
  agentExecutionFailedPayloadSchema,
  agentExecutionStartedPayloadSchema,
  analyticsPerformanceRecordedPayloadSchema,
  audienceCommentReceivedPayloadSchema,
  audienceDmReceivedPayloadSchema,
  audienceRequestDetectedPayloadSchema,
  characterCreatedPayloadSchema,
  characterExperienceRecordedPayloadSchema,
  configurationLoadedPayloadSchema,
  contentProductionCompletedPayloadSchema,
  contentProductionRequestedPayloadSchema,
  contentProductionStartedPayloadSchema,
  performanceMetricsSchema,
  publishingJobCompletedPayloadSchema,
  publishingJobCreatedPayloadSchema,
  systemInitializedPayloadSchema,
} from "./index.js";

const AGENT_ID = String(createAgentId());
const CHARACTER_ID = String(createCharacterId());
const CHANNEL_ID = String(createChannelId());
const CONTENT_ID = String(createContentId());
const JOB_ID = String(createJobId());
const NOW = "2026-03-14T09:26:53.000Z";

/** Metrics with every value present, used as the base for narrowing tests. */
const FULL_METRICS = {
  views: 1200,
  likes: 90,
  comments: 12,
  shares: 4,
  saves: 7,
  watchTimeSeconds: 5400,
  averageViewDurationSeconds: 45,
  clickThroughRate: 6.5,
  retentionRate: 0.42,
  subscribersGained: 11,
  revenueUsd: 3.25,
};

describe("system payloads", () => {
  it("accepts a boot report", () => {
    const result = systemInitializedPayloadSchema.safeParse({
      service: "content-factory",
      version: "0.1.0",
      environment: "test",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a boot report naming an unknown environment", () => {
    expect(
      systemInitializedPayloadSchema.safeParse({
        service: "content-factory",
        version: "0.1.0",
        environment: "staging-eu",
      }).success,
    ).toBe(false);
  });

  it("carries configuration key names only, and defaults the lists", () => {
    const result = configurationLoadedPayloadSchema.safeParse({
      service: "content-factory",
      environment: "production",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.keys).toEqual([]);
      expect(result.data.usedDefaults).toBe(false);
    }
  });

  it("cannot smuggle a configuration value inside the key list", () => {
    // The list holds names; a value would have to arrive as a nested structure, and
    // the element schema rejects anything that is not a non-empty trimmed string.
    expect(
      configurationLoadedPayloadSchema.safeParse({
        service: "content-factory",
        environment: "production",
        keys: [{ name: "OPENAI_API_KEY", value: "sk-secret" }],
        usedDefaults: false,
      }).success,
    ).toBe(false);
  });

  it("drops an unknown field rather than broadcasting it", () => {
    // A producer that adds a `values` field must not succeed in publishing secrets
    // just because it named the field something the consumer ignores.
    const result = configurationLoadedPayloadSchema.safeParse({
      service: "content-factory",
      environment: "production",
      keys: ["OMNIS_ENV"],
      usedDefaults: false,
      values: { OMNIS_ENV: "production" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data)).not.toContain("values");
    }
  });
});

describe("agent payloads", () => {
  it("records a model reference as nullable, not optional", () => {
    expect(
      agentExecutionStartedPayloadSchema.safeParse({
        agentId: AGENT_ID,
        capability: "script.draft",
        model: null,
      }).success,
    ).toBe(true);
    expect(
      agentExecutionStartedPayloadSchema.safeParse({
        agentId: AGENT_ID,
        capability: "script.draft",
      }).success,
    ).toBe(false);
  });

  it("distinguishes 'not yet priced' from 'free'", () => {
    const unpriced = agentExecutionCompletedPayloadSchema.safeParse({
      agentId: AGENT_ID,
      capability: "script.draft",
      durationMs: 812,
      tokensUsed: 1450,
      costUsd: null,
    });
    expect(unpriced.success).toBe(true);
    if (unpriced.success) {
      expect(unpriced.data.costUsd).toBeNull();
    }

    expect(
      agentExecutionCompletedPayloadSchema.safeParse({
        agentId: AGENT_ID,
        capability: "script.draft",
        durationMs: 812,
        tokensUsed: 1450,
      }).success,
    ).toBe(false);
  });

  it("rejects a negative cost or token count", () => {
    expect(
      agentExecutionCompletedPayloadSchema.safeParse({
        agentId: AGENT_ID,
        capability: "script.draft",
        durationMs: 1,
        tokensUsed: -1,
        costUsd: null,
      }).success,
    ).toBe(false);
    expect(
      agentExecutionCompletedPayloadSchema.safeParse({
        agentId: AGENT_ID,
        capability: "script.draft",
        durationMs: 1,
        tokensUsed: null,
        costUsd: -0.01,
      }).success,
    ).toBe(false);
  });

  it("only accepts error codes from the stable OMNIS set", () => {
    const base = {
      agentId: AGENT_ID,
      capability: "script.draft",
      durationMs: 42,
      errorMessage: "provider unavailable",
      retryable: true,
    };
    expect(
      agentExecutionFailedPayloadSchema.safeParse({ ...base, errorCode: "provider_failure" })
        .success,
    ).toBe(ERROR_CODE_VALUES.includes("provider_failure" as (typeof ERROR_CODE_VALUES)[number]));
    expect(
      agentExecutionFailedPayloadSchema.safeParse({ ...base, errorCode: "it_broke" }).success,
    ).toBe(false);
  });
});

describe("character payloads", () => {
  it("accepts a character with no workspace yet", () => {
    const result = characterCreatedPayloadSchema.safeParse({
      characterId: CHARACTER_ID,
      workspaceId: null,
      displayName: "Ava",
      definitionVersion: "1.0.0",
    });
    expect(result.success).toBe(true);
  });

  it("keeps the definition version a character was created from", () => {
    // Without it a behaviour change cannot be attributed to a definition edit.
    expect(
      characterCreatedPayloadSchema.safeParse({
        characterId: CHARACTER_ID,
        workspaceId: String(createWorkspaceId()),
        displayName: "Ava",
      }).success,
    ).toBe(false);
    expect(
      characterCreatedPayloadSchema.safeParse({
        characterId: CHARACTER_ID,
        workspaceId: null,
        displayName: "Ava",
        definitionVersion: "1.0",
      }).success,
    ).toBe(false);
  });

  it("requires an experience kind from the agreed vocabulary", () => {
    const base = {
      characterId: CHARACTER_ID,
      summary: "Audience asked for a behind-the-scenes episode",
      occurredAt: NOW,
      contentId: CONTENT_ID,
      observations: { requests: 3 },
    };
    expect(
      characterExperienceRecordedPayloadSchema.safeParse({ ...base, kind: "audience_interaction" })
        .success,
    ).toBe(true);
    expect(
      characterExperienceRecordedPayloadSchema.safeParse({ ...base, kind: "vibes" }).success,
    ).toBe(false);
  });

  it("defaults open-ended observations to an empty object but keeps them JSON", () => {
    const withDefault = characterExperienceRecordedPayloadSchema.safeParse({
      characterId: CHARACTER_ID,
      kind: "reflection",
      summary: "No notable signals this cycle",
      occurredAt: NOW,
      contentId: null,
    });
    expect(withDefault.success).toBe(true);
    if (withDefault.success) {
      expect(withDefault.data.observations).toEqual({});
    }

    expect(
      characterExperienceRecordedPayloadSchema.safeParse({
        characterId: CHARACTER_ID,
        kind: "reflection",
        summary: "No notable signals this cycle",
        occurredAt: NOW,
        contentId: null,
        observations: "not-an-object",
      }).success,
    ).toBe(false);
  });
});

describe("audience payloads", () => {
  const signal = {
    platform: "youtube",
    channelId: CHANNEL_ID,
    externalId: "yt-comment-9931",
    contentId: CONTENT_ID,
    authorRef: "u_8f2a1c",
    text: "Please make one about lighting setups",
    language: "en-US",
    publishedAt: NOW,
  };

  it("accepts an inbound comment signal", () => {
    expect(audienceCommentReceivedPayloadSchema.safeParse(signal).success).toBe(true);
  });

  it("references the author opaquely and cannot be widened to an identity", () => {
    // Audience Intelligence needs to recognise a returning commenter, not to know who
    // they are; an identity field would be both a breach surface and a compliance one.
    const withIdentity = audienceCommentReceivedPayloadSchema.safeParse({
      ...signal,
      authorRef: null,
      authorEmail: "viewer@example.com",
      authorName: "Sam Viewer",
    });
    expect(withIdentity.success).toBe(true);
    if (withIdentity.success) {
      expect(Object.keys(withIdentity.data)).not.toContain("authorEmail");
      expect(Object.keys(withIdentity.data)).not.toContain("authorName");
    }
  });

  it("requires an external identifier so ingestion stays idempotent", () => {
    const { externalId: _externalId, ...withoutExternalId } = signal;
    expect(audienceCommentReceivedPayloadSchema.safeParse(withoutExternalId).success).toBe(false);
  });

  it("requires the conversation a DM belongs to", () => {
    expect(audienceDmReceivedPayloadSchema.safeParse(signal).success).toBe(false);
    expect(
      audienceDmReceivedPayloadSchema.safeParse({ ...signal, conversationId: "yt-thread-12" })
        .success,
    ).toBe(true);
  });

  it("records detector confidence instead of thresholding it", () => {
    const base = {
      requestId: String(createContentRequestId()),
      platform: "tiktok",
      sourceExternalId: "tt-comment-4412",
      topic: "lighting setups",
      detectedAt: NOW,
    };
    expect(
      audienceRequestDetectedPayloadSchema.safeParse({ ...base, confidence: 0.83 }).success,
    ).toBe(true);
    expect(
      audienceRequestDetectedPayloadSchema.safeParse({ ...base, confidence: 1.4 }).success,
    ).toBe(false);
    expect(
      audienceRequestDetectedPayloadSchema.safeParse({ ...base, confidence: -0.1 }).success,
    ).toBe(false);
  });
});

describe("content and publishing payloads", () => {
  it("allows a production request with no character, opportunity or title yet", () => {
    const result = contentProductionRequestedPayloadSchema.safeParse({
      contentId: CONTENT_ID,
      format: "short_video",
      characterId: null,
      opportunityId: String(createOpportunityId()),
      workingTitle: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown content format", () => {
    expect(
      contentProductionRequestedPayloadSchema.safeParse({
        contentId: CONTENT_ID,
        format: "hologram",
        characterId: null,
        opportunityId: null,
        workingTitle: null,
      }).success,
    ).toBe(false);
  });

  it("keeps a QA score separate from completion", () => {
    const completed = contentProductionCompletedPayloadSchema.safeParse({
      contentId: CONTENT_ID,
      completedAt: NOW,
      durationMs: 94_000,
      assetUri: null,
      qualityScore: null,
    });
    expect(completed.success).toBe(true);
    expect(
      contentProductionCompletedPayloadSchema.safeParse({
        contentId: CONTENT_ID,
        completedAt: NOW,
        durationMs: 94_000,
        assetUri: "not-a-uri",
        qualityScore: 0.9,
      }).success,
    ).toBe(false);
    expect(
      contentProductionCompletedPayloadSchema.safeParse({
        contentId: CONTENT_ID,
        completedAt: NOW,
        durationMs: 94_000,
        assetUri: null,
        qualityScore: 1.2,
      }).success,
    ).toBe(false);
  });

  it("requires a pipeline version so results stay attributable", () => {
    expect(
      contentProductionStartedPayloadSchema.safeParse({
        contentId: CONTENT_ID,
        startedAt: NOW,
      }).success,
    ).toBe(false);
  });

  it("makes the approval requirement explicit on a queued job", () => {
    const base = {
      jobId: JOB_ID,
      contentId: CONTENT_ID,
      channelId: CHANNEL_ID,
      platform: "instagram",
      scheduledFor: null,
    };
    expect(
      publishingJobCreatedPayloadSchema.safeParse({ ...base, approvalRequired: true }).success,
    ).toBe(true);
    // A job whose approval requirement is unstated could be published by a retry path
    // that never consulted the policy engine.
    expect(publishingJobCreatedPayloadSchema.safeParse(base).success).toBe(false);
  });

  it("cannot report a publication the platform never confirmed", () => {
    const base = {
      jobId: JOB_ID,
      contentId: CONTENT_ID,
      channelId: CHANNEL_ID,
      platform: "youtube",
      publishedAt: NOW,
      publicationUrl: "https://youtube.com/watch?v=abc123",
    };
    expect(
      publishingJobCompletedPayloadSchema.safeParse({ ...base, externalPublicationId: "yt-vid-77" })
        .success,
    ).toBe(true);
    expect(publishingJobCompletedPayloadSchema.safeParse(base).success).toBe(false);
  });
});

describe("analytics payloads", () => {
  const sample = {
    contentId: CONTENT_ID,
    channelId: CHANNEL_ID,
    platform: "youtube",
    measuredAt: NOW,
    windowHours: 24,
    metrics: FULL_METRICS,
  };

  it("accepts a full measurement sample", () => {
    expect(analyticsPerformanceRecordedPayloadSchema.safeParse(sample).success).toBe(true);
  });

  it("records the measurement window and rejects a zero-length one", () => {
    // A 24-hour count and a 30-day count are different measurements; comparing them is
    // how a growth dashboard starts lying.
    expect(
      analyticsPerformanceRecordedPayloadSchema.safeParse({ ...sample, windowHours: 0 }).success,
    ).toBe(false);
    expect(
      analyticsPerformanceRecordedPayloadSchema.safeParse({ ...sample, windowHours: 720 }).success,
    ).toBe(true);
  });

  it("treats an unreported metric as null, never as zero", () => {
    const allNull = performanceMetricsSchema.safeParse({
      views: null,
      likes: null,
      comments: null,
      shares: null,
      saves: null,
      watchTimeSeconds: null,
      averageViewDurationSeconds: null,
      clickThroughRate: null,
      retentionRate: null,
      subscribersGained: null,
      revenueUsd: null,
    });
    expect(allNull.success).toBe(true);

    // An omitted metric is not an assertion, so it is rejected rather than defaulted.
    const { views: _views, ...withoutViews } = FULL_METRICS;
    expect(performanceMetricsSchema.safeParse(withoutViews).success).toBe(false);
  });

  it("allows a channel to lose subscribers", () => {
    expect(
      performanceMetricsSchema.safeParse({ ...FULL_METRICS, subscribersGained: -3 }).success,
    ).toBe(true);
  });

  it("keeps rates inside their own scales", () => {
    // clickThroughRate is a percentage, retentionRate a ratio: mixing the two scales is
    // a silent 100x error in any dashboard built on them.
    expect(
      performanceMetricsSchema.safeParse({ ...FULL_METRICS, clickThroughRate: 100 }).success,
    ).toBe(true);
    expect(
      performanceMetricsSchema.safeParse({ ...FULL_METRICS, clickThroughRate: 100.5 }).success,
    ).toBe(false);
    expect(performanceMetricsSchema.safeParse({ ...FULL_METRICS, retentionRate: 1 }).success).toBe(
      true,
    );
    expect(performanceMetricsSchema.safeParse({ ...FULL_METRICS, retentionRate: 42 }).success).toBe(
      false,
    );
  });
});

describe("payload schemas in general", () => {
  const schemas = {
    systemInitialized: systemInitializedPayloadSchema,
    configurationLoaded: configurationLoadedPayloadSchema,
    agentExecutionStarted: agentExecutionStartedPayloadSchema,
    agentExecutionCompleted: agentExecutionCompletedPayloadSchema,
    agentExecutionFailed: agentExecutionFailedPayloadSchema,
    characterCreated: characterCreatedPayloadSchema,
    characterExperienceRecorded: characterExperienceRecordedPayloadSchema,
    audienceCommentReceived: audienceCommentReceivedPayloadSchema,
    audienceDmReceived: audienceDmReceivedPayloadSchema,
    audienceRequestDetected: audienceRequestDetectedPayloadSchema,
    contentProductionRequested: contentProductionRequestedPayloadSchema,
    contentProductionStarted: contentProductionStartedPayloadSchema,
    contentProductionCompleted: contentProductionCompletedPayloadSchema,
    publishingJobCreated: publishingJobCreatedPayloadSchema,
    publishingJobCompleted: publishingJobCompletedPayloadSchema,
    analyticsPerformanceRecorded: analyticsPerformanceRecordedPayloadSchema,
  } as const;

  it("rejects a non-object payload for every event type", () => {
    // Payloads are JSON objects on the wire; accepting a string or an array here would
    // let a producer's serialization bug reach consumers as a runtime property error.
    for (const [name, schema] of Object.entries(schemas)) {
      for (const invalid of [null, undefined, "text", 42, []]) {
        expect(schema.safeParse(invalid).success, `${name} accepted ${String(invalid)}`).toBe(
          false,
        );
      }
    }
  });
});
