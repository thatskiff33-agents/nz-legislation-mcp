# Security policy

## Supported versions

Security fixes go into the latest release of the current major version, 1.x. The first published release is 1.0.1 (1.0.0 was tagged but never published).

## Reporting a vulnerability

Please report vulnerabilities privately using GitHub's
[private vulnerability reporting](https://github.com/thatskiff33/nz-legislation-mcp/security/advisories/new).
Do not open a public issue.

Include what you found, how to reproduce it, and the impact you expect. We aim to acknowledge reports promptly, normally within 5 New Zealand working days, and to agree a disclosure timeline with you.

## Scope

In scope:

- Leaks of a user's Legislation API key (logs, errors, tool output, URLs, outbound requests to hosts other than the PCO's).
- Authentication or authorisation flaws in the HTTP transport (remote mode with OAuth, and local mode without it).
- Injection or parsing flaws (for example XML entity expansion, server-side request forgery).
- Supply-chain issues in our build and release pipeline.

Out of scope:

- The PCO Legislation API itself. Report those to the Parliamentary Counsel Office.
- Content of legislation returned by the API.

## Handling of API keys (design commitments)

The server never puts your key in a URL, never logs it or returns it in output, and sends it only to `api.legislation.govt.nz`, as the `X-Api-Key` header. Automated tests check these commitments: the key is redacted from log records and error messages in every common encoded form, it never appears in tool error output or in requests to `www.legislation.govt.nz`, and requests to the Legislation API and website go only to those fixed hosts, with redirects refused.

If you believe your key has been exposed, contact the Parliamentary Counsel Office to have it revoked or replaced.
