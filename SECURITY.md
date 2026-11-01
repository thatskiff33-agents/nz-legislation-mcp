# Security policy

## Supported versions

Only the latest minor release receives security fixes until v1.0.0. After v1.0.0, the latest major version is supported.

## Reporting a vulnerability

Please report vulnerabilities privately using GitHub's
[private vulnerability reporting](https://github.com/thatskiff33-agents/nz-legislation-mcp/security/advisories/new).
Do not open a public issue.

Include what you found, how to reproduce it, and the impact you expect. We aim to acknowledge reports within 5 New Zealand business days and to agree a disclosure timeline with you.

## Scope

In scope:

* Leaks of a user's Legislation API key (logs, errors, tool output, URLs, outbound requests to non-PCO hosts).
* Authentication or authorisation flaws in the HTTP transport.
* Injection or parsing flaws (for example XML entity expansion, server-side request forgery).
* Supply-chain issues in our build and release pipeline.

Out of scope:

* The PCO Legislation API itself. Report those to the Parliamentary Counsel Office.
* Content of legislation returned by the API.

## Handling of API keys

This server never needs your key in a URL, never logs it, and only sends it to `api.legislation.govt.nz` and `www.legislation.govt.nz`. If you believe your key has been exposed, ask the PCO to rotate it.
