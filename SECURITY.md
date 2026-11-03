# Security policy

## Supported versions

No releases have been published yet. From the first release until v1.0.0, only the latest minor release receives security fixes. After v1.0.0, the latest major version is supported.

## Reporting a vulnerability

Please report vulnerabilities privately using GitHub's
[private vulnerability reporting](https://github.com/thatskiff33/nz-legislation-mcp/security/advisories/new).
Do not open a public issue.

Include what you found, how to reproduce it, and the impact you expect. We aim to acknowledge reports promptly, normally within 5 New Zealand working days, and to agree a disclosure timeline with you.

## Scope

In scope:

- Leaks of a user's Legislation API key (logs, errors, tool output, URLs, outbound requests to hosts other than the PCO's).
- Authentication or authorisation flaws in the HTTP transport (once implemented, issue #8).
- Injection or parsing flaws (for example XML entity expansion, server-side request forgery).
- Supply-chain issues in our build and release pipeline.

Out of scope:

- The PCO Legislation API itself. Report those to the Parliamentary Counsel Office.
- Content of legislation returned by the API.

## Handling of API keys (design commitments)

The server is being built so that it never puts your key in a URL, never logs it or returns it in output, and only sends it to the Parliamentary Counsel Office's own hosts. Automated tests will enforce these commitments as the code lands.

If you believe your key has been exposed, contact the Parliamentary Counsel Office to have it revoked or replaced.
