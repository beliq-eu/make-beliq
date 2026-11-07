// Resolves the IML templates of this app's requests and outputs, as far as they are plain
// path lookups such as {{body.data.valid}} or {{headers.`x-request-id`}}, plus the two forms of
// Make's REST universal module template: a `{{...}}` key spreading
// `{{toCollection(parameters.<name>, 'key', 'value')}}`, and a url of `/{{parameters.<name>}}`.
// Anything else, another function, an operator, a literal or other text around a template,
// throws: the live gate must not guess what Make computes, so a template it cannot read exactly
// fails the gate instead.
// IML reference: https://developers.make.com/custom-apps-documentation/iml
// The template: https://developers.make.com/custom-apps-documentation/app-components/modules/universal-module/rest.md

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const QUOTED = /^`[^`]+`$/
const SINGLE_TEMPLATE = /^\{\{([^{}]*)\}\}$/
const SLASH_TEMPLATE = /^\/\{\{([^{}]*)\}\}$/
const TO_COLLECTION = /^\{\{toCollection\(([^(),]*), 'key', 'value'\)\}\}$/
export const SPREAD = '{{...}}'

export class NotAPathError extends Error {}

export function parsePath(expression) {
  const segments = []
  let current = ''
  let quoted = false
  for (const ch of expression.trim()) {
    if (ch === '`') quoted = !quoted
    if (ch === '.' && !quoted) {
      segments.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  segments.push(current)
  const valid = !quoted && segments.every((s) => IDENTIFIER.test(s) || QUOTED.test(s))
  if (!valid) throw new NotAPathError(`not a plain path lookup: {{${expression}}}`)
  return segments.map((s) => (QUOTED.test(s) ? s.slice(1, -1) : s))
}

// The path of a string that is exactly one template, null for a string with no template.
export function templatePath(text) {
  const match = SINGLE_TEMPLATE.exec(text)
  if (match) return parsePath(match[1])
  if (text.includes('{{') || text.includes('}}')) {
    throw new NotAPathError(`text around a template, or a broken one: ${JSON.stringify(text)}`)
  }
  return null
}

// The path of a url that is a slash and one template, null for any other text.
export function slashTemplatePath(text) {
  const match = SLASH_TEMPLATE.exec(text)
  return match ? parsePath(match[1]) : null
}

// The path a `{{...}}` spread reads its key/value array from.
export function spreadPath(value) {
  const keys = Object.keys(value)
  if (keys.length !== 1) throw new NotAPathError(`a ${SPREAD} spread beside other keys: ${keys.join(', ')}`)
  const match = typeof value[SPREAD] === 'string' && TO_COLLECTION.exec(value[SPREAD])
  if (!match) throw new NotAPathError(`a ${SPREAD} spread of anything but toCollection(<path>, 'key', 'value'): ${JSON.stringify(value[SPREAD])}`)
  return parsePath(match[1])
}

// toCollection over an array of {key, value} items. A key that comes twice throws, since which
// one Make keeps is not documented.
export function toCollection(items) {
  if (!Array.isArray(items)) throw new NotAPathError('toCollection over something that is not an array')
  const collection = {}
  for (const item of items) {
    if (item === null || typeof item !== 'object' || typeof item.key !== 'string') {
      throw new NotAPathError('toCollection over an item that has no text key')
    }
    if (Object.hasOwn(collection, item.key)) throw new NotAPathError(`toCollection over the key ${item.key} twice`)
    collection[item.key] = item.value
  }
  return collection
}

const isSpread = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, SPREAD)

export function lookup(segments, scope) {
  let value = scope
  for (const segment of segments) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) return undefined
    value = value[segment]
  }
  return value
}

export function resolve(value, scope) {
  if (typeof value === 'string') {
    const path = templatePath(value)
    return path ? lookup(path, scope) : value
  }
  if (Array.isArray(value)) return value.map((item) => resolve(item, scope))
  if (isSpread(value)) return toCollection(lookup(spreadPath(value), scope))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, scope)]))
  }
  return value
}

// Every template in a value, as [where, path]: `where` is the key path inside the value, so
// for an output mapping it is the output field's own path.
export function templates(value, where = []) {
  if (typeof value === 'string') {
    const path = templatePath(value)
    return path ? [[where, path]] : []
  }
  if (Array.isArray(value)) return value.flatMap((item, i) => templates(item, [...where, String(i)]))
  if (isSpread(value)) return [[[...where, SPREAD], spreadPath(value)]]
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => templates(v, [...where, k]))
  }
  return []
}
