const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const readline = require('node:readline')

/**
 * Consume a bounded read-only helper response with backpressure and cancellation.
 * @param {string[]} args Validated metadata command arguments.
 * @param {Function} receive Asynchronous record consumer.
 * @returns {Promise<object>} Complete journal checkpoint.
 * @throws {Error} On helper failure, timeout or incomplete output.
 */
async function readNative(args, receive) {
  const executable = path.join(__dirname, 'stools-ntfs.exe')
  if (!fs.existsSync(executable)) throw new Error('NTFS 索引组件未安装')
  const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let failure = '',
    meta,
    done,
    count = 0
  const exit = new Promise((resolve) => {
    child.on('error', (error) => {
      failure = error.message
      resolve(-1)
    })
    child.on('close', resolve)
  })
  child.stderr.on('data', () => {})
  const timer = setTimeout(() => {
    failure = 'NTFS 索引读取超时'
    child.kill()
  }, 300000)
  try {
    for await (const line of readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity
    })) {
      if (line.length > 65536) throw new Error('无效的 NTFS 索引响应')
      const record = JSON.parse(line.replace(/^\uFEFF/, ''))
      if (record.type === 'error') throw new Error(record.error)
      if (record.type === 'meta') meta = record
      else if (record.type === 'done') done = record
      else if (record.type === 'entry') {
        if (
          !/^\d+$/.test(record.id) ||
          !/^\d+$/.test(record.parent) ||
          typeof record.name !== 'string' ||
          /[\\/\0]/.test(record.name)
        )
          throw new Error('无效的 NTFS 文件记录')
        await receive(record)
        if (++count % 512 === 0) await new Promise((resolve) => setImmediate(resolve))
      }
    }
    const code = await exit
    if (failure || code !== 0 || !meta || !done) throw new Error(failure || 'NTFS 索引响应不完整')
    return { ...meta, next: done.next }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
  }
}

/**
 * Maintain a persistent NTFS identity graph and project only configured paths into search.
 */
