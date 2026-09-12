/**
 * The controlled vocabulary of external distribution platforms.
 *
 * WHY this lives in `@omnis/types`
 * --------------------------------
 * Platform identity is referenced by Audience Intelligence (where did this
 * comment come from?), Publishing (where does this job go?), Analytics (which
 * channel produced this metric?) and Security (which OAuth scope set applies?).
 * A vocabulary shared by four domains must be declared once, below all of them,
 * or each domain invents its own string set and they drift.
 *
 * This is a *vocabulary*, not domain logic: it contains no behaviour, no
 * adapter, no SDK reference and no platform-specific rules. That keeps
 * `@omnis/types` domain-light (see DEPENDENCY_RULES.md) while still removing the
 * duplication. Every platform-specific behaviour lives behind a provider adapter
 * in the owning service.
 *
 * EXTENDING: adding a platform is additive and non-breaking. Removing or
 * renaming one is a breaking contract change and requires an ADR, because
 * persisted events already carry these values.
 */

/** Platforms OMNIS is designed to publish to and ingest signals from. */
export const SOCIAL_PLATFORMS = ["youtube", "instagram", "tiktok", "facebook", "x"] as const;

/** One member of {@link SOCIAL_PLATFORMS}. */
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

/**
 * Platforms that are architected for but not yet wired to an adapter.
 *
 * Declared separately so a future integration is an additive change to
 * {@link SOCIAL_PLATFORMS} plus an adapter, not a migration of every consumer's
 * type guards.
 */
export const PLANNED_SOCIAL_PLATFORMS = ["linkedin", "threads", "twitch", "reddit"] as const;

/** One member of {@link PLANNED_SOCIAL_PLATFORMS}. */
export type PlannedSocialPlatform = (typeof PLANNED_SOCIAL_PLATFORMS)[number];

/** Human-readable platform names for logs and the Studio UI. */
export const SOCIAL_PLATFORM_LABELS: Readonly<Record<SocialPlatform, string>> = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
  facebook: "Facebook",
  x: "X",
};

/** Type guard for a supported platform identifier. */
export function isSocialPlatform(value: unknown): value is SocialPlatform {
  return typeof value === "string" && (SOCIAL_PLATFORMS as readonly string[]).includes(value);
}

/**
 * Normalises loosely-typed inbound platform names.
 *
 * Platform APIs, webhooks and CSV exports are inconsistent about casing and
 * legacy naming (`"twitter"` for X, `"YouTube.com"` from a spreadsheet). Mapping
 * happens once, at the ingestion boundary, so no downstream code has to defend
 * against it.
 *
 * Returns `null` for anything unrecognised rather than guessing: an
 * unattributable signal must not be silently assigned to the wrong platform,
 * because that corrupts analytics and can cause publishing to the wrong account.
 */
export function normaliseSocialPlatform(value: unknown): SocialPlatform | null {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.trim().toLowerCase();
  // Spreadsheet exports and webhook payloads frequently carry the platform's domain
  // rather than its name ("YouTube.com", "www.tiktok.com", "x.com"). The suffix is
  // stripped *before* punctuation is removed: stripping punctuation first turns
  // "youtube.com" into "youtubecom", which then matches nothing at all.
  const withoutDomain = cleaned
    .replace(/^www\./, "")
    .replace(/\.(?:com|net|org|tv|me|app|co\.uk)$/, "");
  const canonical = withoutDomain.replace(/[^a-z0-9]/g, "");
  switch (canonical) {
    case "youtube":
    case "yt":
      return "youtube";
    case "instagram":
    case "ig":
      return "instagram";
    case "tiktok":
      return "tiktok";
    case "facebook":
    case "fb":
    case "meta":
      return "facebook";
    case "x":
    case "twitter":
      return "x";
    default:
      return null;
  }
}
