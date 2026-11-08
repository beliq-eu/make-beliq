# make-beliq

The [beliq](https://beliq.eu) app for [Make](https://www.make.com): validate an EU e-invoice in a Make scenario and get back the verdict with the depth of its check, read an e-invoice's fields into structured data, or call any path of the beliq API with your connection.

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

## Parse an e-invoice

The module sends the file you map, a CII or UBL XML invoice or a PDF with the invoice XML embedded, as the body of [`POST /v1/parse`](https://docs.beliq.eu/api-reference/parse/). It sends nothing else. It reads the invoice's fields and checks nothing: it gives no verdict and no badge, so use **Validate an e-invoice** to know whether the file passes its format's rules.

Its output holds each key of the answer's `data` under its own name: **Format**, **Profile detected**, **Profile URN**, **Business process ID**, **France CTC detected**, **Invoice** (number, dates, parties, lines, delivery and totals) and **Warnings**, then **Full response data** and **Request ID**. A field that was not read from the document stays empty: the module fills in no default. **Warnings** names what the answer does not return, so read it before you treat an empty field as absent from the invoice.

`scripts/parse-interface.mjs` writes the module's interface and output mapping from the `/v1/parse` answer in [the API's openapi.json](https://api.beliq.eu/openapi.json), and CI runs it with `--check` on every pull request and every push to `main`.

## Make an API call

The module sends a request to any path of the beliq API, relative to `https://api.beliq.eu`, such as `/v1/me`, with your connection's API key. You enter the method, the headers, the query string and the body. Its output is the answer's `body`, `headers` and `statusCode`. The paths and their requests are described at [docs.beliq.eu](https://docs.beliq.eu) and in [openapi.json](https://api.beliq.eu/openapi.json). A path that spends documents spends them as it does outside Make.

## Example scenario

[`blueprints/validate-and-parse.json`](./blueprints/validate-and-parse.json) is a scenario to import in a Make organisation that installed the app, with **Import blueprint** in the scenario editor's menu. It downloads two public test invoices, KoSIT's XRechnung test file `01.01a-INVOICE_uncefact.xml` and the Mustang project's `EN16931_Einfach.pdf`, each at the commit `test/fixtures.json` names. It validates both, parses the PDF and calls `GET /v1/me`. After the import, pick your beliq connection in each of the four beliq modules. One run spends three documents of your key's quota, two validations and one parse; `GET /v1/me` spends none.

## Layout

`app/` holds one JSON file for each section Make stores: `app.json`, `base.json` (the base URL `https://api.beliq.eu`, the API key header, and a `User-Agent` of `make-beliq/<version>`), `groups.json`, `connection/`, and one folder for each module. `app/icon.svg` is the source of `app/icon.png`: Make keeps only the shape of the icon's opaque pixels, draws it in white and puts it on the theme colour from `app.json`.

## Tests

```bash
node --test test/iml.test.mjs test/app.test.mjs test/live-gate.test.mjs test/deploy.test.mjs test/parse-interface.test.mjs test/blueprint.test.mjs
bash scripts/scrub-check.sh
node scripts/parse-interface.mjs --check
```

The tests and the scrub need no network. They check that each module's output and interface name the same fields and that its samples hold none the interface does not declare, that every template in a request or an output is a plain path lookup or one of the two forms of Make's universal module template, that every module's url is relative to the base URL, the vendored fixtures' checksums, that the example scenario names only the app's modules and their fields, fetches only the pinned fixtures and carries no connection or other ID of the organisation it was exported from, and the deploy script against a local server that answers like Make's API. The last command fetches `openapi.json` and fails when the Parse module's files differ from what it gives.

The live gate sends the requests the app's files describe to the live API and checks the answers against [the API's openapi.json](https://api.beliq.eu/openapi.json). It runs in CI on a push to `main`, and needs a test key:

```bash
BELIQ_API_KEY=blq_test_... node scripts/live-gate.mjs
```

It spends one document of the key's sandbox allowance for each case in `test/live/`, except the one marked `quotaExempt`, which calls `GET /v1/me`. The cases send the files under `test/vendor/`, which `test/fixtures.json` traces to their source and commit. Both are under the Apache License 2.0, and each folder carries its upstream's LICENSE, and NOTICE where there is one. One case sends a mutation of a vendored file: `test/fixtures.json` records the exact text it replaces, the rule it breaks and the SHA-256 of the result, and the gate checks that the API answers it with `valid: false` and that rule's ID. `--write-samples` rewrites a module's `samples.json` from the answer to its case marked `sample`; the universal module has none, since `GET /v1/me` names the key's organisation.

## Deploy

Only beliq deploys, from a clean checkout of `origin/main`, with Make's API token in `~/.config/beliq/make-api-token`:

```bash
node scripts/deploy.mjs plan              # what differs from the live app, and a plan id
node scripts/deploy.mjs apply <plan-id>   # pushes that plan, then reads every section back
node scripts/deploy.mjs publish <module>  # publishes a module; final
```

A deploy reaches every organisation that installed the app at once. An apply creates a new module unpublished, so it can be run in a scenario of the app's owner first. Publishing is a separate step because it is final: Make never deletes a published module or changes its name.

## License

[MIT](./LICENSE)
