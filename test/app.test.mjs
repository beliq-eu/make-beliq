// Checks that the app's files agree with each other: what Make shows (interface, samples)
// against what the module maps (output), the files the gate needs, and the vendored fixtures.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { readApp, ROOT } from '../scripts/app.mjs'
import { templates } from '../scripts/iml.mjs'

const app = await readApp()
const fixturesDir = join(ROOT, 'test', 'vendor')
const manifest = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures.json'), 'utf8')).fixtures

// The field names of an interface, as a tree: a collection with a `spec` nests its own names,
// one without a `spec` takes whatever the API sends.
function interfaceTree(fields) {
  return Object.fromEntries(fields.map((f) => [f.name, f.type === 'collection' && f.spec ? interfaceTree(f.spec) : null]))
}

// The same tree for a value: an output mapping or a sample. Below a collection that has no
// spec in the interface, nothing is compared.
function valueTree(value, iface) {
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      iface?.[k] && v !== null && typeof v === 'object' && !Array.isArray(v) ? valueTree(v, iface[k]) : null,
    ]),
  )
}

for (const m of app.modules) {
  const iface = interfaceTree(m.sections.interface.json)

  test(`${m.name}: the output maps exactly the fields its interface declares`, () => {
    assert.deepEqual(valueTree(m.sections.api.json.response.output, iface), iface)
  })

  test(`${m.name}: the samples hold exactly the fields its interface declares`, () => {
    assert.deepEqual(valueTree(m.sections.samples.json, iface), iface)
  })

  test(`${m.name}: module.json names the folder it sits in`, () => {
    assert.equal(m.module.json.name, m.name)
    assert.ok(Number.isInteger(m.module.json.typeId))
  })

  test(`${m.name}: every template in its request and output is a plain path`, () => {
    const { url, headers, qs, body, response } = m.sections.api.json
    assert.doesNotThrow(() => templates({ url, headers, qs, body, output: response.output }))
  })

  test(`${m.name}: the live gate has a case for it`, () => {
    const file = join(ROOT, 'test', 'live', `${m.name}.json`)
    assert.ok(existsSync(file), `test/live/${m.name}.json is missing`)
    const { cases } = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(cases.length > 0)
    const selects = Object.fromEntries(
      m.sections.expect.json.filter((p) => p.type === 'select').map((p) => [p.name, p.options.map((o) => o.value)]),
    )
    for (const c of cases) {
      const fixtures = Object.values(c.parameters).filter((v) => v && typeof v === 'object')
      for (const v of fixtures) {
        assert.ok(manifest.some((f) => f.file === v.fixture), `${v.fixture} is not in fixtures.json`)
      }
      // A case may only send what a Make user can pick, and a content type the file has.
      for (const [name, value] of Object.entries(c.parameters)) {
        if (selects[name]) assert.ok(selects[name].includes(value), `${name}: ${value} is not an option of the select`)
      }
      if ('contentType' in c.parameters) {
        assert.deepEqual(fixtures.map((v) => manifest.find((f) => f.file === v.fixture)?.contentType), [c.parameters.contentType])
      }
    }
  })
}

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

for (const f of manifest) {
  test(`fixture ${f.file} is the byte copy fixtures.json names, with its licence`, () => {
    const hash = createHash('sha256').update(readFileSync(join(fixturesDir, f.file))).digest('hex')
    assert.equal(hash, f.sha256)
    assert.ok(existsSync(join(fixturesDir, f.licenseFile)))
    if (f.noticeFile) assert.ok(existsSync(join(fixturesDir, f.noticeFile)))
  })
}
