// Checks the scenario blueprint against the app and the fixture list, so it cannot name a
// module or a field the app lacks, fetch a file the gate does not pin, or carry an ID of the
// organisation it was exported from.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { readApp, ROOT } from '../scripts/app.mjs'
import { readManifest } from '../scripts/fixtures.mjs'
import { APP } from '../scripts/deploy.mjs'

const app = await readApp()
const manifest = await readManifest()
const modules = Object.fromEntries(app.modules.map((m) => [m.name, m.sections]))
const blueprint = JSON.parse(readFileSync(join(ROOT, 'blueprints', 'validate-and-parse.json'), 'utf8'))
const APP_PREFIX = `app#${APP}:`

const appModules = blueprint.flow.filter((m) => m.module.startsWith(APP_PREFIX))
const fetches = blueprint.flow.filter((m) => m.module === 'http:ActionGetFile')

// The raw URL of a fixture at its pinned commit: the bytes whose sha256 the manifest records.
function rawUrl(fixture) {
  const [, , , owner, repo, , , ...path] = fixture.source.split('/')
  return `https://raw.githubusercontent.com/${owner}/${repo}/${fixture.commit}/${path.join('/')}`
}

test('every app module in the blueprint is a module of the app', () => {
  assert.deepEqual(
    appModules.map((m) => m.module.slice(APP_PREFIX.length)).filter((name) => !(name in modules)),
    [],
  )
  assert.deepEqual(
    [...new Set(appModules.map((m) => m.module.slice(APP_PREFIX.length)))].sort(),
    Object.keys(modules).sort(),
    'the blueprint uses every module once at least',
  )
})

test('every mapped field is a field the module asks for, and a select takes one of its options', () => {
  for (const m of appModules) {
    const expect = modules[m.module.slice(APP_PREFIX.length)].expect.json
    for (const [name, value] of Object.entries(m.mapper)) {
      const field = expect.find((f) => f.name === name)
      assert.ok(field, `module ${m.id} maps ${name}, which its expect does not declare`)
      if (field.type === 'select' && !String(value).includes('{{')) {
        assert.ok(field.options.some((o) => o.value === value), `module ${m.id}: ${name} = ${value} is not an option`)
      }
    }
  }
})

test('every file the blueprint fetches is a listed fixture at its pinned commit', () => {
  const pinned = manifest.fixtures.map(rawUrl)
  assert.ok(fetches.length > 0)
  for (const m of fetches) assert.ok(pinned.includes(m.mapper.url), `module ${m.id} fetches ${m.mapper.url}`)
})

test('no ID or connection of the exporting organisation is left', () => {
  for (const m of appModules) {
    assert.equal(m.parameters.__IMTCONN__, null, `module ${m.id} keeps a connection ID`)
    assert.equal(m.metadata?.restore?.parameters?.__IMTCONN__, undefined, `module ${m.id} keeps a connection label`)
    assert.equal(m.metadata?.setupValidation, undefined, `module ${m.id} keeps a setup hash`)
  }
  assert.equal(blueprint.metadata.zone, undefined)
  const numbers = []
  JSON.stringify(blueprint, (key, value) => {
    if (typeof value === 'number' && value > 9999) numbers.push(`${key}=${value}`)
    return value
  })
  assert.deepEqual(numbers, [], 'a number this large is an ID, not a setting')
})
