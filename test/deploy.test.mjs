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
// Every apply in a test gets this, so a broken read-back fails at once rather than sleeping.
const noWait = async () => {}
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
  await apply(request, app, 'c0ffee', planId('c0ffee', p.actions), () => {}, noWait)
  assert.equal(make.sections.get(`${appPath}/base`), app.base.text)
})

test('an app field that differs is patched with that field only', async () => {
  seedFromRepo()
  make.app.theme = '#000000'
  const p = await plan(request, app)
  assert.deepEqual(sections(p), ['app theme'])
  await apply(request, app, 'c0ffee', planId('c0ffee', p.actions), () => {}, noWait)
  const patch = writes().find((r) => r.method === 'PATCH' && r.path === appPath)
  assert.deepEqual(JSON.parse(patch.body), { theme: app.app.json.theme })
})

test('apply refuses a plan id that is not the current plan, before writing anything', async () => {
  seedFromRepo()
  const id = planId('c0ffee', (await plan(request, app)).actions)
  make.sections.set(`${appPath}/groups`, '[]')
  make.requests.length = 0
  await assert.rejects(apply(request, app, 'c0ffee', id, () => {}, noWait), /run plan again/)
  assert.equal(writes().length, 0)
})

test('a live section that changed after the plan was printed makes its id stale', async () => {
  seedFromRepo()
  make.sections.set(`${appPath}/base`, '{"baseUrl":"https://a.invalid"}')
  const id = planId('c0ffee', (await plan(request, app)).actions)
  make.sections.set(`${appPath}/base`, '{"baseUrl":"https://b.invalid"}')
  make.requests.length = 0
  await assert.rejects(apply(request, app, 'c0ffee', id, () => {}, noWait), /run plan again/)
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

function dropModule(name) {
  make.modules.delete(name)
  for (const key of [...make.sections.keys()]) if (key.startsWith(`${appPath}/modules/${name}/`)) make.sections.delete(key)
}

test('modules Make does not have yet are each created and filled, and none is published', async () => {
  seedFromRepo()
  const [kept, ...added] = app.modules
  assert.ok(added.length >= 2, 'the repo holds at least two modules besides the first')
  for (const m of added) dropModule(m.name)
  const p = await plan(request, app)
  const labels = sections(p)
  for (const m of added) {
    const create = labels.findIndex((l) => l.startsWith(`create module ${m.name} (unpublished`))
    assert.ok(create >= 0, `the plan creates ${m.name}`)
    assert.deepEqual(labels.slice(create + 1, create + 7), ['api', 'parameters', 'expect', 'interface', 'samples', 'scope'].map((s) => `module ${m.name} ${s}`))
  }
  assert.ok(!labels.some((l) => l.includes(`module ${kept.name} `)), 'a module equal to the repo is not pushed')
  await apply(request, app, 'c0ffee', planId('c0ffee', p.actions), () => {}, noWait)
  const posted = writes().filter((r) => r.method === 'POST' && r.path === `${appPath}/modules`).map((r) => JSON.parse(r.body))
  assert.deepEqual(posted.map((x) => x.name).sort(), added.map((m) => m.name).sort())
  assert.ok(posted.every((x) => x.connection === CONNECTION))
  for (const m of added) {
    assert.equal(posted.find((x) => x.name === m.name).typeId, m.module.json.typeId)
    for (const [s, sec] of Object.entries(m.sections)) assert.equal(make.sections.get(`${appPath}/modules/${m.name}/${s}`), sec.text)
  }
  assert.ok(!writes().some((r) => r.path.endsWith('/public')), 'an apply publishes nothing')
})

test('a push that Make stores differently fails the deploy', async () => {
  seedFromRepo()
  make.sections.set(`${appPath}/base`, '{}')
  const p = await plan(request, app)
  const original = request
  const lossy = async (method, path, opts) => original(method, path, method === 'PUT' && path.endsWith('/base') ? { ...opts, body: '{}' } : opts)
  const waits = []
  await assert.rejects(apply(lossy, app, 'c0ffee', planId('c0ffee', p.actions), () => {}, async (ms) => waits.push(ms)), /differs from the file/)
  // Read again for a minute in all before it stops, and nothing after base is pushed: two
  // plan reads, then the read-back and one more after each wait.
  assert.deepEqual(waits, [2_000, 4_000, 8_000, 16_000, 30_000])
  assert.equal(make.requests.filter((r) => r.method === 'GET' && r.path === `${appPath}/base`).length, 2 + 1 + waits.length)
  assert.deepEqual(writes().map((r) => r.path), [`${appPath}/base`])
})

test('a read-back that is stale at first is read again until it matches', async () => {
  seedFromRepo()
  const groups = `${appPath}/groups`
  make.sections.set(groups, '[]')
  const p = await plan(request, app)
  assert.deepEqual(sections(p), ['groups'])
  // Make answers the first two reads after the PUT with the copy from before it.
  let stale = 2
  const lagging = async (method, path, opts) => {
    const pushed = make.requests.some((r) => r.method === 'PUT' && r.path === groups)
    if (method === 'GET' && path === groups && pushed && stale > 0) {
      stale--
      return { status: 200, text: '[]' }
    }
    return request(method, path, opts)
  }
  const waits = []
  const log = []
  await apply(lagging, app, 'c0ffee', planId('c0ffee', p.actions), (line) => log.push(line), async (ms) => waits.push(ms))
  assert.deepEqual(waits, [2_000, 4_000])
  assert.equal(log.filter((line) => line.startsWith('wait  groups')).length, 2)
  assert.ok(log.includes('done  icon'))
  assert.deepEqual(JSON.parse(make.sections.get(groups)), app.groups.json)
})

test('the check after the deploy reads again when Make answers it with an old copy', async () => {
  seedFromRepo()
  const groups = `${appPath}/groups`
  make.sections.set(groups, '[]')
  const p = await plan(request, app)
  // The read-back right after the PUT matches; the next read of groups, the check's, is old.
  let reads = 0
  const flaky = async (method, path, opts) => {
    const pushed = make.requests.some((r) => r.method === 'PUT' && r.path === groups)
    if (method === 'GET' && path === groups && pushed && ++reads === 2) return { status: 200, text: '[]' }
    return request(method, path, opts)
  }
  const waits = []
  await apply(flaky, app, 'c0ffee', planId('c0ffee', p.actions), () => {}, async (ms) => waits.push(ms))
  assert.deepEqual(waits, [2_000])
})

test('a new module section that Make does not show yet is read again', async () => {
  seedFromRepo()
  const m = app.modules.at(-1)
  dropModule(m.name)
  const api = `${appPath}/modules/${m.name}/api`
  const p = await plan(request, app)
  // Make answers the first read after the PUT with a 404, as for a section it does not have.
  let missing = 1
  const lagging = async (method, path, opts) => {
    const pushed = make.requests.some((r) => r.method === 'PUT' && r.path === api)
    if (method === 'GET' && path === api && pushed && missing-- > 0) return { status: 404, text: '{"message":"not found"}' }
    return request(method, path, opts)
  }
  const waits = []
  await apply(lagging, app, 'c0ffee', planId('c0ffee', p.actions), () => {}, async (ms) => waits.push(ms))
  assert.deepEqual(waits, [2_000])
  assert.equal(make.sections.get(api), m.sections.api.text)
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
