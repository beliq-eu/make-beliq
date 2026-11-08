// Checks the scenario blueprint against the app and the fixture list, so it cannot name a
// module or a field the app lacks, send a file under the wrong type, fetch a file the gate does
// not pin, or carry an ID of the organisation it was exported from.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { readApp, ROOT } from '../scripts/app.mjs'
import { readManifest } from '../scripts/fixtures.mjs'
import { APP, VERSION } from '../scripts/deploy.mjs'

const app = await readApp()
const manifest = await readManifest()
const modules = Object.fromEntries(app.modules.map((m) => [m.name, m.sections]))
const blueprint = JSON.parse(readFileSync(join(ROOT, 'blueprints', 'validate-and-parse.json'), 'utf8'))
const APP_PREFIX = `app#${APP}:`
const FETCH = 'http:ActionGetFile'
// Make's own export holds no number this large that is a setting; module ids and coordinates
// stay far below it.
const ID_FLOOR = 10_000

const appModules = blueprint.flow.filter((m) => m.module.startsWith(APP_PREFIX))
const fetches = blueprint.flow.filter((m) => m.module === FETCH)
const nameOf = (m) => m.module.slice(APP_PREFIX.length)
const expectOf = (m) => modules[nameOf(m)].expect.json

// The raw URL of a fixture at its pinned commit: the bytes whose sha256 the manifest records.
function rawUrl(fixture) {
  const [, , , owner, repo, , , ...path] = fixture.source.split('/')
  return `https://raw.githubusercontent.com/${owner}/${repo}/${fixture.commit}/${path.join('/')}`
}

test('the blueprint holds only app modules and file downloads', () => {
  assert.deepEqual(blueprint.flow.filter((m) => !m.module.startsWith(APP_PREFIX) && m.module !== FETCH).map((m) => m.module), [])
})

test('the blueprint uses every module of the app, at the app version the deploy pushes', () => {
  assert.deepEqual([...new Set(appModules.map(nameOf))].sort(), Object.keys(modules).sort())
  for (const m of appModules) assert.equal(m.version, VERSION, `module ${m.id}`)
})

test('every module maps each required field and no field it does not ask for', () => {
  for (const m of appModules) {
    const expect = expectOf(m)
    for (const name of Object.keys(m.mapper)) {
      assert.ok(expect.some((f) => f.name === name), `module ${m.id} maps ${name}, which its expect does not declare`)
    }
    for (const f of expect.filter((f) => f.required)) {
      assert.ok(f.name in m.mapper, `module ${m.id} leaves the required field ${f.name} unmapped`)
    }
  }
})

test("Make's copy of each module's fields in the blueprint matches the app's expect", () => {
  for (const m of appModules) {
    const copy = m.metadata.expect.map((f) => [f.name, f.type, f.label, Boolean(f.required), f.validate?.enum ?? null])
    const own = expectOf(m).map((f) => [f.name, f.type, f.label, Boolean(f.required), f.type === 'select' ? f.options.map((o) => o.value) : null])
    assert.deepEqual(copy, own, `module ${m.id}`)
  }
})

test('every file the blueprint fetches is a listed fixture at its pinned commit', () => {
  const pinned = manifest.fixtures.map(rawUrl)
  assert.ok(fetches.length > 0)
  for (const m of fetches) assert.ok(pinned.includes(m.mapper.url), `module ${m.id} fetches ${m.mapper.url}`)
})

test("every file sent is an earlier download, with the fixture's content type", () => {
  for (const m of appModules.filter((m) => 'data' in m.mapper)) {
    const ref = /^\{\{(\d+)\.data\}\}$/.exec(m.mapper.data)
    assert.ok(ref, `module ${m.id} maps data ${m.mapper.data}`)
    const source = fetches.find((f) => f.id === Number(ref[1]))
    assert.ok(source && blueprint.flow.indexOf(source) < blueprint.flow.indexOf(m), `module ${m.id} reads module ${ref[1]}`)
    const fixture = manifest.fixtures.find((f) => rawUrl(f) === source.mapper.url)
    assert.equal(m.mapper.contentType, fixture.contentType, `module ${m.id} sends ${fixture.file}`)
  }
})

test('no ID or connection of the exporting organisation is left', () => {
  for (const m of appModules) {
    assert.equal(m.parameters.__IMTCONN__, null, `module ${m.id} keeps a connection ID`)
    assert.equal(m.metadata?.restore?.parameters?.__IMTCONN__, undefined, `module ${m.id} keeps a connection label`)
    assert.equal(m.metadata?.setupValidation, undefined, `module ${m.id} keeps a setup hash`)
  }
  assert.equal(blueprint.metadata.zone, undefined)
  const found = []
  JSON.stringify(blueprint, (key, value) => {
    if (/^__IMT/.test(key) && key !== '__IMTCONN__') found.push(key)
    if (/(organi[sz]ation|team|scenario|hook|datastore)_?id$/i.test(key)) found.push(key)
    if (typeof value === 'number' && value >= ID_FLOOR) found.push(`${key}=${value}`)
    if (typeof value === 'string' && /^\d{5,}$/.test(value)) found.push(`${key}=${value}`)
    return value
  })
  assert.deepEqual(found, [])
})
