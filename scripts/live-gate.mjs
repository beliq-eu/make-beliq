#!/usr/bin/env node
// Sends the requests the app's files describe to the live beliq API, with a `blq_test_` key,
// and checks the answers against the API's own openapi.json:
//
// - the connection's test request answers 200 for a key whose livemode is false;
// - each module's request, built from base.json and the module's api.json, answers 200 for
//   every case in test/live/<module>.json;
// - every body path an output field maps is declared in openapi.json for that answer, and one
//   that openapi.json requires holds a value; a mapped header is one openapi.json declares;
// - the output fields a case lists under `present` hold a value, those under `equals` hold
//   exactly that value, and each array under `includes` holds an item with those fields.
//
// Make's own request and response layer is not run here; a scenario in Make is the only check
// of that. Templates are resolved by scripts/iml.mjs, which fails on anything but a path and
// the two forms of Make's REST universal module template.
//
// A case marked `quotaExempt` spends no test document, and ci.yml's preflight does not count
// it; the gate allows the mark only on a request to a path openapi.json describes as costing
// no quota.
//
// Usage: BELIQ_API_KEY=blq_test_... node scripts/live-gate.mjs [--write-samples]
// --write-samples writes a module's samples.json from the output of its case marked `sample`.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { readApp, ROOT } from './app.mjs'
import { isFileRef, loadFile, readManifest, refName } from './fixtures.mjs'
import { lookup, resolve, slashTemplatePath, templates } from './iml.mjs'

const REQUEST_TIMEOUT_MS = 60_000
const CASES_DIR = join(ROOT, 'test', 'live')
// openapi.json's summary of GET /v1/me: "Account, plan, and quota context for the calling API
// key (no quota cost)." No other path is described so.
export const QUOTA_EXEMPT_PATHS = ['/v1/me']

// The directives each file may use. A directive outside these lists changes what Make sends
// or returns in a way the gate does not model, so it fails the gate instead of being skipped.
// base.json's `response.error` and `log`, and the connection's `response.error` and `log`,
// shape only Make's error text and its log, so the gate reads none of them. The connection's
// `response.valid` decides Make's verdict on the connection test; the gate models it only in
// its one form below and fails on any other.
const MODULE_DIRECTIVES = ['url', 'method', 'type', 'headers', 'qs', 'body', 'response']
const MODULE_RESPONSE_DIRECTIVES = ['output']
const BASE_DIRECTIVES = ['baseUrl', 'headers', 'response', 'log']
const BASE_RESPONSE_DIRECTIVES = ['error']
const CONNECTION_DIRECTIVES = ['url', 'method', 'headers', 'response', 'log']
const CONNECTION_RESPONSE_DIRECTIVES = ['valid', 'error']
const CONNECTION_VALID = '{{statusCode = 200}}'

export function unmodelled(directives, allowed, where) {
  return Object.keys(directives)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${where}: the gate does not model the directive \`${key}\``)
}

