// The live gate's checks against openapi.json, without the network. The live run itself is
// the CI job `live`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ROOT } from '../scripts/app.mjs'
import { buildRequest, checkCase, checkOutputPath, checkRelativeUrl, isQuotaExempt, requestUrl, resolveUrl, runGate, unmodelled } from '../scripts/live-gate.mjs'

const spec = {
  components: {
    schemas: {
      Finding: { type: 'object', required: ['ruleId'], properties: { ruleId: { type: 'string' } } },
    },
  },
}
const operation = {
  responses: {
    200: {
      headers: { 'X-Request-Id': { schema: { type: 'string' } } },
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['success'],
            properties: {
              success: { type: 'boolean' },
              data: {
                allOf: [
                  {
                    type: 'object',
                    required: ['valid'],
                    properties: {
                      valid: { type: 'boolean' },
                      errors: { type: 'array', items: { $ref: '#/components/schemas/Finding' } },
                    },
                  },
                ],
                anyOf: [{ properties: { rulesetSha256: { type: 'string' } }, required: ['rulesetSha256'] }],
              },
            },
          },
        },
      },
    },
  },
}

const answer = (data) => ({ body: data === undefined ? { success: true } : { success: true, data } })

test('a declared path passes, with or without a value when nothing requires it', () => {
  assert.deepEqual(checkOutputPath('rulesetSha256', ['body', 'data', 'rulesetSha256'], answer({ valid: true }), operation, spec), [])
  assert.deepEqual(checkOutputPath('errors', ['body', 'data', 'errors'], answer({ valid: true, errors: [] }), operation, spec), [])
})

test('an undeclared body path fails, even when the answer has a value there', () => {
  const found = checkOutputPath('x', ['body', 'data', 'validd'], answer({ valid: true, validd: true }), operation, spec)
  assert.equal(found.length, 1)
  assert.match(found[0], /does not declare/)
})

test('a field its parent requires fails when the parent is there and the field is not', () => {
  assert.match(checkOutputPath('valid', ['body', 'data', 'valid'], answer({ errors: [] }), operation, spec)[0], /requires/)
})

test('a required field under a parent that is not required and not there passes', () => {
  assert.deepEqual(checkOutputPath('valid', ['body', 'data', 'valid'], answer(undefined), operation, spec), [])
})

test('required inside anyOf does not count as required', () => {
  assert.deepEqual(checkOutputPath('r', ['body', 'data', 'rulesetSha256'], answer({ valid: true }), operation, spec), [])
})

test('headers are matched by declared name, in any case', () => {
  assert.deepEqual(checkOutputPath('requestId', ['headers', 'x-request-id'], answer({}), operation, spec), [])
  assert.match(checkOutputPath('v', ['headers', 'x-validation'], answer({}), operation, spec)[0], /does not declare/)
})

test('a path outside body, headers and statusCode fails', () => {
  assert.equal(checkOutputPath('p', ['parameters', 'data'], answer({}), operation, spec).length, 1)
})

test('a directive the gate does not model is named', () => {
  assert.deepEqual(unmodelled({ url: '/v1/x', iterate: '{{body.items}}' }, ['url'], 'm/api.json'), [
    'm/api.json: the gate does not model the directive `iterate`',
  ])
})

test('the gate refuses a key that is not a test key before it sends anything', async () => {
  for (const apiKey of [undefined, '', 'blq_live_abc', 'abc']) {
    await assert.rejects(runGate({ apiKey, log: () => {} }), /blq_test_/)
  }
})

test('a name the parent requires beside an allOf counts as required', () => {
  const wrapped = structuredClone(operation)
  const data = wrapped.responses[200].content['application/json'].schema.properties.data
  data.allOf[0].required = []
  data.required = ['valid']
  assert.match(checkOutputPath('valid', ['body', 'data', 'valid'], answer({ errors: [] }), wrapped, spec)[0], /requires/)
})