class NtfsIndex {
  /**
   * Prepare metadata tables separate from user-visible filename results.
   * @param {object} index Owning local index.
   * @param {Function} read Replaceable transport for deterministic journal replay tests.
   * @returns {NtfsIndex} Native index adapter.
   */
  constructor(index, read = readNative) {
    this.index = index
    this.read = read
    this.db = index.db
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ntfs_nodes(volume TEXT, ref TEXT, parent TEXT, name TEXT, attrs INTEGER, PRIMARY KEY(volume,ref));
      CREATE INDEX IF NOT EXISTS ntfs_parents ON ntfs_nodes(volume,parent);
      CREATE TABLE IF NOT EXISTS ntfs_volumes(volume TEXT PRIMARY KEY, journal TEXT, next TEXT, signature TEXT, dirty INTEGER);
      CREATE TABLE IF NOT EXISTS ntfs_stage(ref TEXT PRIMARY KEY,parent TEXT,name TEXT,attrs INTEGER);
    `)
    this.get = this.db.prepare(
      'SELECT ref,parent,name,attrs FROM ntfs_nodes WHERE volume=? AND ref=?'
    )
    this.put = this.db.prepare(
      'INSERT INTO ntfs_nodes VALUES(?,?,?,?,?) ON CONFLICT(volume,ref) DO UPDATE SET parent=excluded.parent,name=excluded.name,attrs=excluded.attrs'
    )
    this.active = new Set()
    this.failures = new Map()
  }

  /**
   * Select eligible volumes without following network paths or directory links.
   * @returns {string[]} Unique local drive letters.
   */
  volumes() {
    if (process.platform !== 'win32' || this.index.config.nativeDisabled) return []
    return [
      ...new Set(
        this.index.config.roots
          .filter((root) => /^[a-z]:\\/i.test(root))
          .map((root) => root.slice(0, 2).toUpperCase())
      )
    ]
  }

  /**
   * Resolve parents through the fixed root identity, including snapshots that omit its record.
   * @param {string} volume Drive letter.
   * @param {string} ref File reference including its reuse sequence number.
   * @param {Map} cache Directory path cache for this batch.
   * @returns {string|null} Original-cased absolute path, or null outside supported topology.
   */
  resolve(volume, ref, cache = new Map()) {
    const chain = [],
      seen = new Set()
    let current = ref,
      resolved = null
    while (chain.length < 1024) {
      if (cache.has(current)) {
        resolved = cache.get(current)
        break
      }
      if (seen.has(current)) return null
      seen.add(current)
      // FSCTL_ENUM_USN_DATA can omit the root record (USN zero); its MFT identity is still fixed.
      if ((BigInt(current) & 0xffffffffffffn) === 5n) {
        resolved = volume + '\\'
        break
      }
      const node = this.get.get(volume, current)
      if (!node || node.attrs & 0x400) return null
      if (
        (BigInt(current) & 0xffffffffffffn) < 16n ||
        !node.name ||
        node.name === '.' ||
        node.name === '..'
      )
        return null
      chain.push(node)
      current = node.parent
    }
    if (resolved === null) return null
    for (let n = chain.length - 1; n >= 0; n--) {
      resolved = path.join(resolved, chain[n].name)
      // Cache directories only so million-file disks do not duplicate all full paths in memory.
      if (chain[n].attrs & 0x10) cache.set(chain[n].ref, resolved)
    }
    return resolved
  }

  /**
   * Publish a metadata node only when its resolved path belongs to the configured scope.
   * @param {string} volume Drive letter.
   * @param {object} row NTFS node.
   * @param {Map} cache Parent resolution cache.
   * @returns {void} No value.
   */
  project(volume, row, cache) {
    const filename = this.resolve(volume, row.ref, cache)
    if (!filename || this.index.excluded(filename)) return
    const root = this.index.config.roots.find((item) =>
      filename.toLowerCase().startsWith(item.toLowerCase().replace(/[\\/]+$/, '') + path.sep)
    )
    if (root && this.index.keyOf(filename) !== this.index.keyOf(root))
      this.index.upsert(filename, Boolean(row.attrs & 0x10), root)
  }

  /**
   * Return a subtree with indexed identity and parent lookups, preserving cycle-safe traversal.
   * @param {string} volume Drive letter.
   * @param {string} ref Ancestor file reference.
   * @returns {object[]} Nodes affected by a directory rename or removal.
   */
  descendants(volume, ref) {
    // Drive recursion from the current subtree; CROSS JOIN prevents a whole-volume outer scan.
    return this.db
      .prepare(
        `WITH RECURSIVE tree(ref,parent,name,attrs) AS (
          SELECT ref,parent,name,attrs FROM ntfs_nodes WHERE volume=? AND ref=?
          UNION
          SELECT n.ref,n.parent,n.name,n.attrs FROM tree t CROSS JOIN ntfs_nodes n
            ON n.volume=? AND n.parent=t.ref WHERE n.ref!=n.parent
        ) SELECT ref,parent,name,attrs FROM tree`
      )
      .all(volume, ref, volume)
  }

  /**
   * Read MFT once into a staging table, then rebuild the selected search scope in batches.
   * @param {string} volume Drive letter.
   * @returns {Promise<object>} Snapshot checkpoint for subsequent journal replay.
   */
  async snapshot(volume) {
    this.db.exec('DELETE FROM ntfs_stage')
    const stage = this.db.prepare('INSERT OR REPLACE INTO ntfs_stage VALUES(?,?,?,?)')
    let batch = []
    /**
     * Flush one metadata batch without exposing a half-complete graph.
     * @returns {void} No value.
     */
    const flush = () => {
      this.db.exec('BEGIN')
      try {
        for (const row of batch) stage.run(row.id, row.parent, row.name, row.attributes)
        this.db.exec('COMMIT')
        batch = []
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    const checkpoint = await this.read(['snapshot', volume], async (row) => {
      batch.push(row)
      if (batch.length >= 1024) flush()
    })
    flush()
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM ntfs_nodes WHERE volume=?').run(volume)
      this.db
        .prepare('INSERT INTO ntfs_nodes SELECT ?,ref,parent,name,attrs FROM ntfs_stage')
        .run(volume)
      this.db.exec('DELETE FROM ntfs_stage')
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    const roots = this.index.config.roots.filter(
      (root) => root.slice(0, 2).toUpperCase() === volume
    )
    for (const root of roots) {
      const removed = this.db
        .prepare('DELETE FROM entries WHERE root=?')
        .run(this.index.keyOf(root))
      if (removed.changes) this.index.state.version = ++this.index.version
    }
    const cache = new Map()
    let after = ''
    while (!this.index.stopped) {
      const rows = this.db
        .prepare(
          'SELECT ref,parent,name,attrs FROM ntfs_nodes WHERE volume=? AND ref>? ORDER BY ref LIMIT 512'
        )
        .all(volume, after)
      if (!rows.length) break
      this.db.exec('BEGIN')
      try {
        for (const row of rows) this.project(volume, row, cache)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
      after = rows.at(-1).ref
      this.index.state.scanned += rows.length
      this.index.state.count = this.index.count()
      this.index.state.current = volume + '\\'
      await new Promise((resolve) => setImmediate(resolve))
    }
    return checkpoint
  }

  /**
   * Apply a replayable journal batch; old directory paths are removed before reprojection.
   * @param {string} volume Drive letter.
   * @param {object[]} rows Chronological change records.
   * @returns {Promise<void>} Delta projection completion.
   */
  async applyChanges(volume, rows) {
    // Collapse events by identity to the final state, while remembering the original subtree paths.
    const latest = new Map()
    for (const row of rows) latest.set(row.id, row)
    // USN reasons accumulate while handles stay open; unchanged metadata must not invalidate pages.
    for (const [ref, row] of latest) {
      const previous = this.get.get(volume, ref)
      if (
        row.reason & 0x200
          ? !previous
          : previous &&
            previous.parent === row.parent &&
            previous.name === row.name &&
            previous.attrs === row.attributes
      )
        latest.delete(ref)
    }
    if (!latest.size) return
    const affected = new Set(),
      oldPaths = new Set()
    for (const [ref] of latest) {
      for (const child of this.descendants(volume, ref)) affected.add(child.ref)
      const oldPath = this.resolve(volume, ref)
      if (oldPath) oldPaths.add(oldPath)
      affected.add(ref)
    }
    this.db.exec('BEGIN')
    try {
      for (const filename of oldPaths) this.index.deleteTree(this.index.keyOf(filename))
      for (const [ref, row] of latest) {
        if (row.reason & 0x200)
          this.db.prepare('DELETE FROM ntfs_nodes WHERE volume=? AND ref=?').run(volume, ref)
        else this.put.run(volume, ref, row.parent, row.name, row.attributes)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    const cache = new Map(),
      refs = [...affected]
    for (let start = 0; start < refs.length; start += 512) {
      this.db.exec('BEGIN')
      try {
        for (const ref of refs.slice(start, start + 512)) {
          const row = this.get.get(volume, ref)
          if (row) this.project(volume, row, cache)
        }
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  /**
   * Resume a durable journal cursor or rebuild on changed configuration, rollover or interruption.
   * @param {string} volume Drive letter.
   * @param {boolean} force Force fresh MFT enumeration.
   * @returns {Promise<void>} Index update completion.
   * @throws {Error} When native access is unavailable; the caller selects directory fallback.
   */
  async sync(volume, force = false) {
    // Invalidate projections written by earlier versions that required a returned root record.
    const signature = JSON.stringify([
      2,
      this.index.config.roots,
      this.index.config.excluded,
      this.index.config.dataDirectory
    ])
    const saved = this.db.prepare('SELECT * FROM ntfs_volumes WHERE volume=?').get(volume)
    /**
     * Persist the recovery marker only before graph/search mutations.
     * @returns {void} No value.
     */
    const markDirty = () =>
      this.db
        .prepare(
          'INSERT INTO ntfs_volumes(volume,dirty) VALUES(?,1) ON CONFLICT(volume) DO UPDATE SET dirty=1'
        )
        .run(volume)
    let checkpoint
    const rebuild = force || !saved || saved.dirty || saved.signature !== signature
    if (rebuild) {
      markDirty()
      checkpoint = await this.snapshot(volume)
    } else checkpoint = saved
    try {
      const changes = []
      const next = await this.read(
        ['changes', volume, checkpoint.journal, checkpoint.next],
        async (row) => {
          if (changes.length >= 250000)
            throw new Error('JOURNAL_RESET: change backlog requires snapshot')
          changes.push(row)
        }
      )
      if (changes.length) {
        markDirty()
        await this.applyChanges(volume, changes)
      }
      checkpoint = next
    } catch (error) {
      if (!/JOURNAL_RESET|journal.*(deleted|active)|日志/i.test(error.message)) throw error
      markDirty()
      checkpoint = await this.snapshot(volume)
      // Leave the cursor before enumeration so changes during the snapshot are replayed on the next poll.
    }
    if (
      rebuild ||
      saved?.journal !== checkpoint.journal ||
      saved?.next !== checkpoint.next ||
      this.db.prepare('SELECT dirty FROM ntfs_volumes WHERE volume=?').get(volume)?.dirty
    )
      this.db
        .prepare('UPDATE ntfs_volumes SET journal=?,next=?,signature=?,dirty=0 WHERE volume=?')
        .run(checkpoint.journal, checkpoint.next, signature, volume)
    this.active.add(volume)
    this.failures.delete(volume)
  }
}
module.exports = { NtfsIndex, readNative }
