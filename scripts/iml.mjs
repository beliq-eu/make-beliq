// Resolves the IML templates of this app's requests and outputs, as far as they are plain
// path lookups such as {{body.data.valid}} or {{headers.`x-request-id`}}. Anything else, a
// function, an operator, a literal or text around a template, throws: the live gate must not
// guess what Make computes, so a template it cannot read exactly fails the gate instead.
// IML reference: https://developers.make.com/custom-apps-documentation/iml

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const QUOTED = /^`[^`]+`$/
const SINGLE_TEMPLATE = /^\{\{([^{}]*)\}\}$/

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
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => templates(v, [...where, k]))
  }
  return []
}