test('the base URL keeps its path, as Make joins it with the module url', () => {
  assert.equal(requestUrl('https://api.beliq.eu', '/v1/validate').href, 'https://api.beliq.eu/v1/validate')
  assert.equal(requestUrl('https://api.example.invalid/v1/', '/validate').href, 'https://api.example.invalid/v1/validate')
  assert.equal(requestUrl('https://api.beliq.eu', 'https://other.invalid/x').href, 'https://other.invalid/x')
})

test('the whole header collection passes, as the universal module maps it', () => {
  assert.deepEqual(checkOutputPath('headers', ['headers'], answer({}), operation, spec), [])
})

test('a module url must be relative to the base URL', () => {
  for (const url of ['/v1/validate', '/{{parameters.url}}']) assert.deepEqual(checkRelativeUrl(url, 'm'), [], url)
  for (const url of ['{{parameters.url}}', 'https://other.invalid/x', '//other.invalid/x', '/v1/{{parameters.url}}', 'v1/me']) {
    assert.equal(checkRelativeUrl(url, 'm').length, 1, url)
  }
})

test('a typed path keeps one slash, with or without its own; two slashes or a scheme throw', () => {
  const at = (url) => resolveUrl('/{{parameters.url}}', { parameters: { url } })
  assert.equal(at('/v1/me'), '/v1/me')
  assert.equal(at('v1/me'), '/v1/me')
  for (const url of ['//other.invalid/x', 'https://other.invalid/x', '', undefined]) assert.throws(() => at(url), String(url))
})

const universal = JSON.parse(readFileSync(join(ROOT, 'app', 'modules', 'makeApiCall', 'api.json'), 'utf8'))
const call = (parameters) =>
  buildRequest('https://api.example.invalid', { 'x-api-key': '{{connection.apiKey}}' }, universal, { connection: { apiKey: 'k' }, parameters })

test("the universal module's request: base headers, the user's headers and query, the typed method", () => {
  const { url, init } = call({ url: '/v1/me', method: 'GET', headers: [{ key: 'Accept', value: 'application/json' }], qs: [{ key: 'a', value: '1' }] })
  assert.equal(url.href, 'https://api.example.invalid/v1/me?a=1')
  assert.equal(init.method, 'GET')
  assert.deepEqual(init.headers, { 'x-api-key': 'k', Accept: 'application/json' })
  assert.equal(init.body, undefined)
})

test("the universal module sends a text body as typed, and refuses one that is not text", () => {
  assert.equal(call({ url: '/v1/x', method: 'POST', headers: [], qs: [], body: '<a/>' }).init.body, '<a/>')
  assert.throws(() => call({ url: '/v1/x', method: 'POST', headers: [], qs: [], body: { a: 1 } }), /not text/)
})

test('a case checks present, equals and includes on the output', () => {
  const output = { verdict: { valid: false }, errors: [{ ruleId: 'BR-CO-16', severity: 'fatal' }], statusCode: 200 }
  assert.deepEqual(checkCase({ present: ['verdict.valid'], equals: { 'verdict.valid': false, statusCode: 200 }, includes: { errors: { ruleId: 'BR-CO-16' } } }, output), [])
  assert.equal(checkCase({ equals: { 'verdict.valid': true } }, output).length, 1)
  assert.equal(checkCase({ equals: { statusCode: '200' } }, output).length, 1)
  assert.equal(checkCase({ includes: { errors: { ruleId: 'BR-CO-15' } } }, output).length, 1)
  assert.equal(checkCase({ includes: { verdict: { valid: false } } }, output).length, 1, 'includes needs an array')
  assert.equal(checkCase({ present: ['verdict.missing'] }, output).length, 1)
})

test('a case may be quota-exempt only on an operation openapi.json says costs no quota', () => {
  assert.equal(isQuotaExempt({ summary: 'Account, plan, and quota context for the calling API key (no quota cost).' }), true)
  assert.equal(isQuotaExempt({ summary: 'Validate an e-invoice.' }), false)
  assert.equal(isQuotaExempt(undefined), false)
})