export function deref(schema, spec) {
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
    // The whole header collection, as the universal module maps it, names no header to check.
    if (rest.length === 0) return []
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

async function loadParameters(parameters, manifest) {
  const loaded = {}
  for (const [name, value] of Object.entries(parameters)) {
    loaded[name] = isFileRef(value) ? (await loadFile(value, manifest)).bytes : value
  }
  return loaded
}

function caseName(parameters) {
  const files = Object.values(parameters).filter(isFileRef).map(refName)
  if (files.length) return files.join(', ')
  return [parameters.method, parameters.url].filter((v) => typeof v === 'string').join(' ')
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

// A module's url must be relative to the base URL: a path, or a slash and one template, as the
// universal module has it. Make does not approve a universal module that lets a user point the
// request, and the connection's key, at another host:
// https://developers.make.com/custom-apps-documentation/app-components/modules/universal-module.md
export function checkRelativeUrl(url, where) {
  if (typeof url !== 'string') return [`${where}: url is not text`]
  if (slashTemplatePath(url)) return []
  if (url.startsWith('/') && !url.startsWith('//') && !url.includes('{{')) return []
  return [`${where}: url ${JSON.stringify(url)} is not a path relative to the base URL`]
}

// The path a url resolves to. For `/{{path}}`, Make drops the doubled slash when the value
// starts with one ("it is automatically removed", universal-module/rest.md); what Make does with
// a value that starts with two slashes, or with a scheme, is not documented, so that throws.
export function resolveUrl(url, scope) {
  const path = slashTemplatePath(url)
  if (!path) return resolve(url, scope)
  const value = lookup(path, scope)
  if (typeof value !== 'string' || !value) throw new Error(`the url parameter ${path.join('.')} is not a non-empty text`)
  if (value.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new Error(`the url value ${JSON.stringify(value)} is not modelled: what Make sends for it is unmeasured`)
  }
  return value.startsWith('/') ? value : `/${value}`
}

function buildBody(api, scope) {
  if (api.body === undefined) return undefined
  const body = resolve(api.body, scope)
  if (api.type === 'binary') {
    if (!Buffer.isBuffer(body)) throw new Error('a binary request body must map a file parameter')
    return body
  }
  if (api.type === 'text') {
    if (body === undefined || body === null || body === '') return undefined
    if (typeof body !== 'string') throw new Error('a text request body that is not text is not modelled')
    return body
  }
  throw new Error(`request type ${api.type} is not modelled; only binary and text are`)
}

export function buildRequest(baseUrl, baseHeaders, api, scope) {
  const url = requestUrl(baseUrl, resolveUrl(api.url, scope))
  for (const [k, v] of Object.entries(resolve(api.qs ?? {}, scope))) url.searchParams.set(k, String(v))
  const headers = { ...resolve(baseHeaders ?? {}, scope), ...resolve(api.headers ?? {}, scope) }
  const method = resolve(api.method, scope)
  if (typeof method !== 'string') throw new Error('the request method does not resolve to text')
  return { url, init: { method, headers, body: buildBody(api, scope) } }
}

// The checks a case lists on the module's output, beyond the openapi.json paths.
export function checkCase(c, output) {
  const failures = []
  const at = (field) => lookup(field.split('.'), output)
  for (const field of c.present ?? []) {
    if (!hasValue(at(field))) failures.push(`output ${field} holds no value`)
  }
  for (const [field, wanted] of Object.entries(c.equals ?? {})) {
    if (!isDeepStrictEqual(at(field), wanted)) failures.push(`output ${field} is ${JSON.stringify(at(field))}, not ${JSON.stringify(wanted)}`)
  }
  for (const [field, wanted] of Object.entries(c.includes ?? {})) {
    const items = at(field)
    const match = Array.isArray(items) && items.some((item) => Object.entries(wanted).every(([k, v]) => isDeepStrictEqual(item?.[k], v)))
    if (!match) failures.push(`output ${field} holds no item with ${JSON.stringify(wanted)}`)
  }
  return failures
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
    failures.push(...checkRelativeUrl(api.url, `${m.name}/api.json`))
  }
  if (conn.response?.valid !== CONNECTION_VALID) {
    failures.push(`connection/api.json: response.valid is not ${CONNECTION_VALID}, the one form the gate models`)
  }
  if (failures.length) return failures

  const specRes = await fetch(new URL('/openapi.json', base.baseUrl), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!specRes.ok) throw new Error(`openapi.json answered ${specRes.status}`)
  const spec = await specRes.json()
  const manifest = await readManifest()

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
      const label = `${m.name} [${caseName(c.parameters) || i}]`
      const scope = { connection: { apiKey }, parameters: await loadParameters(c.parameters, manifest) }
      const { url, init } = buildRequest(base.baseUrl, base.headers, api, scope)
      const operation = spec.paths?.[url.pathname]?.[init.method.toLowerCase()]
      if (!operation) {
        failures.push(`${label}: openapi.json has no ${init.method} ${url.pathname}`)
        continue
      }
      if (c.quotaExempt && !QUOTA_EXEMPT_PATHS.includes(url.pathname)) {
        failures.push(`${label}: marked quotaExempt, but ${url.pathname} spends a test document`)
        continue
      }
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
      failures.push(...checkCase(c, output).map((f) => `${label}: ${f}`))
      if (failures.length !== before) continue
      log(`${label}: 200, ${templates(api.response.output).length} output fields checked`)
      if (writeSamples && c.sample) {
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
