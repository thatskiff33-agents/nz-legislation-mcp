# Legislation API notes

Facts the design relies on, with their sources and as-at dates. Update this file whenever the API or the terms change.

- **API version:** v0. The developer page calls it "a version 0 beta" and says "Feedback from your real-world use of version 0 will directly shape version 1". The API documentation calls it "Version Zero". Expect breaking changes.
- **Live probe date:** 2 November 2026, using the owner's key. The saved probe made 19 requests to the API (18 with the owner's key, 1 without a key) and 1 XML download. The last saved response headers (file 09, the 15th request) showed 9,993 of 10,000 requests remaining; headers for the 4 later search requests were not saved.
- **Fixtures:** `test/fixtures/api/` holds responses from that probe (searches by type, version lists and records, and errors). They contain public API data only, with no keys or personal information.
- **Key format:** not recorded. The probe kept the key out of every saved file, so its character set and length are unknown here. `KEY_CHARSET` in `src/config.ts` therefore stays broad (printable ASCII without spaces, quotes or backslashes) until PCO's format is known.

## Terms of use (read 2 Nov 2026, unchanged on 6 Nov 2026)

Source: <https://www.legislation.govt.nz/learn-more/legislation-data/api-terms-of-use/>. The page answers 403 to some automated clients. On 6 November 2026 clauses 1 to 27 were word-for-word the same as the copy read on 2 November.

| Clause        | What it says (summary)                                                                                                                                                                                                                                                                                                                                                                 | Design consequence                                                                                                                                                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4 to 6        | A key is linked to the holder's name and email address. Keys are requested by email to contact@pco.govt.nz (clause 5). The key must be kept "secure and confidential" and must not be shared with, or used by, "any person or organisation other than you" (clause 6).                                                                                                                 | Every user supplies their own key. A self-hosted remote endpoint must only serve the key holder: OAuth (#22) admits only the accounts the operator lists in `LEGISLATION_NZ_OAUTH_ALLOWED_SUBJECTS`, so the operator must list only themselves. We never ship, embed or proxy a shared key. |
| 8             | Agency-published secondary legislation records come from a pilot and "may be inaccurate or incomplete".                                                                                                                                                                                                                                                                                | Tools flag records where `publisher` is `Agency`.                                                                                                                                                                                                                                           |
| 9             | API information is not legal advice.                                                                                                                                                                                                                                                                                                                                                   | Disclaimer in README and server instructions.                                                                                                                                                                                                                                               |
| 10 to 12      | No copyright in NZ legislation (Copyright Act 1994, s 27, as stated in clause 10). The Crown asserts no copyright over the data compilation, and it may be reproduced free of charge. Logos, emblems, trademarks or other copyright material may be reproduced free of charge, subject to any restrictions in that material, if reproduced accurately and not in a misleading context. | No copyright barrier to returning legislation text. Works incorporated by reference, and logos or other copyright material, may carry their own restrictions.                                                                                                                               |
| 13 and 16     | Do not interfere with the API or unreasonably affect other users. PCO may restrict unreasonable use.                                                                                                                                                                                                                                                                                   | Client-side validation, no retry storms, request coalescing, sensible paging.                                                                                                                                                                                                               |
| 14 and 15     | 10,000 requests per key per day (reset at midnight NZ time). 2,000 requests per IP per 5 minutes. A higher limit for a key can be requested from PCO.                                                                                                                                                                                                                                  | Distinct handling of 429 (daily quota) and 403 (IP burst), and quota reporting.                                                                                                                                                                                                             |
| 18, 23 and 25 | The API may be unavailable from time to time. PCO may end the API for everyone or for one user at any time, and may change the terms at any time.                                                                                                                                                                                                                                      | Contract tests and nightly drift checks.                                                                                                                                                                                                                                                    |

