import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NotAPathError, parsePath, resolve, slashTemplatePath, SPREAD, templates, toCollection } from '../scripts/iml.mjs'

const answer = {
  body: { data: { valid: false, format: 'ubl', errors: [{ ruleId: 'BR-01' }] } },
  headers: { 'x-request-id': 'r-1' },
  statusCode: 200,
}

test('a path resolves to the typed value, not its text', () => {
  assert.equal(resolve('{{body.data.valid}}', answer), false)
  assert.deepEqual(resolve('{{body.data.errors}}', answer), [{ ruleId: 'BR-01' }])
})

test('a backtick segment reads a header name with dashes', () => {
  assert.deepEqual(parsePath('headers.`x-request-id`'), ['headers', 'x-request-id'])
  assert.equal(resolve('{{headers.`x-request-id`}}', answer), 'r-1')
})

test('a missing path resolves to undefined', () => {
  assert.equal(resolve('{{body.data.rulesetSha256}}', answer), undefined)
  assert.equal(resolve('{{body.nothing.deeper}}', answer), undefined)
})

test('objects resolve field by field and literals stay as they are', () => {
  assert.deepEqual(
    resolve({ verdict: { valid: '{{body.data.valid}}' }, agent: 'make-beliq/0.1.0', n: 3 }, answer),
    { verdict: { valid: false }, agent: 'make-beliq/0.1.0', n: 3 },
  )
})

for (const text of [
  "{{ifempty(body.error.code; 'ERROR')}}",
  '{{statusCode = 200}}',
  "{{'literal'}}",
  '{{body.a + body.b}}',
  '{{headers.x-request-id}}',
  '{{body.items.0}}',
  '{{headers.`x-request-id}}',
  '[{{statusCode}}] failed',
  '{{body.a}}{{body.b}}',
  '{{body.a',
]) {
  test(`anything but one plain path throws: ${text}`, () => {
    assert.throws(() => resolve(text, answer), NotAPathError)
  })
}

test('templates lists every mapped path under its output field', () => {
  assert.deepEqual(templates({ verdict: { valid: '{{body.data.valid}}' }, id: '{{headers.`x-request-id`}}', ua: 'x' }), [
    [['verdict', 'valid'], ['body', 'data', 'valid']],
    [['id'], ['headers', 'x-request-id']],
  ])
})

// The two forms of Make's REST universal module template.
const params = { parameters: { qs: [{ key: 'a', value: '1' }, { key: 'b', value: 'x y' }], none: [], url: '/v1/me' } }

test('a {{...}} spread of toCollection turns key/value items into one collection', () => {
  assert.deepEqual(resolve({ '{{...}}': "{{toCollection(parameters.qs, 'key', 'value')}}" }, params), { a: '1', b: 'x y' })
  assert.deepEqual(resolve({ '{{...}}': "{{toCollection(parameters.none, 'key', 'value')}}" }, params), {})
})

for (const [name, value] of [
  ['a spread beside another key', { '{{...}}': "{{toCollection(parameters.qs, 'key', 'value')}}", c: '3' }],
  ['a spread of another function', { '{{...}}': '{{parameters.qs}}' }],
  ['a spread of other key names', { '{{...}}': "{{toCollection(parameters.qs, 'name', 'value')}}" }],
  ['a spread of a missing array', { '{{...}}': "{{toCollection(parameters.missing, 'key', 'value')}}" }],
]) {
  test(`${name} throws`, () => {
    assert.throws(() => resolve(value, params), NotAPathError)
  })
}

test('toCollection over a key that comes twice throws, since which one Make keeps is not documented', () => {
  assert.throws(() => toCollection([{ key: 'a', value: '1' }, { key: 'a', value: '2' }]), /twice/)
})

test('templates names a spread by the array it reads', () => {
  assert.deepEqual(templates({ qs: { '{{...}}': "{{toCollection(parameters.qs, 'key', 'value')}}" } }), [
    [['qs', SPREAD], ['parameters', 'qs']],
  ])
})

test('a url of a slash and one template gives that path; any other text gives none', () => {
  assert.deepEqual(slashTemplatePath('/{{parameters.url}}'), ['parameters', 'url'])
  for (const text of ['{{parameters.url}}', '/v1/{{parameters.url}}', 'https://x.invalid/{{parameters.url}}', '/v1/me']) {
    assert.equal(slashTemplatePath(text), null, text)
  }
})
