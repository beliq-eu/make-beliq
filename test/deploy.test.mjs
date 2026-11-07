// The deploy against a local HTTP server that stores sections the way Make's sdk-apps API
// does, and a throwaway git repo for the checkout guard.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { readApp } from '../scripts/app.mjs'
import { APP, CONNECTION, VERSION, apply, checkTree, makeClient, plan, planId, publish } from '../scripts/deploy.mjs'

const TOKEN = 'test-token'
const appPath = `/sdk/apps/${APP}/${VERSION}`
const connPath = `/sdk/apps/connections/${CONNECTION}`
const app = await readApp()

// path -> stored text; modules -> metadata; requests -> every request after setup.
const make = { sections: new Map(), modules: new Map(), app: {}, requests: [] }

function seedFromRepo() {
  make.sections.clear()
  make.modules.clear()
  make.requests.length = 0
  make.app = { name: APP, version: VERSION, public: false, ...app.app.json }
  make.sections.set(`${appPath}/base`, app.base.text)
  // Make hands groups back reformatted, so the compare must be on JSON, not on bytes.
  make.sections.set(`${appPath}/groups`, JSON.stringify(app.groups.json, null, '\t'))
  for (const s of ['api', 'parameters']) make.sections.set(`${connPath}/${s}`, app.connection[s].text)
  for (const m of app.modules) {
    make.modules.set(m.name, { ...m.module.json, public: false })
    for (const [s, sec] of Object.entries(m.sections)) make.sections.set(`${appPath}/modules/${m.name}/${s}`, sec.text)
  }
}

let server
let request
before(async () => {
  server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      make.requests.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: body.toString('utf8') })
      const send = (status, value, type = 'application/json') => {
        res.writeHead(status, { 'content-type': type })
        res.end(typeof value === 'string' ? value : JSON.stringify(value))
      }
      if (req.headers.authorization !== `Token ${TOKEN}`) return send(401, { message: 'no token' })
      const modulesPath = `${appPath}/modules`
      if (req.url === appPath && req.method === 'GET') return send(200, { app: make.app })
      if (req.url === appPath && req.method === 'PATCH') {
        Object.assign(make.app, JSON.parse(body))
        return send(200, { app: make.app })
      }
      if (req.url === modulesPath && req.method === 'GET') {
        return send(200, { appModules: [...make.modules.values()].map((m) => ({ name: m.name, public: false })) })
      }
      if (req.url === modulesPath && req.method === 'POST') {
        const m = JSON.parse(body)
        make.modules.set(m.name, m)
        return send(200, { appModule: m })
      }
      const moduleMatch = /^\/sdk\/apps\/[^/]+\/\d+\/modules\/([^/]+)(?:\/(public))?$/.exec(req.url)
      if (moduleMatch && make.modules.has(moduleMatch[1])) {
        if (!moduleMatch[2] && req.method === 'GET') return send(200, { appModule: make.modules.get(moduleMatch[1]) })
        if (moduleMatch[2] && req.method === 'POST') return send(200, { changed: true })
        if (!moduleMatch[2] && req.method === 'PATCH') return send(200, { appModule: make.modules.get(moduleMatch[1]) })
      }
      if (req.url === `${appPath}/icon` && req.method === 'PUT') return send(200, { changed: true })
      if (req.method === 'GET') {
        return make.sections.has(req.url) ? send(200, make.sections.get(req.url), 'application/jsonc') : send(404, { message: 'not found' })
      }
      if (req.method === 'PUT') {
        make.sections.set(req.url, body.toString('utf8'))
        return send(200, { change: {} })
      }
      return send(400, { message: `unexpected ${req.method} ${req.url}` })
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  request = makeClient(`http://127.0.0.1:${server.address().port}`, TOKEN)
})
after(() => server.close())

const writes = () => make.requests.filter((r) => r.method !== 'GET')
const sections = (p) => p.actions.filter((a) => !a.always).map((a) => a.label)

test('a live app equal to the repo plans only what cannot be read back', async () => {
  seedFromRepo()
  const p = await plan(request, app)
  assert.deepEqual(sections(p), [])
  assert.deepEqual(p.actions.map((a) => a.label).sort(), ['icon', ...app.modules.map((m) => `module ${m.name} label and description`)].sort())
  assert.equal(writes().length, 0, 'a plan writes nothing')
  assert.ok(make.requests.every((r) => r.auth === `Token ${TOKEN}`))
})

test('a section that differs is planned with its diff, pushed and read back', async () => {
  seedFromRepo()
  make.sections.set(`${appPath}/base`, '{"baseUrl":"https://example.invalid"}')
  const p = await plan(request, app)
  assert.deepEqual(sections(p), ['base'])
  assert.equal(p.diffs[0].label, 'base')
  await apply(request, app, 'c0ffee', planId('c0ffee', p.actions), () => {})
  assert.equal(make.sections.get(`${appPath}/base`), app.base.text)
})

test('an app field that differs is patched with that field only', async () => {
  seedFromRepo()
  make.app.theme = '#000000'
  const p = await plan(request, app)
  assert.deepEqual(sections(p), ['app theme'])
  await apply(request, app, 'c0ffee', planId('c0ffee', p.actions), () => {})
  const patch = writes().find((r) => r.method === 'PATCH' && r.path === appPath)
  assert.deepEqual(JSON.parse(patch.body), { theme: app.app.json.theme })
})

