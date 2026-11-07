// The files the live gate sends, as test/fixtures.json lists them: a vendored byte copy of an
// upstream file, or a mutation of one. A mutation is the base file with one exact text
// replaced, once, and its result checked against a recorded SHA-256, so the bytes the gate
// sends are as traceable as a vendored file without a second copy in the repo.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT } from './app.mjs'

export const FIXTURES_DIR = join(ROOT, 'test', 'vendor')
export const MANIFEST_FILE = join(ROOT, 'test', 'fixtures.json')

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')

export async function readManifest(file = MANIFEST_FILE) {
  const { fixtures = [], mutations = [] } = JSON.parse(await readFile(file, 'utf8'))
  return { fixtures, mutations }
}

// A case parameter that names a file: { fixture: <file> } or { mutation: <name> }.
export const isFileRef = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && ('fixture' in value || 'mutation' in value)

export const refName = (ref) => ref.fixture ?? ref.mutation

// The bytes and the content type of a file reference, checked against the manifest.
export async function loadFile(ref, manifest, dir = FIXTURES_DIR) {
  if ('fixture' in ref) {
    const entry = manifest.fixtures.find((f) => f.file === ref.fixture)
    if (!entry) throw new Error(`${ref.fixture} is not in fixtures.json`)
    const bytes = await readFile(join(dir, entry.file))
    if (sha256(bytes) !== entry.sha256) throw new Error(`${entry.file} is not the byte copy fixtures.json names`)
    return { bytes, contentType: entry.contentType }
  }
  const m = manifest.mutations.find((x) => x.name === ref.mutation)
  if (!m) throw new Error(`the mutation ${ref.mutation} is not in fixtures.json`)
  const base = await loadFile({ fixture: m.base }, manifest, dir)
  const text = base.bytes.toString('utf8')
  const parts = text.split(m.replace)
  if (parts.length !== 2) throw new Error(`the mutation ${m.name}: its text occurs ${parts.length - 1} times in ${m.base}, not once`)
  const bytes = Buffer.from(parts.join(m.with), 'utf8')
  if (sha256(bytes) !== m.sha256) throw new Error(`the mutation ${m.name} does not give the SHA-256 fixtures.json records`)
  return { bytes, contentType: base.contentType }
}
