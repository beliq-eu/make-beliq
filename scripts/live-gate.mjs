#!/usr/bin/env node
// Sends the requests the app's files describe to the live beliq API, with a `blq_test_` key,
// and checks the answers against the API's own openapi.json:
//
// - the connection's test request answers 200 for a key whose livemode is false;
// - each module's request, built from base.json and the module's api.json, answers 200 for
//   every case in test/live/<module>.json;
// - every body path an output field maps is declared in openapi.json for that answer, and one
//   that openapi.json requires holds a value; a mapped header is one openapi.json declares;
// - the output fields a case lists under `present` hold a value.
//
// Make's own request and response layer is not run here; a scenario in Make is the only check
// of that. Templates are resolved by scripts/iml.mjs, which fails on anything but a path.
//
// Usage: BELIQ_API_KEY=blq_test_... node scripts/live-gate.mjs [--write-samples]
// --write-samples writes each module's samples.json from the output of its first case.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readApp, ROOT } from './app.mjs'
import { lookup, resolve, templates } from './iml.mjs'

const REQUEST_TIMEOUT_MS = 60_000
const FIXTURES_DIR = join(ROOT, 'test', 'vendor')
const CASES_DIR = join(ROOT, 'test', 'live')

// The directives each file may use. A directive outside these lists changes what Make sends
// or returns in a way the gate does not model, so it fails the gate instead of being skipped.
// base.json's `response.error` and `log`, and the connection's `response.valid`, `error` and
// `log`, shape only Make's error text, its log and its verdict on the connection test, so
// the gate reads none of them.
const MODULE_DIRECTIVES = ['url', 'method', 'type', 'headers', 'qs', 'body', 'response']
const MODULE_RESPONSE_DIRECTIVES = ['output']
const BASE_DIRECTIVES = ['baseUrl', 'headers', 'response', 'log']
const BASE_RESPONSE_DIRECTIVES = ['error']
const CONNECTION_DIRECTIVES = ['url', 'method', 'headers', 'response', 'log']
const CONNECTION_RESPONSE_DIRECTIVES = ['valid', 'error']

export function unmodelled(directives, allowed, where) {
  return Object.keys(directives)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${where}: the gate does not model the directive \`${key}\``)
}

function deref(schema, spec) {
  let current = schema
  while (current && current.$ref) {
    current = current.$ref
      .replace(/^#\//, '')
      .split('/')
      .reduce((node, key) => node?.[key], spec)
  }
  return current
}

// A named property of a schema, looked up in its `properties` and its allOf/anyOf/oneOf
// members. The name is required when this schema's own `required` lists it, or when an allOf
// member requires it; a `required` inside one anyOf or oneOf branch does not count, since
// another branch may not have it.
function property(schema, name, spec) {
  const node = deref(schema, spec)
  if (!node || typeof node !== 'object') return null
  const listed = (node.required ?? []).includes(name)
  if (node.properties && Object.hasOwn(node.properties, name)) {
    return { schema: node.properties[name], required: listed }
  }
  for (const combinator of ['allOf', 'anyOf', 'oneOf']) {
    for (const member of node[combinator] ?? []) {
      const found = property(member, name, spec)
      if (found) return { schema: found.schema, required: listed || (combinator === 'allOf' && found.required) }
    }
  }
  return null
}

// Checks one output field's source path against the operation's 200 answer in openapi.json.
// A name must be declared; a name its parent requires must be in the answer wherever the
// parent is, which is what `required` means in JSON Schema.
export function checkOutputPath(field, path, answer, operation, spec) {
  const response = operation.responses?.['200']
  const [root, ...rest] = path
  if (root === 'body') {
    let schema = response?.content?.['application/json']?.schema
    let value = answer.body
    for (const [i, name] of rest.entries()) {
      const found = property(schema, name, spec)
      const at = `body.${rest.slice(0, i + 1).join('.')}`
      if (!found) return [`output ${field} maps ${at}, which openapi.json does not declare`]
      const parent = value !== null && typeof value === 'object' ? value : undefined
      const child = parent && Object.hasOwn(parent, name) ? parent[name] : undefined
      if (found.required && parent && child === undefined) {
        return [`output ${field} maps ${at}, which openapi.json requires, but the answer has none`]
      }
      schema = found.schema
      value = child
    }
    return []
  }
  if (root === 'headers') {
    const declared = Object.keys(response?.headers ?? {}).map((h) => h.toLowerCase())
    if (rest.length !== 1 || !declared.includes(rest[0].toLowerCase())) {
      return [`output ${field} maps headers.${rest.join('.')}, which openapi.json does not declare`]
    }
    return []
  }
  if (root === 'statusCode' && rest.length === 0) return []
  return [`output ${field} maps ${path.join('.')}, which is not the answer's body, headers or status`]
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== ''
}

async function loadParameters(parameters) {
  const loaded = {}
  for (const [name, value] of Object.entries(parameters)) {
    loaded[name] =
      value && typeof value === 'object' && 'fixture' in value
        ? await readFile(join(FIXTURES_DIR, value.fixture))
        : value
  }
  return loaded
}

function fixtureNames(parameters) {
  return Object.values(parameters)
    .filter((v) => v && typeof v === 'object' && 'fixture' in v)
    .map((v) => v.fixture)
    .join(', ')
}

async function send(url, { method, headers, body }) {
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.status, headers: Object.fromEntries(res.headers), body: json }
}