**Caching: open question.** The terms do not mention caching (the owner checked clauses 1 to 27 of the live terms on 7 November 2026). Clause 11 allows reproduction of the data, but whether temporary caching is acceptable is not confirmed. The owner emailed the question to PCO on 7 November 2026, and no reply had been received as at 7 November 2026 (tracked in #3). Owner decision: response caching ships disabled by default until PCO confirms in writing that it is allowed.

## Endpoints (observed)

Base `https://api.legislation.govt.nz`. Authentication is the `X-Api-Key` header (the spec also documents an `api_key` query parameter; it was not tested and we never use it).

| Endpoint                                                 | Observed behaviour                                                                                                                                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v0/works/`                                         | Search. `page`, `per_page` (max 100). Response `{results, page, per_page, total}`.                                                                                                                               |
| `GET /v0/works/{work_id}/versions/`                      | Version history. Paging works with `page` and `per_page=100` (undocumented). `sort=asc` and `sort=desc` both work. The Income Tax Act 2007 had 206 versions on 2 Nov 2026.                                       |
| `GET /v0/versions/{version_id}/`                         | One version's metadata and format links.                                                                                                                                                                         |
| `/api/rss/search/`, `/api/rss/works/{work_id}/versions/` | Listed in the OpenAPI spec, but `/api/rss/search/` returned 404 with the owner's key on 2 Nov 2026. Out of scope.                                                                                                |
| OpenAPI spec                                             | OpenAPI 3.0.1, embedded in the docs page (the Download link is generated in the browser and has no fixed URL). Snapshot of 2 Nov 2026 in `spec/legislation-api-v0.openapi.json`. All enums match our vocabulary. |

## Behaviour that differs from, or is missing in, the docs

- **Invalid filter values are silently ignored.** For example, `legislation_type=nonsense` returns `200` with `total: 0` instead of an error. We must validate every filter on our side, or the model will think no legislation exists.
- **`publisher` appears in search results** but not in the documented response (it is documented only as a filter). It was `null` for Acts and populated for secondary legislation.
- **The versions list returns fewer fields than documented.** For an Act (`act_public_2007_97`), items omit `act_classification`, which the spec lists. Schemas must treat these fields as optional.
- **`page` and `per_page` work on the versions endpoint** and appear in its response, but the spec lists only `sort` as a request parameter.
- **Same-day version suffixes:** for example `act_public_2007_97_en_2025-05-29B`. Across all 206 versions of the Income Tax Act 2007 (checked 2 Nov 2026) only one date has two versions. A version list produced on 2 Nov 2026 placed `2008-04-01B` before `2008-04-01` in newest-first order; this was not captured in a raw API response. The server therefore treats the highest suffix as the last version of that day. **To confirm with PCO.** Most `B` versions have no unsuffixed sibling.
- **The latest version's format links use the `/latest/` alias,** for example `.../2007/97/en/latest.xml`. Historical versions use dated links, for example `.../2010-04-01.xml`. To cite a fixed version, build the dated URL from the `version_id`.
- `pdf_original_scan` links point to `.../{date}/official_scan.pdf`.

## Errors (observed)

| Status | Body                                    | Meaning                                                                                                                                                                                                                                                           |
| ------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401    | `{"error":"API key is required"}`       | Missing key (observed). Invalid key (per the docs, not tested).                                                                                                                                                                                                   |
| 404    | `{"error":"404","message":"Not Found"}` | Unknown version, or a path the API does not serve. Content-Type has no charset. An unknown-version request used quota (9,997 before it, 9,995 at the next request). The `/api/rss/search/` 404, and six spec-path requests whose status was not saved, used none. |
| 429    | not triggered                           | Daily quota exhausted (per docs).                                                                                                                                                                                                                                 |
| 403    | not triggered                           | Per-IP burst limit (per docs).                                                                                                                                                                                                                                    |

## Response headers

- `x-ratelimit-limit: 10000`, `x-ratelimit-remaining`, and `x-ratelimit-reset` (a Unix timestamp; midnight NZ time). These are present on 200 responses but were not seen on 401 or 404.
- `cache-control: max-age=0, private, must-revalidate`, and a weak `etag`. Served through nginx behind CloudFront. HSTS is enabled.

## Legislation text (XML)

- XML, HTML and PDF formats are served from `https://www.legislation.govt.nz`. **No API key is needed, so the key is never sent there.** The key goes only to `api.legislation.govt.nz`.
- **Documents are large.** The Income Tax Act 2007, as at 2010-04-01, is 15.2 MB (15,214,525 bytes) of XML. The XML pipeline must stream, enforce byte caps, and not build a full DOM.
- The root element (for example `<act>`) carries useful attributes: `date.as.at`, `date.assent`, `stage`, `act.type`, `year`, `act.no`.
- Provision elements (`<prov>`) carry `DLM` ids, for example `DLM1512304`; the Act's root element is `DLM1512300`. The parser records these ids, but no tool uses them yet. Whether they stay stable across versions is to confirm with PCO.
- `robots.txt` disallows `/items/` and query-string URLs. Format URLs have neither.

## Rate-limit budget per tool call (targets)

- Search: 1 request.
- Get a version: 1 request.
- Full version history: ceil(total / 100) requests. That is 3 for the Income Tax Act 2007.
- Provision text: 1 API request plus 1 XML download. The XML download does not count against the API key quota.

## Sources

- <https://www.legislation.govt.nz/learn-more/legislation-data/api-terms-of-use/>: terms of use, clauses 1 to 27 (read 2 and 6 November 2026).
- <https://www.legislation.govt.nz/developer-api/>: "version 0 beta", key requests by email to contact@pco.govt.nz, and the encouragement to migrate from classic site web feeds (read 6 November 2026).
- <https://www.legislation.govt.nz/learn-more/find-and-use-legislation/keep-up-to-date-with-legislation/>: classic site web feeds are served from classic.legislation.govt.nz (read 6 November 2026).
- <https://api.legislation.govt.nz/docs/>: the API documentation and embedded OpenAPI specification, snapshot in `spec/legislation-api-v0.openapi.json` (2 November 2026).
- The live probe of 2 November 2026: response bodies and headers, kept as fixtures in `test/fixtures/api/`.
