const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
const assert = require('node:assert/strict')
const { spawn, execFile } = require('node:child_process'), { promisify } = require('node:util')
const { createSDKBackend, executeBridge } = require('../../resources/search/everything-sdk.cjs')
const run = promisify(execFile)
const executable = process.env.STOOLS_EVERYTHING_TEST_EXE, es = process.env.STOOLS_ES_TEST_EXE
if (!executable || !es) throw Error('Set isolated-test Everything and ES executable paths')

/**
 * Retry only bounded, eventually consistent assertions against the isolated folder index.
 * @param {Function} check Assertion returning a promise.
 * @returns {Promise<void>} Completion after a successful assertion.
 * @throws {Error} The last failure when the index does not converge.
 */
async function eventually(check) {
  let last
  for (let i = 0; i < 30; i++) { try { await check(); return } catch (error) { last = error; await new Promise((resolve) => setTimeout(resolve, 200)) } }
  throw last
}

/**
 * Verify SDK behavior against the official ES client using only temporary indexed fixtures.
 * @returns {Promise<void>} Completion after writing a structured verification report.
 * @throws {Error} Any mismatch, missing update or unsafe cleanup target.
 */
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stools-sdk-integration-'))
  const instance = 'stools-sdk-' + process.pid; let fixture = path.join(root, 'SDK资料')
  const bridge = path.resolve(__dirname, '../../resources/search/stools-everything.exe')
  const report = { engine: 'Everything SDK IPC v2', checks: [], timings: {} }
  let child, sdk
  try {
    await fs.mkdir(fixture); fixture = await fs.realpath(fixture)
    for (let i = 0; i < 235; i++) await fs.writeFile(path.join(fixture, 'SDK验收-' + String(i).padStart(3, '0') + '.txt'), 'x'.repeat(i + 1))
    for (const name of ['SDK验收-app.exe', 'SDK验收 two words.pdf', 'SDK验收-CaSe.txt', 'SDK验收-case.txt', 'SDK验收-(a+b)[1].txt']) await fs.writeFile(path.join(fixture, name), 'fixture')
    await fs.mkdir(path.join(fixture, 'SDK验收-folder'))
    const ini = path.join(root, 'Everything.ini')
    await fs.writeFile(ini, '[Everything]\napp_data=0\nrun_as_admin=0\nshow_tray_icon=0\ncheck_for_updates_on_startup=0\nauto_include_fixed_volumes=0\nauto_include_removable_volumes=0\nauto_include_fixed_refs_volumes=0\nauto_include_removable_refs_volumes=0\nfolder_monitor_changes=1\nfolders=' + fixture + '\n')
    child = spawn(executable, ['-instance', instance, '-config', ini, '-db', path.join(root, 'Everything.db'), '-startup'], { windowsHide: true, shell: false, stdio: 'ignore' })
    process.env.ZTOOLS_E2E = '1'
    sdk = createSDKBackend({ helper: bridge, getConfig: () => ({ everything: executable, everythingReady: true, instance }) })
    await eventually(async () => assert.equal((await sdk.status()).phase, 'ready'))
    report.version = (await sdk.status()).current
    for (const query of ['SDK验收 ext:pdf', 'SDK验收-00?.txt', 'SDK验收 "two words"', '<SDK验收-001 | SDK验收-app>', 'SDK验收 !ext:txt', 'regex:^SDK验收-00[12]\\.txt$', 'SDK验收 size:>200', 'SDK验收 dm:today', '"' + fixture + '\\" ext:pdf']) {
      const started = performance.now(), result = await sdk.search(query)
      const { stdout } = await run(es, ['-instance', instance, '-ipc2', '-timeout', '5000', '-n', '100', '-full-path', '-utf8-bom', '-code-page', '65001', '-sort', 'name', query], { windowsHide: true, windowsVerbatimArguments: true, encoding: 'utf8' })
      const expected = stdout.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
      assert.deepEqual(result.items.map((item) => item.path), expected, query)
      assert.ok(expected.length, 'Oracle query must exercise real results: ' + query)
      report.checks.push({ query, matches: result.total, page: result.items.length, milliseconds: Math.round(performance.now() - started) })
    }
    const initial = await sdk.search('regex:^SDK验收-[0-9]+\\.txt$', 'file')
    assert.equal(initial.total, 235)
    const second = await sdk.search('regex:^SDK验收-[0-9]+\\.txt$', 'file', { offset: 100, version: initial.version })
    const third = await sdk.search('regex:^SDK验收-[0-9]+\\.txt$', 'file', { offset: 200, version: initial.version })
    assert.deepEqual([initial.items.length, second.items.length, third.items.length], [100, 100, 35])
    assert.equal(new Set([...initial.items, ...second.items, ...third.items].map((item) => item.path)).size, 235)
    report.checks.push({ pagination: [100, 100, 35], unique: 235 })
    const descending = await sdk.search('regex:^SDK验收-[0-9]+\\.txt$', 'file', {}, { sort: 6 })
    assert.equal(descending.items[0].name, 'SDK验收-234.txt')
    const caseSensitive = await sdk.search('SDK验收-CaSe', 'file', {}, { matchCase: true })
    assert.deepEqual(caseSensitive.items.map((item) => item.name), ['SDK验收-CaSe.txt'])
    const whole = await sdk.search('SDK验收 cas', 'file', {}, { matchWholeWord: true })
    assert.equal(whole.total, 0)
    const paths = await sdk.search('SDK资料 ext:pdf', 'file', {}, { matchPath: true })
    assert.equal(paths.total, 1)
    report.checks.push({ sizeSort: true, caseSensitive: true, wholeWord: true, pathMatch: true })

    // Observe creations, renames and removals through normal refresh, never force an index rebuild.
    const liveQuery = 'SDK动态', created = path.join(fixture, liveQuery + '.txt'), renamed = path.join(fixture, liveQuery + '-rename.txt')
    await sdk.search(liveQuery)
    for (const [kind, mutation, expected] of [
      ['create', () => fs.writeFile(created, 'fixture'), created],
      ['rename', () => fs.rename(created, renamed), renamed],
      ['delete', () => fs.unlink(renamed), null]
    ]) {
      const start = performance.now(); await mutation()
      await eventually(async () => { await sdk.status(); const result = await sdk.search(liveQuery); assert.deepEqual(result.items.map((item) => item.path), expected ? [expected] : []) })
      report.timings[kind] = Math.round(performance.now() - start)
    }
    // A rename beyond the first page must reset a later continuation despite unchanged totals.
    const q = 'regex:^SDK验收-[0-9]+\\.txt$'
    const head = await sdk.search(q, 'file')
    await sdk.search(q, 'file', { offset: 100, version: head.version })
    await fs.rename(path.join(fixture, 'SDK验收-150.txt'), path.join(fixture, 'SDK验收-1500.txt'))
    await eventually(async () => {
      const check = await executeBridge(bridge, { action: 'query', query: 'SDK验收-1500', instance }, new AbortController().signal)
      assert.equal(check.buckets.all.total, 1)
    })
    const reset = await sdk.search(q, 'file', { offset: 200, version: head.version })
    assert.equal(reset.offset, 0)
    assert.ok(reset.version > head.version)
    report.checks.push({ changedPrefixResetsPage: true })
    await fs.writeFile(path.resolve(__dirname, '../../artifacts/sdk-integration.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  } finally {
    sdk?.close()
    if (child) {
      await run(executable, ['-instance', instance, '-exit'], { windowsHide: true, timeout: 5000 }).catch(() => child.kill())
      if (child.exitCode === null) await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 1500).unref() })
    }
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('stools-sdk-integration-')) throw Error('Unsafe cleanup')
    await fs.rm(root, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
