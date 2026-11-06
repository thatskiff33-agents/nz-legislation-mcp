/**
 * Single source of truth for every controlled vocabulary in the NZ Legislation API (v0).
 *
 * Everything else (input schemas, tool descriptions, docs tables, contract-test drift checks)
 * derives from these arrays. Values are copied exactly from https://api.legislation.govt.nz/docs/
 * and confirmed against live responses on 2 Nov 2026 (see docs/api-notes.md).
 */

// ---------------------------------------------------------------------------
// Search filter vocabularies (query-string values use underscores)
// ---------------------------------------------------------------------------

export const LEGISLATION_TYPES = [
  "act",
  "bill",
  "secondary_legislation",
  "amendment_paper",
] as const;
export type LegislationType = (typeof LEGISLATION_TYPES)[number];

export const LEGISLATION_STATUSES = ["in_force", "not_in_force", "no_value"] as const;

export const SEARCH_FIELDS = ["title", "content"] as const;

export const SORT_ORDERS = [
  "title_asc",
  "title_desc",
  "year_asc",
  "year_desc",
  "most_recently_updated",
] as const;

export const PUBLISHERS = ["Agency", "Parliamentary Counsel Office"] as const;

export const ACT_TYPES = ["public", "private", "imperial", "local", "provincial"] as const;
export const ACT_STATUSES = ["in_force", "not_in_force", "repealed"] as const;
export const CLASSIFICATIONS = ["principal", "amendment"] as const;

export const INSTRUMENT_TYPE_GROUPS = [
  "regulations",
  "order",
  "rules",
  "code",
  "bylaws",
  "determination",
  "exemption",
  "notice",
  "instrument",
  "other_type",
] as const;
export const INSTRUMENT_STATUSES = [
  "expired",
  "in_force",
  "not_yet_in_force",
  "revoked",
  "superseded",
] as const;

export const BILL_TYPES = ["government", "local", "member", "private"] as const;
export const BILL_STATUSES = ["current", "enacted", "terminated"] as const;

/**
 * "a, b, c or d", for descriptions built from a vocabulary.
 *
 * Used by descriptions in src/domain and src/tools.
 */
export function orList(values: readonly string[]): string {
  return values.length < 2
    ? values.join("")
    : `${values.slice(0, -1).join(", ")} or ${String(values.at(-1))}`;
}

// ---------------------------------------------------------------------------
// Groups derived from the vocabularies above (`satisfies` makes a typo a compile error)
// ---------------------------------------------------------------------------

type Status =
  | (typeof ACT_STATUSES)[number]
  | (typeof INSTRUMENT_STATUSES)[number]
  | (typeof BILL_STATUSES)[number];

/** Legislation types whose versions are parliamentary stages rather than law in force. */
export const STAGE_TYPES = [
  "bill",
  "amendment_paper",
] as const satisfies readonly LegislationType[];

/** Type-specific statuses meaning the work has ended (repealed, revoked and so on). */
export const ENDED_STATUSES = [
  "repealed",
  "revoked",
  "expired",
  "superseded",
  "terminated",
] as const satisfies readonly Status[];

/** The publisher value that marks a record drafted and published by an agency (pilot). */
export const AGENCY_PUBLISHER = "Agency" satisfies (typeof PUBLISHERS)[number];

// ---------------------------------------------------------------------------
// API limits (https://api.legislation.govt.nz/docs/ and docs/api-notes.md)
// ---------------------------------------------------------------------------

export const API_LIMITS = {
  /** Requests per key per day by default; resets at midnight New Zealand time. */
  dailyRequests: 10_000,
  /** Requests per IP address in each burst window (403 when exceeded); not reported by the API. */
  burstRequests: 2_000,
  burstMinutes: 5,
  /** Largest page size the API accepts. */
  maxPerPage: 100,
  /** Page size the API uses when none is given. */
  defaultPerPage: 20,
} as const;

export const VERSION_SORTS = ["asc", "desc"] as const;

// ---------------------------------------------------------------------------
// Which type-specific filters belong to which legislation type
// ---------------------------------------------------------------------------

/**
 * Filters that the API only honours for one legislation type. The API silently ignores
 * mismatched filters (returning zero results), so we reject them up front.
 */
export const TYPE_SPECIFIC_FILTERS = {
  act: ["act_type", "act_status", "act_classification"],
  bill: ["bill_type", "bill_status"],
  secondary_legislation: [
    "instrument_type_group",
    "instrument_status",
    "instrument_classification",
  ],
  amendment_paper: [],
} as const satisfies Record<LegislationType, readonly string[]>;

/** Legislation types that can have publisher "Agency" (per the OpenAPI spec; confirmed live). */
export const AGENCY_PUBLISHED_TYPES = [
  "secondary_legislation",
] as const satisfies readonly LegislationType[];

// ---------------------------------------------------------------------------
// Identifier vocabularies (identifiers use hyphens and different subtype spellings)
// ---------------------------------------------------------------------------

/** Identifier `type` segment for each filter value. */
export const ID_TYPE_BY_LEGISLATION_TYPE = {
  act: "act",
  bill: "bill",
  secondary_legislation: "secondary-legislation",
  amendment_paper: "amendment-paper",
} as const satisfies Record<LegislationType, string>;

export type IdType = (typeof ID_TYPE_BY_LEGISLATION_TYPE)[LegislationType];

/** Allowed identifier `subtype` segments per identifier type. Note `members`, not `member`. */
export const ID_SUBTYPES = {
  act: ACT_TYPES,
  bill: ["government", "local", "members", "private"],
  "secondary-legislation": ["agency-drafted", "pco-drafted"],
  "amendment-paper": ["government", "members"],
} as const satisfies Record<IdType, readonly string[]>;

/** The only language the API currently publishes. */
export const ID_LANGUAGE = "en";

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

/** The API host. The only host that ever receives the API key. */
export const API_ORIGIN = "https://api.legislation.govt.nz";

/** Public website host serving HTML, PDF and XML formats. Never receives the API key. */
export const WEBSITE_ORIGIN = "https://www.legislation.govt.nz";
