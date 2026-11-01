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

export const VERSION_SORTS = ["asc", "desc"] as const;

/** Format types a version may offer. */
export const FORMAT_TYPES = ["html", "pdf", "xml", "pdf_original_scan"] as const;

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
