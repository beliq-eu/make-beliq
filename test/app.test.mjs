// Checks that the app's files agree with each other: what Make shows (interface, samples)
// against what the module maps (output), the files the gate needs, and the vendored fixtures.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { readApp, ROOT } from '../scripts/app.mjs'
import { FIXTURES_DIR, isFileRef, loadFile, readManifest, sha256 } from '../scripts/fixtures.mjs'
import { templates } from '../scripts/iml.mjs'
import { checkRelativeUrl, QUOTA_EXEMPT_PATHS, requestUrl, resolveUrl } from '../scripts/live-gate.mjs'

const app = await readApp()
const manifest = await readManifest()

// The field names of an interface, as a tree: a collection with a `spec` nests its own names,
// one without a `spec` takes whatever the API sends.
function interfaceTree(fields) {
  return Object.fromEntries(fields.map((f) => [f.name, f.type === 'collection' && f.spec ? interfaceTree(f.spec) : null]))
}

// The same tree for an output mapping. A field mapped by one template takes the API's value
// as it comes, so it is a leaf here; that its children are the ones openapi.json declares is
// the parse interface's drift check (scripts/parse-interface.mjs --check).
function outputTree(output) {
  return Object.fromEntries(
    Object.entries(output).map(([k, v]) => [k, v !== null && typeof v === 'object' && !Array.isArray(v) ? outputTree(v) : null]),
  )
}

function leafAt(tree, output) {
  return Object.fromEntries(
    Object.entries(tree).map(([k, v]) => [k, v && output[k] !== null && typeof output[k] === 'object' ? leafAt(v, output[k]) : null]),
  )
}

// Every key of a sample that its interface does not declare, as a path. A sample is one real
// answer, so it may leave out a field the document did not carry, but never add one.
function undeclared(value, fields, where = '') {
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]))
  const out = []
  for (const [k, v] of Object.entries(value ?? {})) {
    const f = byName[k]
    const at = `${where}${k}`
    if (!f) {
      out.push(at)
      continue
    }
    if (f.type === 'collection' && Array.isArray(f.spec) && v && typeof v === 'object') {
      out.push(...undeclared(v, f.spec, `${at}.`))
    }
    if (f.type === 'array' && Array.isArray(f.spec) && Array.isArray(v)) {
      v.forEach((item, i) => out.push(...undeclared(item, f.spec, `${at}.${i}.`)))
    }
  }
  return out
}

for (const m of app.modules) {
  const iface = interfaceTree(m.sections.interface.json)

  test(`${m.name}: the output maps exactly the fields its interface declares`, () => {
    const output = m.sections.api.json.response.output
    assert.deepEqual(outputTree(output), leafAt(iface, output))
  })

  test(`${m.name}: the samples hold no field its interface does not declare`, () => {
    assert.deepEqual(undeclared(m.sections.samples.json, m.sections.interface.json), [])
  })

  test(`${m.name}: module.json names the folder it sits in`, () => {
    assert.equal(m.module.json.name, m.name)
    assert.ok(Number.isInteger(m.module.json.typeId))
  })

  test(`${m.name}: its url is relative and every other template is one the gate models`, () => {
    const { url, headers, qs, body, response } = m.sections.api.json
    assert.deepEqual(checkRelativeUrl(url, m.name), [])
    assert.doesNotThrow(() => templates({ headers, qs, body, output: response.output }))
  })

  test(`${m.name}: the live gate has a case for it`, async () => {
    const file = join(ROOT, 'test', 'live', `${m.name}.json`)
    assert.ok(existsSync(file), `test/live/${m.name}.json is missing`)
    const { cases } = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(cases.length > 0)
    assert.ok(cases.filter((c) => c.sample).length <= 1, 'at most one case writes the samples')
    const params = Object.fromEntries(m.sections.expect.json.map((p) => [p.name, p]))
    for (const c of cases) {
      // A case may only send what a Make user can enter: a parameter the module has, an
      // option of a select, and a content type the file has.
      for (const [name, value] of Object.entries(c.parameters)) {
        assert.ok(params[name], `${name} is not a parameter of ${m.name}`)
        if (params[name].type === 'select') assert.ok(params[name].options.some((o) => o.value === value), `${name}: ${value} is not an option of the select`)
      }
      const files = Object.values(c.parameters).filter(isFileRef)
      const loaded = []
      for (const ref of files) loaded.push(await loadFile(ref, manifest))
      if ('contentType' in c.parameters) assert.deepEqual(loaded.map((f) => f.contentType), [c.parameters.contentType])
      if (c.quotaExempt) {
        const path = requestUrl(app.base.json.baseUrl, resolveUrl(m.sections.api.json.url, { parameters: c.parameters })).pathname
        assert.ok(QUOTA_EXEMPT_PATHS.includes(path), `a quotaExempt case sends ${path}`)
      }
    }
  })
}

test('a module that writes no samples keeps them empty', () => {
  for (const m of app.modules) {
    const { cases } = JSON.parse(readFileSync(join(ROOT, 'test', 'live', `${m.name}.json`), 'utf8'))
    if (!cases.some((c) => c.sample)) assert.deepEqual(m.sections.samples.json, {}, `${m.name}/samples.json`)
  }
})

test('the app has one universal module, named makeApiCall as its label says', () => {
  const universal = app.modules.filter((m) => m.module.json.typeId === 12)
  assert.deepEqual(universal.map((m) => [m.name, m.module.json.label]), [['makeApiCall', 'Make an API call']])
})

test('groups list every module exactly once', () => {
  const grouped = app.groups.json.flatMap((g) => g.modules).sort()
  assert.deepEqual(grouped, app.modules.map((m) => m.name).sort())
})

test('the User-Agent names the version of the newest CHANGELOG entry', () => {
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  const newest = /^## (\d+\.\d+\.\d+)/m.exec(changelog)?.[1]
  assert.ok(newest, 'CHANGELOG.md has no version heading')
  assert.equal(app.base.json.headers['User-Agent'], `make-beliq/${newest}`)
})

test('base.json templates in the request headers are plain paths', () => {
  assert.doesNotThrow(() => templates(app.base.json.headers))
})

for (const f of manifest.fixtures) {
  test(`fixture ${f.file} is the byte copy fixtures.json names, with its licence`, () => {
    assert.equal(sha256(readFileSync(join(FIXTURES_DIR, f.file))), f.sha256)
    assert.ok(existsSync(join(FIXTURES_DIR, f.licenseFile)))
    if (f.noticeFile) assert.ok(existsSync(join(FIXTURES_DIR, f.noticeFile)))
  })
}

for (const m of manifest.mutations) {
  test(`mutation ${m.name} changes one text of a listed fixture into the bytes it records`, async () => {
    assert.ok(manifest.fixtures.some((f) => f.file === m.base), `${m.base} is not a listed fixture`)
    assert.ok(m.breaks, 'a mutation names the rule it breaks')
    const { bytes } = await loadFile({ mutation: m.name }, manifest)
    assert.equal(sha256(bytes), m.sha256)
  })
}
