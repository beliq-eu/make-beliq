# Changelog

A version is what one deploy puts into the app on Make. `base.json` sends it in the
`User-Agent` header as `make-beliq/<version>`, and a test checks that the two agree. Make
numbers the app itself as version 1; that number changes only with a breaking change to the
app, and is not this one.

## 0.1.0

- The connection: an API key, tested with `GET /v1/me`, which spends no quota.
- **Validate an e-invoice** sends an XML or PDF file as the request body to `POST
  /v1/validate`. Its output holds `verdict`, with `valid`, `verificationBadge` and
  `verificationBadgeLabel` together, so the verdict is never shown without the depth of
  its check. Beside it:
  `format`, `rulesetSha256`, `errors`, `warnings`, the whole `data` object as the API sent
  it, and `requestId` from the `x-request-id` header.
