// The API's openapi.json: fetching it and following its $refs, for the live gate and the
// Parse interface generator.
const REQUEST_TIMEOUT_MS = 60_000

export async function fetchSpec(baseUrl) {
  const res = await fetch(new URL('/openapi.json', baseUrl), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`openapi.json answered ${res.status}`)
  return res.json()
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
