#!/usr/bin/env node
// Deploys app/ into beliq's app on Make from a clean checkout of origin/main.
//
//   node scripts/deploy.mjs plan              what differs from the live app, and the plan's id
//   node scripts/deploy.mjs apply <plan-id>   pushes that plan, if neither the checkout nor the
//                                             live app has moved since it was printed
//   node scripts/deploy.mjs publish <module>  publishes a module, which is final: Make never
//                                             deletes a published module or changes its name
//
// A deploy reaches every organisation that installed the app at once, with no review step, so
// each one is a person's yes to a plan this script printed. Every section is read back from
// Make and compared as JSON, before and after it is pushed. Two things cannot be read back and
// are pushed on every deploy: a module's label and description, which Make's GET of a module
// returned stale, and the icon, which Make re-renders (it keeps the shape of the opaque pixels,
// in white, on the theme colour).
//
// An apply creates a new module unpublished, so it can be run in a scenario of the app's
// owner before anyone else sees it; `publish <module>` is the separate step after that run.
// Make's `public` fields read false right after a publish, so the script never reads them and
// cannot tell a published module from an unpublished one: whoever publishes keeps that record.
//
// The Make API token is read from ~/.config/beliq/make-api-token, mode 600, and never printed.
// Make API reference: https://developers.make.com/api-documentation/api-reference/sdk-apps

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CONNECTION_SECTIONS, MODULE_SECTIONS, readApp, ROOT } from './app.mjs'

export const ZONE = 'https://eu1.make.com/api/v2'
// Make suffixed the requested name `beliq` when it created the app. The connection carries
// the same name.
export const APP = 'beliq-pk8e4f'
export const VERSION = 1
export const CONNECTION = 'beliq-pk8e4f'
const TOKEN_FILE = join(homedir(), '.config', 'beliq', 'make-api-token')
const REQUEST_TIMEOUT_MS = 60_000
const PLAN_ID_HEX = 16

const appPath = `/sdk/apps/${APP}/${VERSION}`
const connectionPath = `/sdk/apps/connections/${CONNECTION}`

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sameJson(liveText, repoJson) {
  try {
    return canonical(JSON.parse(liveText)) === canonical(repoJson)
  } catch {
    return false
  }
}

const sha256 = (data) => createHash('sha256').update(data ?? '').digest('hex')

