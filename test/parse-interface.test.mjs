// The Parse interface generator against a small openapi.json, without the network. The drift
// check against the live openapi.json is the CI step that runs `--check`.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { differing, field, generate, label, PARSE_DIR, render, UnmappedSchemaError } from '../scripts/parse-interface.mjs'

const specWith = (data, headers = { 'x-request-id': { schema: { type: 'string' } } }) => ({
  paths: {
    '/v1/parse': {
      post: {
        responses: {
          200: { headers, content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data } } } } },
        },
      },
    },
  },
  components: { schemas: { Address: { type: 'object', properties: { city: { type: 'string' } } } } },
})

const data = {
  type: 'object',
  required: ['format'],
  properties: {
    format: { anyOf: [{ type: 'string', enum: ['cii'] }, { type: 'string', enum: ['ubl'] }] },
    vatId: { type: 'string' },
    total: { type: 'number' },
    count: { type: 'integer' },
    seller: { type: 'object', properties: { address: { $ref: '#/components/schemas/Address' } } },
    lines: { type: 'array', items: { type: 'object', properties: { quantity: { type: 'number' } } } },
    terms: { type: 'array', items: { type: 'string' } },
  },
}

test('labels split the key name and write abbreviations in capitals', () => {
  assert.equal(label('totalGrossAmount'), 'Total gross amount')
  assert.equal(label('businessProcessId'), 'Business process ID')
  assert.equal(label('franceCtcDetected'), 'France CTC detected')
  assert.equal(label('vatId'), 'VAT ID')
  assert.equal(label('rulesetSHA256'), 'Ruleset SHA256')
  assert.equal(label('leitwegID'), 'Leitweg ID')
})

test('every key of data becomes a field, mapped whole, with data and requestId after them', () => {
  const { iface, output } = generate(specWith(data))
  assert.deepEqual(iface.map((f) => f.name), ['format', 'vatId', 'total', 'count', 'seller', 'lines', 'terms', 'data', 'requestId'])
  assert.equal(output.seller, '{{body.data.seller}}')
  assert.equal(output.data, '{{body.data}}')
  assert.equal(output.requestId, '{{headers.`x-request-id`}}')
  assert.ok(iface.every((f) => !('default' in f) && !('required' in f)), 'no field gets a default or a required mark')
})

test('types follow the schema: an enum anyOf is text, a $ref is followed, arrays take a spec', () => {
  const byName = Object.fromEntries(generate(specWith(data)).iface.map((f) => [f.name, f]))
  assert.equal(byName.format.type, 'text')
  assert.equal(byName.total.type, 'number')
  assert.equal(byName.count.type, 'integer')
  assert.deepEqual(byName.seller.spec, [{ name: 'address', type: 'collection', label: 'Address', spec: [{ name: 'city', type: 'text', label: 'City' }] }])
  assert.deepEqual(byName.lines.spec, [{ name: 'quantity', type: 'number', label: 'Quantity' }])
  assert.deepEqual(byName.terms.spec, { type: 'text', label: 'Terms' })
})

test('a schema form the generator does not map throws instead of guessing a type', () => {
  assert.throws(() => field('x', { anyOf: [{ type: 'string' }, { type: 'number' }] }, {}), UnmappedSchemaError)
  assert.throws(() => field('x', { type: 'object' }, {}), UnmappedSchemaError)
  assert.throws(() => field('x', { type: 'null' }, {}), UnmappedSchemaError)
  assert.throws(() => generate(specWith(data, {})), /x-request-id/)
  assert.throws(() => generate({ paths: {} }), UnmappedSchemaError)
  const clash = structuredClone(data)
  clash.properties.requestId = { type: 'string' }
  assert.throws(() => generate(specWith(clash)), /requestId/)
})

const work = mkdtempSync(join(tmpdir(), 'make-beliq-parse-interface-'))
after(() => rmSync(work, { recursive: true, force: true }))

test('the check names a committed file that differs from what the spec gives, and only that one', async () => {
  const dir = join(work, 'parse')
  cpSync(PARSE_DIR, dir, { recursive: true })
  const files = await render(specWith(data), dir)
  for (const [file, content] of Object.entries(files)) writeFileSync(file, content)
  assert.deepEqual(await differing(files), [])
  writeFileSync(join(dir, 'interface.json'), '[]\n')
  assert.deepEqual(await differing(files), [join(dir, 'interface.json')])
  const fewer = structuredClone(data)
  delete fewer.properties.vatId
  const drifted = await render(specWith(fewer), dir)
  assert.deepEqual((await differing(drifted)).sort(), Object.keys(drifted).sort())
})
