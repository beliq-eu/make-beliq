# Changelog

A version is what one deploy puts into the app on Make. `base.json` sends it in the
`User-Agent` header as `make-beliq/<version>`, and a test checks that the two agree. Make
numbers the app itself as version 1; that number changes only with a breaking change to the
app, and is not this one.

## 0.3.0

- The app's description on Make reads "Validate and parse e-invoices with beliq." Deploy this
  version only once Parse and Make an API call are published: a deploy shows the description
  to every organisation that installed the app at once.
- `blueprints/validate-and-parse.json` is an example scenario: it downloads the two test
  invoices the live gate sends, validates both, parses the PDF and calls `GET /v1/me`. It was
  exported from a scenario that ran in Make, with the connection and every other ID of the
  exporting organisation removed. `test/blueprint.test.mjs` checks it against the app's
  modules and fields and against `test/fixtures.json`.

## 0.2.0

- **Parse an e-invoice** sends an XML or PDF file as the request body to `POST /v1/parse`.
  Its output holds each key of the answer's `data` under its own name: `format`,
  `profileDetected`, `profileUrn`, `businessProcessId`, `franceCtcDetected`, `invoice` with
  its parties, lines, delivery and totals, and `warnings`, which names what the answer does
  not return. Beside them: the whole `data` object, and `requestId` from the `x-request-id`
  header. Its interface is written by `scripts/parse-interface.mjs` from the API's
  `openapi.json`, and CI fails when the two drift apart. No field gets a default: a field
  that was not read from the document stays empty, and `warnings` says which ones beliq
  does not return. The module checks nothing and gives no verdict.
- **Make an API call** sends a request to a path relative to `https://api.beliq.eu`, with
  the connection's API key, the method, headers, query string and body the user enters.
  Its output holds the answer's `body`, `headers` and `statusCode`.
- The app's description on Make stays "Validate e-invoices with beliq." until Parse is
  published, since a deploy shows it to every organisation that installed the app.

## 0.1.0

- The connection: an API key, tested with `GET /v1/me`, which spends no quota.
- **Validate an e-invoice** sends an XML or PDF file as the request body to `POST
  /v1/validate`. Its output holds `verdict`, with `valid`, `verificationBadge` and
  `verificationBadgeLabel` together, so the verdict is never shown without the depth of
  its check. Beside it:
  `format`, `rulesetSha256`, `errors`, `warnings`, the whole `data` object as the API sent
  it, and `requestId` from the `x-request-id` header.
