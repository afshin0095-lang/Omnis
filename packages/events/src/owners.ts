/**
 * Who owns each event namespace.
 *
 * This lives in its own module because both the Sprint 0 definitions and the AI
 * Core definitions need it, and a definition module that imported the other for
 * one constant would be a cycle waiting to be evaluated in the wrong order.
 *
 * Ownership is not decoration: when a malformed event appears in the stream, or
 * a payload needs a breaking change, `owner` is how the platform finds who has
 * the authority to decide. These are the logical service names that will appear
 * in `source` and `owner` once the services exist, declared before code is
 * written against them so the map is fixed rather than negotiated later.
 */

import { parseTrimmedString } from "@omnis/types";

/** Logical service names owning each event namespace. */
export const EVENT_OWNERS = {
  platform: parseTrimmedString("omnis.platform"),
  aiCore: parseTrimmedString("ai-core"),
  characterOs: parseTrimmedString("character-os"),
  audienceIntelligence: parseTrimmedString("audience-intelligence"),
  contentStrategy: parseTrimmedString("content-strategy"),
  contentFactory: parseTrimmedString("content-factory"),
  publishing: parseTrimmedString("publishing"),
  analytics: parseTrimmedString("analytics"),
} as const;
