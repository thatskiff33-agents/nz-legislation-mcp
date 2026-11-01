/**
 * Parsing, formatting and URL building for Legislation API identifiers.
 *
 *   work_id    = {type}_{subtype}_{year}_{number}                 e.g. act_public_2007_97
 *   version_id = {work_id}_{language}_{date}{suffix}              e.g. act_public_2007_97_en_2025-05-29B
 *
 * Segments never contain underscores, so `_` is a safe separator. Agency-harvested records
 * carry a `~` prefix on year, number and/or date: those values are provisional and may change.
 */
import {
  ID_LANGUAGE,
  ID_SUBTYPES,
  ID_TYPE_BY_LEGISLATION_TYPE,
  WEBSITE_ORIGIN,
  type IdType,
} from "./vocabulary.js";

/** Upper bound on identifier length; real identifiers are well under 80 characters. */
export const MAX_ID_LENGTH = 120;

const ID_TYPES = Object.values(ID_TYPE_BY_LEGISLATION_TYPE);

// Segment grammars (ASCII only). Number: digits, optional capital letter, optional hyphen and
// short capital/digit tail (docs example "96-B"). Date: ISO date plus up to 8 capital letters
// distinguishing several versions on one day (docs: "one or more letters").
const YEAR_RE = /^~?\d{4}$/;
const NUMBER_RE = /^~?\d{1,7}[A-Z]?(?:-[A-Z0-9]{1,4})?$/;
const DATE_RE = /^~?\d{4}-\d{2}-\d{2}[A-Z]{0,8}$/;

/** Brand: only this module's parsers can produce a WorkId or VersionId. */
declare const parsed: unique symbol;

export interface WorkId {
  readonly [parsed]: true;
  readonly type: IdType;
  readonly subtype: string;
  /** Year segment as published, including any `~` prefix. */
  readonly year: string;
  /** Number segment as published, including any `~` prefix. */
  readonly number: string;
  /** True when any segment is a provisional (`~`) value that may change. */
  readonly provisional: boolean;
}

export interface VersionId {
  readonly [parsed]: true;
  readonly work: WorkId;
  readonly language: typeof ID_LANGUAGE;
  /** Calendar date of the version (YYYY-MM-DD), without `~` or suffix. */
  readonly date: string;
  /** Letters distinguishing several versions on the same date, e.g. `B`. Empty if none. */
  readonly suffix: string;
  /** True when the date segment itself carries a `~` (provisional) prefix. */
  readonly dateProvisional: boolean;
  /** True when the work or the date segment is provisional. */
  readonly provisional: boolean;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function isIdType(value: string): value is IdType {
  return (ID_TYPES as readonly string[]).includes(value);
}

function isRealDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function parseWorkSegments(segments: readonly string[], raw: string): ParseResult<WorkId> {
  const [type, subtype, year, number] = segments;
  if (segments.length !== 4 || type === undefined || subtype === undefined) {
    return fail(
      `${JSON.stringify(raw)} is not a work_id. Expected {type}_{subtype}_{year}_{number}, e.g. act_public_2007_97.`,
    );
  }
  if (!isIdType(type)) {
    return fail(`Unknown type ${JSON.stringify(type)}. Expected one of: ${ID_TYPES.join(", ")}.`);
  }
  const subtypes: readonly string[] = ID_SUBTYPES[type];
  if (!subtypes.includes(subtype)) {
    return fail(
      `Unknown subtype ${JSON.stringify(subtype)} for ${type}. Expected one of: ${subtypes.join(", ")}.`,
    );
  }
  if (year === undefined || !YEAR_RE.test(year)) {
    return fail(`Invalid year segment ${JSON.stringify(year)}. Expected four digits, e.g. 2007.`);
  }
  if (number === undefined || !NUMBER_RE.test(number)) {
    return fail(`Invalid number segment ${JSON.stringify(number)}. Expected digits, e.g. 97.`);
  }
  const value = {
    type,
    subtype,
    year,
    number,
    provisional: year.startsWith("~") || number.startsWith("~"),
  };
  return { ok: true, value: value as WorkId };
}

/** Parses a `work_id`. Never throws. */
export function parseWorkId(input: string): ParseResult<WorkId> {
  if (input.length === 0 || input.length > MAX_ID_LENGTH) {
    return fail(`work_id must be 1 to ${String(MAX_ID_LENGTH)} characters.`);
  }
  return parseWorkSegments(input.split("_"), input);
}

/** Parses a `version_id`. Never throws. */
export function parseVersionId(input: string): ParseResult<VersionId> {
  if (input.length === 0 || input.length > MAX_ID_LENGTH) {
    return fail(`version_id must be 1 to ${String(MAX_ID_LENGTH)} characters.`);
  }
  const segments = input.split("_");
  const dateSegment = segments[5];
  if (segments.length !== 6 || dateSegment === undefined) {
    return fail(
      `${JSON.stringify(input)} is not a version_id. Expected {work_id}_en_{YYYY-MM-DD}, e.g. act_public_2007_97_en_2025-05-29.`,
    );
  }
  const work = parseWorkSegments(segments.slice(0, 4), segments.slice(0, 4).join("_"));
  if (!work.ok) return work;

  const language = segments[4];
  if (language !== ID_LANGUAGE) {
    return fail(
      `Unsupported language ${JSON.stringify(language)}. Only "${ID_LANGUAGE}" is published.`,
    );
  }
  if (!DATE_RE.test(dateSegment)) {
    return fail(
      `Invalid version date ${JSON.stringify(dateSegment)}. Expected YYYY-MM-DD, e.g. 2025-05-29.`,
    );
  }
  // Grammar is validated above: optional "~", ten-character date, then 0-3 suffix letters.
  const tilde = dateSegment.startsWith("~");
  const body = tilde ? dateSegment.slice(1) : dateSegment;
  const date = body.slice(0, 10);
  const suffix = body.slice(10);
  if (!isRealDate(Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10)))) {
    return fail(`"${date}" is not a real calendar date.`);
  }
  const value = {
    work: work.value,
    language: ID_LANGUAGE,
    date,
    suffix,
    dateProvisional: tilde,
    provisional: work.value.provisional || tilde,
  };
  return { ok: true, value: value as VersionId };
}

/** Formats a work identifier. Inverse of {@link parseWorkId}. */
export function formatWorkId(work: WorkId): string {
  return [work.type, work.subtype, work.year, work.number].join("_");
}

/** Formats a version identifier. Exact inverse of {@link parseVersionId}. */
export function formatVersionId(version: VersionId): string {
  const date = `${version.dateProvisional ? "~" : ""}${version.date}${version.suffix}`;
  return [formatWorkId(version.work), version.language, date].join("_");
}

/**
 * Website formats we can build URLs for. `pdf_original_scan` (pre-2008 as-enacted scans) is
 * deliberately excluded: use the link the API returns for it.
 */
export type WebsiteFormat = "html" | "pdf" | "xml";

/**
 * Builds the canonical, dated legislation.govt.nz URL for a version and format.
 * Returns `undefined` for provisional (agency-harvested) identifiers, whose documents live on
 * agency websites under other URL patterns: use the links the API returns for those.
 */
export function websiteUrl(version: VersionId, format: WebsiteFormat): string | undefined {
  if (version.provisional) return undefined;
  const { type, subtype, year, number } = version.work;
  const base = `${WEBSITE_ORIGIN}/${type}/${subtype}/${year}/${number}/${version.language}/${version.date}${version.suffix}`;
  return format === "html" ? `${base}/` : `${base}.${format}`;
}
