// Checks that the pieces agree with each other: manifest ↔ files, QML ↔
// Model.js, settings ↔ schema. These catch the mistakes the shell only
// reports at runtime (a typo in a Model call, a script that is not there).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { loadModel, pluginDir } from './helpers/model.mjs'

const read = (f) => fs.readFileSync(path.join(pluginDir, f), 'utf8')
const manifest = JSON.parse(read('manifest.json'))
const qmlFiles = ['Panel.qml', 'Service.qml']

describe('manifest.json', () => {
  test('required fields', () => {
    assert.equal(manifest.schemaVersion, 1)
    for (const key of ['id', 'name', 'version', 'author', 'description', 'license'])
      assert.ok(typeof manifest[key] === 'string' && manifest[key], `${key} missing`)
    assert.match(manifest.id, /^[a-z0-9-]+\.[a-z0-9-]+$/)
    assert.ok(!manifest.id.startsWith('omarchy.'), 'omarchy.* ids are reserved')
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  })

  test('every kind has an entry point that exists', () => {
    const entryFor = { 'service': 'service', 'bar-widget': 'barWidget' }
    for (const kind of manifest.kinds) {
      const file = manifest.entryPoints[entryFor[kind]]
      assert.ok(file, `no entry point for ${kind}`)
      assert.ok(fs.existsSync(path.join(pluginDir, file)), `${file} missing`)
    }
  })

  test('moduleName / ipcTarget / serviceFor use the manifest id', () => {
    const panel = read('Panel.qml')
    assert.match(panel, new RegExp(`moduleName: "${manifest.id}"`))
    assert.match(panel, new RegExp(`ipcTarget: "${manifest.id}"`))
    assert.match(panel, new RegExp(`serviceFor\\("${manifest.id}"\\)`))
  })

  test('settings: schema, defaults and Panel.qml agree', () => {
    const { schema, defaults } = manifest.barWidget
    const keys = schema.map((s) => s.key)
    assert.deepEqual(Object.keys(defaults).sort(), [...keys].sort(), 'defaults and schema keys differ')
    for (const s of schema) {
      assert.equal(s.defaultValue, defaults[s.key], `${s.key}: defaultValue ≠ defaults`)
      assert.ok(s.label, `${s.key}: no label`)
    }
    // Every setting("key", fallback) in the widget is declared, with the
    // same default, and every declared setting is used.
    const used = [...read('Panel.qml').matchAll(/setting\("(\w+)",\s*([^)]+)\)/g)]
    assert.deepEqual(used.map((m) => m[1]).sort(), [...keys].sort())
    for (const [, key, fallback] of used) assert.equal(JSON.parse(fallback), defaults[key], `${key}: fallback differs`)
  })
})

describe('QML ↔ Model.js', () => {
  const model = loadModel()
  for (const file of qmlFiles) {
    test(`${file} only calls functions Model.js defines`, () => {
      const calls = new Set([...read(file).matchAll(/\bModel\.(\w+)(?=\s*\()/g)].map((m) => m[1]))
      assert.ok(calls.size > 0)
      for (const fn of calls) assert.equal(typeof model[fn], 'function', `Model.${fn} is not defined`)
    })
  }

  test('Service.qml only runs scripts that exist and are executable', () => {
    const names = [...read('Service.qml').matchAll(/script\("([\w.-]+)"\)/g)].map((m) => m[1])
    assert.ok(names.length >= 4)
    for (const name of names) {
      const p = path.join(pluginDir, 'scripts', name)
      assert.ok(fs.existsSync(p), `scripts/${name} missing`)
      assert.ok(fs.statSync(p).mode & 0o111, `scripts/${name} not executable`)
    }
  })

  test('every script is used', () => {
    const service = read('Service.qml')
    for (const name of fs.readdirSync(path.join(pluginDir, 'scripts')))
      assert.ok(service.includes(`script("${name}")`), `scripts/${name} is never run`)
  })

  // Panel's base type (qs.Ui Panel) is not a BarWidget, so helpers that only
  // BarWidget has must be reached through `bar`. We hit this once already.
  test('Panel.qml does not use BarWidget-only properties unqualified', () => {
    const src = read('Panel.qml')
    for (const prop of ['vertical', 'barSize'])
      assert.doesNotMatch(src, new RegExp(`(?<![.\\w])${prop}\\b(?!:)`), `bare "${prop}" — use bar.${prop}`)
  })

  // The bar facade third-party plugins get has run() but no shellQuote().
  test('no bar.shellQuote (not available to third-party plugins)', () => {
    for (const file of qmlFiles) assert.doesNotMatch(read(file), /shellQuote/)
  })
})

describe('scripts', () => {
  const scripts = fs.readdirSync(path.join(pluginDir, 'scripts'))
  for (const name of scripts) {
    test(`${name}: bash shebang and valid syntax`, () => {
      const file = path.join(pluginDir, 'scripts', name)
      assert.match(fs.readFileSync(file, 'utf8'), /^#!\/bin\/bash\n/)
      const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
    })
  }

  const shellcheck = spawnSync('shellcheck', ['--version']).status === 0
  test('shellcheck is clean', { skip: !shellcheck && 'shellcheck not installed' }, () => {
    const r = spawnSync('shellcheck', scripts.map((s) => path.join(pluginDir, 'scripts', s)), { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stdout)
  })
})

describe('qmllint', () => {
  const candidates = [process.env.QMLLINT, 'qmllint', '/usr/lib/qt6/bin/qmllint', 'qmllint6'].filter(Boolean)
  const bin = candidates.find((c) => spawnSync(c, ['--version']).status === 0)
  // Unresolvable qs.* imports and style hints are expected outside the shell;
  // only syntax errors fail the build.
  for (const file of qmlFiles) {
    test(`${file} parses`, { skip: !bin && 'qmllint not installed' }, () => {
      const out = path.join(fs.mkdtempSync('/tmp/usb-drives-qmllint-'), 'out.json')
      spawnSync(bin, ['--json', out, path.join(pluginDir, file)], { encoding: 'utf8' })
      const report = JSON.parse(fs.readFileSync(out, 'utf8'))
      const syntax = report.files.flatMap((f) => f.warnings)
        .filter((w) => w.id === 'syntax' || w.type === 'critical' && /syntax|expected/i.test(w.message))
      assert.deepEqual(syntax.map((w) => `${w.line}:${w.column} ${w.message}`), [])
    })
  }
})
