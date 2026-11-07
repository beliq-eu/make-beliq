#!/usr/bin/env node
// Writes the Parse module's interface.json and its output mapping, the `response.output` of its
// api.json, from the 200 answer of POST /v1/parse in the API's openapi.json. So the fields Make
// offers before a first run are the ones the API declares, under their own names, and none gets
// a default: a field that was not read from the document stays empty in Make.
//
//   node scripts/parse-interface.mjs            fetch openapi.json and write both files
//   node scripts/parse-interface.mjs --check    write nothing; exit 1 when a committed file
//                                               differs from what the live openapi.json gives
//   --spec <file>                               read openapi.json from a file instead
//
// A schema form this script does not map, such as an anyOf of two types or an object with no
// properties, throws rather than being given a type Make might show wrongly.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { APP_DIR } from './app.mjs'
import { deref, fetchSpec } from './openapi.mjs'

export const PARSE_DIR = join(APP_DIR, 'modules', 'parse')
const OPERATION = ['/v1/parse', 'post']

// Words the labels write in capitals, as Make's interface guide asks for abbreviations:
// https://developers.make.com/custom-apps-documentation/component-blocks/interface.md
const CAPITALS = { id: 'ID', vat: 'VAT', urn: 'URN', ctc: 'CTC', url: 'URL' }
const SCALAR_TYPES = { string: 'text', number: 'number', integer: 'integer', boolean: 'boolean' }

export class UnmappedSchemaError extends Error {}

// A word is a run of lower case after at most one capital, or a run of capitals and digits,
// which stays as it is: `rulesetSHA256` is "Ruleset SHA256".
export function label(name) {
  const words = name.match(/[A-Z0-9]+(?![a-z])|[A-Z]?[a-z0-9]+/g) ?? [name]
  const text = words.map((w) => (/^[A-Z0-9]+$/.test(w) ? w : (CAPITALS[w.toLowerCase()] ?? w.toLowerCase()))).join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// The one scalar type of a schema, or of every member of its anyOf/oneOf, as the enums of
// `format` and `documentType` are written.
function scalarType(schema, spec, where) {
  const node = deref(schema, spec)
  const members = node.anyOf ?? node.oneOf
  if (members) {
    const types = [...new Set(members.map((m) => deref(m, spec).type))]
    if (types.length !== 1 || !SCALAR_TYPES[types[0]]) {
      throw new UnmappedSchemaError(`${where}: an anyOf/oneOf of ${types.join(', ')} is not mapped`)
    }
    return SCALAR_TYPES[types[0]]
  }
  return SCALAR_TYPES[node.type]
}

function fields(schema, spec, where) {
  const node = deref(schema, spec)
  if (node.type !== 'object' || !node.properties || !Object.keys(node.properties).length) {
    throw new UnmappedSchemaError(`${where}: an object with no properties is not mapped`)
  }
  return Object.entries(node.properties).map(([name, child]) => field(name, child, spec, `${where}.${name}`))
}

export function field(name, schema, spec, where = name) {
  const node = deref(schema, spec)
  const scalar = scalarType(node, spec, where)
  if (scalar) return { name, type: scalar, label: label(name) }
  if (node.type === 'object') return { name, type: 'collection', label: label(name), spec: fields(node, spec, where) }
  if (node.type === 'array') {
    const items = deref(node.items, spec)
    const itemScalar = items && scalarType(items, spec, `${where}[]`)
    if (itemScalar) return { name, type: 'array', label: label(name), spec: { type: itemScalar, label: label(name) } }
    return { name, type: 'array', label: label(name), spec: fields(items, spec, `${where}[]`) }
  }
  throw new UnmappedSchemaError(`${where}: the schema type ${JSON.stringify(node.type)} is not mapped`)
}

// The interface and the output mapping: one field for each key of the answer's `data`, mapped
// as a whole so the API's answer reaches Make as it came; then `data` itself, as Validate has
// it, and `requestId` from the x-request-id header.
export function generate(spec) {
  const [path, method] = OPERATION
  const response = spec.paths?.[path]?.[method]?.responses?.['200']
  const body = deref(response?.content?.['application/json']?.schema, spec)
  if (!body?.properties?.data) throw new UnmappedSchemaError(`openapi.json has no 200 body with data for ${method.toUpperCase()} ${path}`)
  if (!Object.keys(response.headers ?? {}).some((h) => h.toLowerCase() === 'x-request-id')) {
    throw new UnmappedSchemaError(`openapi.json declares no x-request-id header for ${method.toUpperCase()} ${path}`)
  }
  const data = fields(body.properties.data, spec, 'data')
  const clash = data.filter((f) => ['data', 'requestId'].includes(f.name))
  if (clash.length) throw new UnmappedSchemaError(`data has a key ${clash.map((f) => f.name).join(', ')}, which the module maps from elsewhere`)
  const iface = [
    ...data,
    { name: 'data', type: 'collection', label: 'Full response data' },
    { name: 'requestId', type: 'text', label: 'Request ID' },
  ]
  const output = {
    ...Object.fromEntries(data.map((f) => [f.name, `{{body.data.${f.name}}}`])),
    data: '{{body.data}}',
    requestId: '{{headers.`x-request-id`}}',
  }
  return { iface, output }
}

const text = (value) => `${JSON.stringify(value, null, 2)}\n`

// The two files as they should read, keyed by path.
export async function render(spec, dir = PARSE_DIR) {
  const { iface, output } = generate(spec)
  const apiFile = join(dir, 'api.json')
  const api = JSON.parse(await readFile(apiFile, 'utf8'))
  api.response = { ...api.response, output }
  return { [join(dir, 'interface.json')]: text(iface), [apiFile]: text(api) }
}

export async function differing(files) {
  const out = []
  for (const [file, wanted] of Object.entries(files)) {
    if ((await readFile(file, 'utf8')) !== wanted) out.push(file)
  }
  return out
}

async function loadSpec(args) {
  const i = args.indexOf('--spec')
  if (i >= 0) return JSON.parse(await readFile(args[i + 1], 'utf8'))
  const base = JSON.parse(await readFile(join(APP_DIR, 'base.json'), 'utf8'))
  return fetchSpec(base.baseUrl)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    const files = await render(await loadSpec(args))
    if (args.includes('--check')) {
      const drift = await differing(files)
      for (const f of drift) console.error(`FAIL ${f} differs from what openapi.json gives; run node scripts/parse-interface.mjs and read the diff`)
      console.log(drift.length ? `parse interface: ${drift.length} files drifted` : 'parse interface: matches openapi.json')
      process.exitCode = drift.length ? 1 : 0
    } else {
      for (const [file, content] of Object.entries(files)) await writeFile(file, content)
      console.log(`wrote ${Object.keys(files).join(', ')}`)
    }
  } catch (err) {
    console.error(`parse interface could not run: ${err.message}`)
    process.exitCode = 2
  }
}