export function makeClient(base, token) {
  return async (method, path, { body, contentType } = {}) => {
    const headers = { Authorization: `Token ${token}` }
    if (body !== undefined) headers['Content-Type'] = contentType
    const res = await fetch(base + path, { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    return { status: res.status, text: Buffer.from(await res.arrayBuffer()).toString('utf8') }
  }
}

function makeError(res) {
  let detail = ''
  try {
    const body = JSON.parse(res.text)
    detail = [body.code, body.message].filter(Boolean).join(' ').slice(0, 300)
  } catch {
    detail = ''
  }
  return `${res.status}${detail ? ` ${detail}` : ''}`
}

async function get(request, path) {
  const res = await request('GET', path)
  if (res.status !== 200 && res.status !== 404) throw new Error(`GET ${path} answered ${makeError(res)}`)
  return res
}

const json = (value) => ({ body: JSON.stringify(value), contentType: 'application/json' })
const sectionBody = (section) => ({ body: section.text, contentType: 'application/json', expected: section.json })

// One section: pushed when the live copy differs, with the two copies kept for the diff. The
// live text goes into the plan id, so an apply refuses a live copy nobody saw in the plan.
async function sectionAction(request, label, path, section, diffs) {
  const live = await get(request, path)
  if (live.status === 200 && sameJson(live.text, section.json)) return []
  const liveText = live.status === 200 ? live.text : ''
  diffs.push({ label, live: liveText, repo: section.text })
  return [{ label, method: 'PUT', path, ...sectionBody(section), readback: true, live: liveText }]
}

// What module.json may hold. `name`, `typeId` and `connection` are set when Make creates the
// module and are not pushed again, so a change to one of them stops the plan.
const MODULE_FIELDS = ['name', 'typeId', 'label', 'description']

export async function plan(request, app) {
  const actions = []
  const diffs = []
  const notes = []

  const liveApp = await get(request, appPath)
  if (liveApp.status !== 200) throw new Error(`the app ${APP} version ${VERSION} does not exist on Make`)
  const live = JSON.parse(liveApp.text).app
  const changed = Object.keys(app.app.json).filter((k) => canonical(live[k]) !== canonical(app.app.json[k]))
  if (changed.length) {
    const before = Object.fromEntries(changed.map((k) => [k, live[k]]))
    const after = Object.fromEntries(changed.map((k) => [k, app.app.json[k]]))
    diffs.push({ label: 'app', live: JSON.stringify(before, null, 2), repo: JSON.stringify(after, null, 2) })
    actions.push({ label: `app ${changed.join(', ')}`, method: 'PATCH', path: appPath, ...json(after), live: JSON.stringify(before) })
  }

  actions.push(...(await sectionAction(request, 'base', `${appPath}/base`, app.base, diffs)))
  for (const s of CONNECTION_SECTIONS) {
    actions.push(...(await sectionAction(request, `connection ${s}`, `${connectionPath}/${s}`, app.connection[s], diffs)))
  }

  const modulesRes = await get(request, `${appPath}/modules`)
  if (modulesRes.status !== 200) throw new Error(`GET ${appPath}/modules answered ${modulesRes.status}`)
  const liveModules = JSON.parse(modulesRes.text).appModules.map((m) => m.name)
  for (const m of app.modules) {
    const modulePath = `${appPath}/modules/${m.name}`
    const { label, description, typeId } = m.module.json
    const extra = Object.keys(m.module.json).filter((k) => !MODULE_FIELDS.includes(k))
    if (extra.length) throw new Error(`${m.name}/module.json holds ${extra.join(', ')}, which the deploy does not push`)
    if (!liveModules.includes(m.name)) {
      actions.push({
        label: `create module ${m.name} (unpublished; publish it with \`publish ${m.name}\` after a run in Make)`,
        method: 'POST',
        path: `${appPath}/modules`,
        ...json({ ...m.module.json, connection: CONNECTION }),
      })
      for (const s of MODULE_SECTIONS) {
        actions.push({ label: `module ${m.name} ${s}`, method: 'PUT', path: `${modulePath}/${s}`, ...sectionBody(m.sections[s]), readback: true })
      }
      continue
    }
    const liveModule = JSON.parse((await get(request, modulePath)).text).appModule
    if (liveModule.typeId !== typeId) {
      throw new Error(`${m.name}: module.json says typeId ${typeId}, Make has ${liveModule.typeId}; Make does not change a module's type`)
    }
    for (const s of MODULE_SECTIONS) {
      actions.push(...(await sectionAction(request, `module ${m.name} ${s}`, `${modulePath}/${s}`, m.sections[s], diffs)))
    }
    actions.push({ label: `module ${m.name} label and description`, method: 'PATCH', path: modulePath, ...json({ label, description }), always: true })
  }
  for (const name of liveModules.filter((n) => !app.modules.some((m) => m.name === n))) {
    notes.push(`the live module ${name} has no folder under app/modules; a published module cannot be deleted, so the deploy leaves it`)
  }

  actions.push(...(await sectionAction(request, 'groups', `${appPath}/groups`, app.groups, diffs)))
  actions.push({ label: 'icon', method: 'PUT', path: `${appPath}/icon`, body: app.icon, contentType: 'image/png', always: true })
  return { actions, diffs, notes }
}

export function planId(commit, actions) {
  const items = actions.map((a) => [a.method, a.path, sha256(a.body), sha256(a.live)])
  return sha256(JSON.stringify({ commit, items })).slice(0, PLAN_ID_HEX)
}

export async function apply(request, app, commit, id, log = console.log) {
  const { actions } = await plan(request, app)
  const current = planId(commit, actions)
  if (current !== id) throw new Error(`the plan is now ${current}, not ${id}; run plan again and read it first`)
  for (const a of actions) {
    const res = await request(a.method, a.path, { body: a.body, contentType: a.contentType })
    if (res.status < 200 || res.status > 299) throw new Error(`${a.label}: ${a.method} ${a.path} answered ${makeError(res)}`)
    if (a.readback) {
      const back = await get(request, a.path)
      if (back.status !== 200 || !sameJson(back.text, a.expected)) throw new Error(`${a.label}: Make's copy differs from the file after the push`)
    }
    log(`done  ${a.label}`)
  }
  const after = await plan(request, app)
  const left = after.actions.filter((a) => !a.always)
  if (left.length) throw new Error(`after the deploy these still differ: ${left.map((a) => a.label).join('; ')}`)
}

export async function publish(request, app, name) {
  if (!app.modules.some((m) => m.name === name)) throw new Error(`no module ${name} under app/modules`)
  const res = await request('POST', `${appPath}/modules/${name}/public`)
  if (res.status < 200 || res.status > 299) throw new Error(`publish ${name} answered ${makeError(res)}`)
}

export function checkTree(root) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  if (git('status', '--porcelain', '--untracked-files=all')) {
    throw new Error('the checkout has changes or untracked files; deploy from a clean checkout of origin/main')
  }
  git('fetch', '--quiet', 'origin', 'main')
  const head = git('rev-parse', 'HEAD')
  const main = git('rev-parse', 'origin/main')
  if (head !== main) throw new Error(`HEAD ${head.slice(0, 7)} is not origin/main ${main.slice(0, 7)}; deploy only what main holds`)
  return head
}

function readToken() {
  if (statSync(TOKEN_FILE).mode & 0o077) throw new Error('the Make API token file must be readable by its owner only (mode 600)')
  const token = readFileSync(TOKEN_FILE, 'utf8').trim()
  if (!token) throw new Error('the Make API token file is empty')
  return token
}

function printDiff({ label, live, repo }) {
  const dir = mkdtempSync(join(tmpdir(), 'make-beliq-plan-'))
  const pretty = (text) => {
    try {
      return `${JSON.stringify(JSON.parse(text), null, 2)}\n`
    } catch {
      return text
    }
  }
  try {
    writeFileSync(join(dir, 'live'), live ? pretty(live) : '')
    writeFileSync(join(dir, 'repo'), pretty(repo))
    const r = (() => {
      try {
        return execFileSync('diff', ['-u', '--label', `live ${label}`, '--label', `repo ${label}`, join(dir, 'live'), join(dir, 'repo')], { encoding: 'utf8' })
      } catch (err) {
        if (err.status === 1) return err.stdout
        throw err
      }
    })()
    console.log(r)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function main([command, arg]) {
  if (!['plan', 'apply', 'publish'].includes(command) || (command !== 'plan' && !arg)) {
    console.error('usage: deploy.mjs plan | apply <plan-id> | publish <module>')
    return 2
  }
  const commit = checkTree(ROOT)
  const request = makeClient(ZONE, readToken())
  const app = await readApp()
  if (command === 'publish') {
    await publish(request, app, arg)
    console.log(`published module ${arg}`)
    return 0
  }
  if (command === 'apply') {
    await apply(request, app, commit, arg)
    console.log(`deployed ${commit.slice(0, 7)} to ${APP} version ${VERSION}; every section reads back equal`)
    return 0
  }
  const { actions, diffs, notes } = await plan(request, app)
  for (const d of diffs) printDiff(d)
  console.log(`plan for ${APP} version ${VERSION} on ${ZONE} at ${commit.slice(0, 7)}:`)
  for (const a of actions) {
    console.log(`  ${a.method.padEnd(5)} ${a.label}${a.always ? ' (cannot be read back, pushed on every deploy)' : ''}`)
  }
  for (const n of notes) console.log(`  note: ${n}`)
  console.log(`plan id: ${planId(commit, actions)}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (err) {
    console.error(`deploy: ${err.message}`)
    process.exitCode = 1
  }
}