test('apply refuses a plan id that is not the current plan, before writing anything', async () => {
  seedFromRepo()
  const id = planId('c0ffee', (await plan(request, app)).actions)
  make.sections.set(`${appPath}/groups`, '[]')
  make.requests.length = 0
  await assert.rejects(apply(request, app, 'c0ffee', id, () => {}), /run plan again/)
  assert.equal(writes().length, 0)
})

test('a live section that changed after the plan was printed makes its id stale', async () => {
  seedFromRepo()
  make.sections.set(`${appPath}/base`, '{"baseUrl":"https://a.invalid"}')
  const id = planId('c0ffee', (await plan(request, app)).actions)
  make.sections.set(`${appPath}/base`, '{"baseUrl":"https://b.invalid"}')
  make.requests.length = 0
  await assert.rejects(apply(request, app, 'c0ffee', id, () => {}), /run plan again/)
  assert.equal(writes().length, 0)
})

test('a module whose type differs from Make stops the plan', async () => {
  seedFromRepo()
  const [first] = app.modules
  make.modules.set(first.name, { ...make.modules.get(first.name), typeId: first.module.json.typeId + 1 })
  await assert.rejects(plan(request, app), /does not change a module's type/)
})

test('publish posts to the module it names, and only to one under app/modules', async () => {
  seedFromRepo()
  const [first] = app.modules
  await publish(request, app, first.name)
  assert.ok(writes().some((r) => r.method === 'POST' && r.path === `${appPath}/modules/${first.name}/public`))
  await assert.rejects(publish(request, app, 'no-such-module'), /no module/)
})

test('a new commit is a new plan, even with the same actions', async () => {
  seedFromRepo()
  const { actions } = await plan(request, app)
  assert.notEqual(planId('aaa', actions), planId('bbb', actions))
})

test('a module Make does not have yet is created, filled, then published', async () => {
  seedFromRepo()
  const [first] = app.modules
  make.modules.delete(first.name)
  for (const key of [...make.sections.keys()]) if (key.startsWith(`${appPath}/modules/${first.name}/`)) make.sections.delete(key)
  const p = await plan(request, app)
  const labels = sections(p)
  const create = labels.indexOf(`create module ${first.name}`)
  const publish = labels.findIndex((l) => l.startsWith(`publish module ${first.name}`))
  assert.ok(create >= 0 && publish > create)
  assert.equal(labels.slice(create + 1, publish).length, 6, 'all six sections between create and publish')
  await apply(request, app, 'c0ffee', planId('c0ffee', p.actions), () => {})
  const posted = JSON.parse(writes().find((r) => r.method === 'POST' && r.path === `${appPath}/modules`).body)
  assert.equal(posted.connection, CONNECTION)
  assert.ok(writes().some((r) => r.path === `${appPath}/modules/${first.name}/public`))
})

test('a push that Make stores differently fails the deploy', async () => {
  seedFromRepo()
  make.sections.set(`${appPath}/base`, '{}')
  const p = await plan(request, app)
  const original = request
  const lossy = async (method, path, opts) => original(method, path, method === 'PUT' && path.endsWith('/base') ? { ...opts, body: '{}' } : opts)
  await assert.rejects(apply(lossy, app, 'c0ffee', planId('c0ffee', p.actions), () => {}), /differs from the file/)
})

// --- the checkout guard ---

const work = mkdtempSync(join(tmpdir(), 'make-beliq-deploy-test-'))
after(() => rmSync(work, { recursive: true, force: true }))
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function cloneWithOrigin() {
  const origin = mkdtempSync(join(work, 'origin-'))
  git(origin, 'init', '-q', '--bare', '-b', 'main')
  const seed = mkdtempSync(join(work, 'seed-'))
  git(seed, 'init', '-q', '-b', 'main')
  writeFileSync(join(seed, 'a.txt'), 'a\n')
  git(seed, 'add', 'a.txt')
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'a')
  git(seed, 'push', '-q', origin, 'main')
  const clone = mkdtempSync(join(work, 'clone-'))
  git(clone, 'clone', '-q', origin, '.')
  return clone
}

test('a clean checkout of origin/main is deployable', () => {
  const clone = cloneWithOrigin()
  assert.equal(checkTree(clone), git(clone, 'rev-parse', 'HEAD').trim())
})

test('a changed or untracked file stops the deploy', () => {
  const clone = cloneWithOrigin()
  writeFileSync(join(clone, 'new.json'), '{}')
  assert.throws(() => checkTree(clone), /untracked/)
  rmSync(join(clone, 'new.json'))
  writeFileSync(join(clone, 'a.txt'), 'b\n')
  assert.throws(() => checkTree(clone), /changes/)
})

test('a commit that is not on origin/main stops the deploy', () => {
  const clone = cloneWithOrigin()
  writeFileSync(join(clone, 'a.txt'), 'b\n')
  git(clone, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-am', 'b')
  assert.throws(() => checkTree(clone), /is not origin\/main/)
})