// Make puts the base URL in front of a module's url as text, so a path in the base URL stays.
export function requestUrl(baseUrl, url) {
  return new URL(/^https?:\/\//.test(url) ? url : `${baseUrl.replace(/\/$/, '')}${url}`)
}

function buildRequest(baseUrl, baseHeaders, api, scope) {
  const url = requestUrl(baseUrl, resolve(api.url, scope))
  for (const [k, v] of Object.entries(resolve(api.qs ?? {}, scope))) url.searchParams.set(k, String(v))
  const headers = { ...resolve(baseHeaders ?? {}, scope), ...resolve(api.headers ?? {}, scope) }
  let body
  if (api.body !== undefined) {
    if (api.type !== 'binary') throw new Error(`request type ${api.type} is not modelled; only binary is`)
    body = resolve(api.body, scope)
    if (!Buffer.isBuffer(body)) throw new Error('a binary request body must map a file parameter')
  }
  return { url, init: { method: api.method, headers, body } }
}

export async function runGate({ apiKey, writeSamples = false, log = console.log }) {
  if (!apiKey?.startsWith('blq_test_')) {
    throw new Error('BELIQ_API_KEY must be a blq_test_ key; the gate never runs on a live key')
  }
  const app = await readApp()
  const base = app.base.json
  const conn = app.connection.api.json
  const failures = [
    ...unmodelled(base, BASE_DIRECTIVES, 'base.json'),
    ...unmodelled(base.response ?? {}, BASE_RESPONSE_DIRECTIVES, 'base.json response'),
    ...unmodelled(conn, CONNECTION_DIRECTIVES, 'connection/api.json'),
    ...unmodelled(conn.response ?? {}, CONNECTION_RESPONSE_DIRECTIVES, 'connection/api.json response'),
  ]
  for (const m of app.modules) {
    const api = m.sections.api.json
    failures.push(...unmodelled(api, MODULE_DIRECTIVES, `${m.name}/api.json`))
    failures.push(...unmodelled(api.response ?? {}, MODULE_RESPONSE_DIRECTIVES, `${m.name}/api.json response`))
  }
  if (failures.length) return failures

  const specRes = await fetch(new URL('/openapi.json', base.baseUrl), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!specRes.ok) throw new Error(`openapi.json answered ${specRes.status}`)
  const spec = await specRes.json()

  const connScope = { parameters: { apiKey } }
  const me = await send(resolve(conn.url, connScope), {
    method: conn.method,
    headers: resolve(conn.headers ?? {}, connScope),
  })
  if (me.status !== 200) return [`connection test answered ${me.status}`]
  if (me.body?.data?.livemode !== false) return ['connection test: the key is not a test key (livemode is not false)']
  log('connection test: 200, livemode false')

  for (const m of app.modules) {
    const api = m.sections.api.json
    const apiPath = requestUrl(base.baseUrl, api.url).pathname
    const operation = spec.paths?.[apiPath]?.[api.method.toLowerCase()]
    if (!operation) {
      failures.push(`${m.name}: openapi.json has no ${api.method} ${apiPath}`)
      continue
    }
    let cases
    try {
      cases = JSON.parse(await readFile(join(CASES_DIR, `${m.name}.json`), 'utf8')).cases
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      cases = []
    }
    if (!cases?.length) {
      failures.push(`${m.name}: no case in test/live/${m.name}.json, so the module is not checked`)
      continue
    }
    for (const [i, c] of cases.entries()) {
      const label = `${m.name} [${fixtureNames(c.parameters) || i}]`
      const scope = { connection: { apiKey }, parameters: await loadParameters(c.parameters) }
      const { url, init } = buildRequest(base.baseUrl, base.headers, api, scope)
      const res = await send(url, init)
      if (res.status !== 200) {
        failures.push(`${label}: answered ${res.status}${res.body?.error?.code ? ` ${res.body.error.code}` : ''}`)
        continue
      }
      const answer = { body: res.body, headers: res.headers, statusCode: res.status }
      const output = resolve(api.response.output, answer)
      const before = failures.length
      for (const [where, path] of templates(api.response.output)) {
        const field = where.join('.')
        const found = checkOutputPath(field, path, answer, operation, spec)
        failures.push(...found.map((f) => `${label}: ${f}`))
      }
      for (const field of c.present ?? []) {
        if (!hasValue(lookup(field.split('.'), output))) failures.push(`${label}: output ${field} holds no value`)
      }
      if (failures.length !== before) continue
      log(`${label}: 200, ${templates(api.response.output).length} output fields checked`)
      if (writeSamples && i === 0) {
        await writeFile(m.sections.samples.file, `${JSON.stringify(output, null, 2)}\n`)
        log(`${label}: wrote ${m.name}/samples.json`)
      }
    }
  }
  return failures
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const failures = await runGate({
      apiKey: process.env.BELIQ_API_KEY,
      writeSamples: process.argv.includes('--write-samples'),
    })
    for (const f of failures) console.error(`FAIL ${f}`)
    console.log(failures.length ? `live gate: ${failures.length} failures` : 'live gate: passed')
    process.exitCode = failures.length ? 1 : 0
  } catch (err) {
    console.error(`live gate could not run: ${err.message}`)
    process.exitCode = 2
  }
}
