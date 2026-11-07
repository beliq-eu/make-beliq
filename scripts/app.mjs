// Reads the app as it is laid out under app/: one JSON file per section Make stores.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const APP_DIR = join(ROOT, 'app')

export const CONNECTION_SECTIONS = ['api', 'parameters']
export const MODULE_SECTIONS = ['api', 'parameters', 'expect', 'interface', 'samples', 'scope']

async function section(file) {
  const text = await readFile(file, 'utf8')
  return { file, text, json: JSON.parse(text) }
}

export async function readApp(dir = APP_DIR) {
  const modulesDir = join(dir, 'modules')
  const names = (await readdir(modulesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const modules = []
  for (const name of names) {
    const sections = {}
    for (const s of MODULE_SECTIONS) sections[s] = await section(join(modulesDir, name, `${s}.json`))
    modules.push({ name, module: await section(join(modulesDir, name, 'module.json')), sections })
  }
  const connection = {}
  for (const s of CONNECTION_SECTIONS) connection[s] = await section(join(dir, 'connection', `${s}.json`))
  return {
    dir,
    app: await section(join(dir, 'app.json')),
    base: await section(join(dir, 'base.json')),
    groups: await section(join(dir, 'groups.json')),
    icon: await readFile(join(dir, 'icon.png')),
    connection,
    modules,
  }
}
