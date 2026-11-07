# make-beliq

The [beliq](https://beliq.eu) app for [Make](https://www.make.com): validate an EU e-invoice in a Make scenario, and get back the verdict with the depth of its check.

The app is not listed in Make's app directory and has not been through Make's app review.

## Connect your account

Create a **beliq API key** at [dashboard.beliq.eu](https://dashboard.beliq.eu) (API Keys) and paste it into the connection's **API key** field. Make tests the connection with `GET /v1/me`, which spends no quota.

## Validate an e-invoice

The module sends the file you map, an XML invoice or a PDF with the invoice XML embedded, as the body of [`POST /v1/validate`](https://docs.beliq.eu/api-reference/validate/). It sends nothing else: no format, no ruleset, no default of its own. beliq detects the format from the file.

Its output:

- **Verdict**: `valid`, `verificationBadge` and `verificationBadgeLabel` in one collection. The badge says how deep the check of this format goes, as [How verification works](https://docs.beliq.eu/compliance/how-verification-works/) explains, so keep it with `valid` wherever you pass the verdict on. Filter or route on `verificationBadge`, the stable code; `verificationBadgeLabel` is the English text to show. `valid` means the file passed the rule packs and schemas beliq lists for its format, in the stated versions, and no more than that.
- **Format**, **Ruleset SHA-256**, **Errors** and **Warnings**, as the API sent them.
- **Full response data**: the API's whole `data` object, with the rule packs and their versions in `rulesetArtifacts`.
- **Request ID**: the `x-request-id` header, for a support question about one call.

## Layout

`app/` holds one JSON file for each section Make stores: `app.json`, `base.json` (the base URL `https://api.beliq.eu`, the API key header, and a `User-Agent` of `make-beliq/<version>`), `groups.json`, `connection/`, and one folder for each module. `app/icon.svg` is the source of `app/icon.png`: Make keeps only the shape of the icon's opaque pixels, draws it in white and puts it on the theme colour from `app.json`.

## Tests

```bash
node --test test/iml.test.mjs test/app.test.mjs test/live-gate.test.mjs test/deploy.test.mjs
bash scripts/scrub-check.sh
```

These need no network. They check that each module's output, interface and samples name the same fields, that every template in a request or an output is a plain path lookup, the vendored fixtures' checksums, and the deploy script against a local server that answers like Make's API.

The live gate sends the requests the app's files describe to the live API and checks the answers against [the API's openapi.json](https://api.beliq.eu/openapi.json). It runs in CI on a push to `main`, and needs a test key:

```bash
BELIQ_API_KEY=blq_test_... node scripts/live-gate.mjs
```

It spends one document of the key's sandbox allowance for each case in `test/live/`. The cases send the files under `test/vendor/`, which `test/fixtures.json` traces to their source and commit. Both are under the Apache License 2.0, and each folder carries its upstream's LICENSE, and NOTICE where there is one. `--write-samples` rewrites each module's `samples.json` from the answer to its first case.

## Deploy

Only beliq deploys, from a clean checkout of `origin/main`, with Make's API token in `~/.config/beliq/make-api-token`:

```bash
node scripts/deploy.mjs plan             # what differs from the live app, and a plan id
node scripts/deploy.mjs apply <plan-id>  # pushes that plan, then reads every section back
```

A deploy reaches every organisation that installed the app at once.

## License

[MIT](./LICENSE)
