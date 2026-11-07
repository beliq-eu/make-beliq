// The live gate's checks against openapi.json, without the network. The live run itself is
// the CI job `live`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkOutputPath, requestUrl, runGate, unmodelled } from '../scripts/live-gate.mjs'

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
