const fs = require('node:fs')
const { NtfsIndex } = require('./ntfs-index.cjs')
const { compileQuery, like } = require('./query.cjs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { parentPort, workerData } = require('node:worker_threads')

/**
 * 统一索引路径；Windows 不区分大小写，查询参数始终单独绑定。
 * @param {string} value 文件路径。
 * @returns {string} 用于数据库比较的绝对路径。
 */
function keyOf(value) {
  const normalized = path.resolve(value).replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * 建立属于 sTools 的持久文件名索引，数据库仅在工作线程中使用。
 */
class LocalIndex {
  /**
   * 打开索引及 FTS 加速表。
   * @param {string} filename 索引文件位置。
   * @param {object} config 根目录及排除项配置。
   * @returns {LocalIndex} 索引实例。
   */
  constructor(filename, config) {
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    this.config = config
    this.keyOf = keyOf
    this.excludedNames = new Set(
      config.excluded.filter((entry) => !/[\\/]/.test(entry)).map((entry) => entry.toLowerCase())
    )
    this.excludedPaths = config.excluded
      .filter((entry) => /[\\/]/.test(entry))
      .map((entry) => keyOf(entry).replace(/\/$/, ''))
    if (config.dataDirectory)
      this.excludedPaths.push(keyOf(config.dataDirectory).replace(/\/$/, ''))
    this.db = new DatabaseSync(filename)
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA temp_store=MEMORY;
      PRAGMA cache_size=-16000;
      CREATE TABLE IF NOT EXISTS entries(
        id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, path TEXT NOT NULL,
        name TEXT NOT NULL, search TEXT NOT NULL, parent TEXT NOT NULL,
        kind TEXT NOT NULL, root TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS entries_root ON entries(root);
      CREATE INDEX IF NOT EXISTS entries_parent ON entries(parent);
      CREATE INDEX IF NOT EXISTS entries_kind ON entries(kind);
      CREATE VIRTUAL TABLE IF NOT EXISTS names USING fts5(search, content='entries', content_rowid='id', tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
        INSERT INTO names(rowid, search) VALUES(new.id, new.search);
      END;
      CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
        INSERT INTO names(names, rowid, search) VALUES('delete', old.id, old.search);
      END;
      CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE OF search ON entries WHEN old.search != new.search BEGIN
        INSERT INTO names(names, rowid, search) VALUES('delete', old.id, old.search);
        INSERT INTO names(rowid, search) VALUES(new.id, new.search);
      END;
    `)
    this.put = this.db
      .prepare(`INSERT INTO entries(key,path,name,search,parent,kind,root) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET path=excluded.path,name=excluded.name,search=excluded.search,parent=excluded.parent,kind=excluded.kind,root=excluded.root
      WHERE entries.path!=excluded.path OR entries.kind!=excluded.kind OR entries.root!=excluded.root`)
    this.entryKind = this.db.prepare('SELECT kind FROM entries WHERE key=?')
    this.children = this.db.prepare('SELECT key FROM entries WHERE parent=?')
    this.remove = this.db.prepare('DELETE FROM entries WHERE key=? OR (key>=? AND key<?)')
    this.db.exec(
      'CREATE TEMP TABLE IF NOT EXISTS search_page(seq INTEGER PRIMARY KEY, id INTEGER, kind TEXT); CREATE INDEX IF NOT EXISTS search_page_kind ON search_page(kind,seq);'
    )
    this.native = new NtfsIndex(this)
    this.queryCache = null
    this.version = Date.now()
    this.state = {
      phase: 'starting',
      count: this.count(),
      scanned: 0,
      skipped: 0,
      current: '',
      warning: '',
      version: this.version,
      nativeVolumes: [],
      fallbackVolumes: [],
      lastScanMs: 0
    }
    this.watchers = []
    this.pending = new Set()
    this.busy = false
    this.stopped = false
  }

  /**
   * 读取已持久保存的索引条目数量。
   * @returns {number} 条目数。
   */
  count() {
    return Number(this.db.prepare('SELECT COUNT(*) n FROM entries').get().n)
  }

  /**
   * 检查路径是否位于排除目录或索引库自身下面。
   * @param {string} filename 待检查的完整路径。
   * @returns {boolean} 是否排除。
   */
  excluded(filename) {
    const key = keyOf(filename).toLowerCase()
    return (
      this.excludedPaths.some((prefix) => key === prefix || key.startsWith(prefix + '/')) ||
      key.split('/').some((part) => this.excludedNames.has(part))
    )
  }

  /**
   * 删除一个索引路径及其后代；只改数据库，不删除磁盘文件。
   * @param {string} key 标准化后的路径。
   * @returns {void} 无返回值。
   */
  deleteTree(key) {
    const result = this.remove.run(key, key.replace(/\/$/, '') + '/', key.replace(/\/$/, '') + '0')
    if (result.changes) this.state.version = ++this.version
  }

  /**
   * 保存一个已通过目录边界检查的条目。
   * @param {string} filename 原始路径。
   * @param {boolean} directory 是否是目录。
   * @param {string} root 所属搜索根目录。
   * @returns {void} 无返回值。
   */
  upsert(filename, directory, root) {
    // 目录被替换为同名文件时，同时清理旧的子树索引。
    if (!directory && this.entryKind.get(keyOf(filename))?.kind === 'folder')
      this.deleteTree(keyOf(filename))
    const name = path.basename(filename)
    const kind = directory ? 'folder' : /\.(exe|lnk|appref-ms)$/i.test(name) ? 'app' : 'file'
    const result = this.put.run(
      keyOf(filename),
      filename,
      name,
      name.toLowerCase(),
      keyOf(path.dirname(filename)),
      kind,
      keyOf(root)
    )
    if (result.changes) this.state.version = ++this.version
  }

  /**
   * 分批遍历目录并协调删除项，扫描期间允许查询穿插运行。
   * @param {string} start 扫描起点。
   * @param {string} root 所属搜索根目录。
   * @returns {Promise<void>} 扫描完成后的 Promise。
   */
  async scanTree(start, root) {
    const queue = [start]
    for (let cursor = 0; cursor < queue.length && !this.stopped; cursor++) {
      const directory = queue[cursor]
      if (this.excluded(directory)) continue
      this.state.current = directory
      let entries
      try {
        const stat = await fs.promises.lstat(directory)
        // 不沿符号链接、目录联接遍历，避免越界或循环。
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue
        entries = await fs.promises.readdir(directory, { withFileTypes: true })
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') this.deleteTree(keyOf(directory))
        else {
          this.state.skipped++
          this.state.warning = '部分目录无法读取，已跳过；可在搜索范围中调整。'
        }
        continue
      }
      const found = new Set()
      for (let offset = 0; offset < entries.length; offset += 256) {
        // 小事务与主动让出事件循环避免长目录阻塞实时查询。
        this.db.exec('BEGIN')
        try {
          for (const entry of entries.slice(offset, offset + 256)) {
            const filename = path.join(directory, entry.name)
            if (
              entry.isSymbolicLink() ||
              this.excluded(filename) ||
              (!entry.isDirectory() && !entry.isFile())
            )
              continue
            found.add(keyOf(filename))
            this.upsert(filename, entry.isDirectory(), root)
            if (entry.isDirectory()) queue.push(filename)
            this.state.scanned++
          }
          this.db.exec('COMMIT')
        } catch (error) {
          this.db.exec('ROLLBACK')
          throw error
        }
        await new Promise((resolve) => setImmediate(resolve))
      }
      // 读取失败的目录不会进入这里，因此不会误删不可访问目录的旧索引。
      for (const old of this.children.all(keyOf(directory)))
        if (!found.has(old.key)) this.deleteTree(old.key)
      if (cursor % 100 === 0) this.state.count = this.count()
    }
  }

  /**
   * 扫描所有配置根目录，保留可查询快照并清除已移出范围的旧条目。
   * @param {boolean} force 是否强制重新枚举文件表。
   * @returns {Promise<void>} 协调完成后的 Promise。
   */
  async reconcile(force = false) {
    if (this.busy || this.stopped) return
    this.busy = true
    const started = Date.now()
    this.state.warning = ''
    this.state.phase = 'scanning'
    this.state.scanned = 0
    this.state.skipped = 0
    try {
      const roots = this.config.roots.map(keyOf)
      for (const row of this.db.prepare('SELECT DISTINCT root FROM entries').all()) {
        if (!roots.includes(row.root) || this.excluded(row.root)) {
          const removed = this.db.prepare('DELETE FROM entries WHERE root=?').run(row.root)
          if (removed.changes) this.state.version = ++this.version
        }
      }
      for (const volume of this.native.volumes()) {
        try {
          await this.native.sync(volume, force)
        } catch (error) {
          this.native.active.delete(volume)
          this.native.failures.set(volume, error.message)
        }
      }
      this.state.nativeVolumes = [...this.native.active]
      this.state.fallbackVolumes = [...this.native.failures.keys()]
      if (this.state.fallbackVolumes.length)
        this.state.warning = '部分磁盘使用普通扫描；启用快速索引服务后可读取 NTFS 文件表。'
      for (const root of this.config.roots) {
        if (!this.native.active.has(root.slice(0, 2).toUpperCase())) await this.scanTree(root, root)
      }
      this.state.phase = 'ready'
      this.state.current = ''
    } catch (error) {
      this.state.phase = 'error'
      this.state.warning = error.message
    } finally {
      this.state.count = this.count()
      this.state.lastScanMs = Date.now() - started
      this.busy = false
    }
  }

  /**
   * 合并目录变动后刷新受影响的子树，处理新增、改名和删除。
   * @returns {Promise<void>} 增量更新完成后的 Promise。
   */
  async flushChanges() {
    if (this.busy || this.stopped || !this.pending.size) return
    this.busy = true
    const changes = [...this.pending]
    this.pending.clear()
    try {
      for (const filename of changes) {
        if (this.excluded(filename) || this.native.active.has(filename.slice(0, 2).toUpperCase()))
          continue
        const key = keyOf(filename)
        const root = this.config.roots.find(
          (item) => key === keyOf(item) || key.startsWith(keyOf(item).replace(/\/$/, '') + '/')
        )
        if (!root) continue
        try {
          const stat = await fs.promises.lstat(filename)
          if (stat.isSymbolicLink()) {
            this.deleteTree(key)
            continue
          }
          if (stat.isDirectory()) {
            if (key !== keyOf(root)) this.upsert(filename, true, root)
            await this.scanTree(filename, root)
          } else if (stat.isFile()) this.upsert(filename, false, root)
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') this.deleteTree(key)
          else this.state.skipped++
        }
      }
    } catch (error) {
      this.state.warning = error.message
    } finally {
      this.state.count = this.count()
      this.busy = false
    }
  }

  /**
   * 启动目录通知及定期协调，以修复通知丢失和离线期间的变更。
   * @returns {void} 无返回值。
   */
  start() {
    for (const root of this.config.roots) {
      try {
        const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
          if (!filename) return
          const changed = path.resolve(root, String(filename))
          if (this.excluded(changed) || this.native.active.has(root.slice(0, 2).toUpperCase()))
            return
          // 大量变更时退回根目录协调，避免队列无限增长。
          if (this.pending.size < 5000) this.pending.add(changed)
          else {
            this.pending.clear()
            this.pending.add(root)
          }
        })
        watcher.on('error', () => {
          this.state.warning = '部分目录无法实时监听，将定期刷新索引。'
        })
        this.watchers.push(watcher)
      } catch {
        this.state.warning = '部分目录无法实时监听，将定期刷新索引。'
      }
    }
    this.nativeTimer = setInterval(() => void this.pollNative(), 2000)
    this.flushTimer = setInterval(() => void this.flushChanges(), 500)
    this.refreshTimer = setInterval(() => void this.reconcile(), 15 * 60 * 1000)
    void this.reconcile()
  }

  /**
   * 只读取已启用磁盘的新日志，失败时立即退回完整协调以修复缺口。
   * @returns {Promise<void>} 日志刷新完成后的 Promise。
   */
  async pollNative() {
    if (this.busy || this.stopped || !this.native.active.size) return
    this.busy = true
    let failed = false
    try {
      for (const volume of [...this.native.active]) {
        try {
          await this.native.sync(volume)
        } catch (error) {
          this.native.active.delete(volume)
          this.native.failures.set(volume, error.message)
          failed = true
        }
      }
      this.state.count = this.count()
      this.state.nativeVolumes = [...this.native.active]
    } finally {
      this.busy = false
    }
    if (failed) await this.reconcile()
  }

  /**
   * 在完整索引中分别查询分类，不从截断的“全部”结果中推导分类。
   * @param {string} query 用户输入的字面文件名或路径关键词。
   * @param {string} filter 当前类别。
   * @param {number} offset 当前类别的分页偏移。
   * @param {number} expectedVersion 上一页的索引版本。
   * @returns {object} 各分类结果和索引版本。
   * @throws {Error} 搜索语法无效时抛错。
   */
  search(query, filter = 'all', offset = 0, expectedVersion) {
    const buckets = {},
      text = query.trim().toLowerCase()
    if (!text)
      return {
        items: [],
        limited: false,
        total: 0,
        offset: 0,
        buckets,
        engine: 'builtin',
        version: this.state.version
      }
    const reset = expectedVersion !== undefined && expectedVersion !== this.state.version
    if (reset) offset = 0
    if (
      !this.queryCache ||
      this.queryCache.query !== text ||
      this.queryCache.version !== this.state.version
    ) {
      const { clauses, values, fts } = compileQuery(query)
      const base = fts.length ? 'entries e JOIN names ON names.rowid=e.id' : 'entries e'
      if (fts.length) {
        clauses.push('names MATCH ?')
        values.push(fts.join(' AND '))
      }
      // Compute the sorted match set once; every category and subsequent page uses this snapshot.
      this.db.exec('DROP INDEX IF EXISTS search_page_kind; DELETE FROM search_page')
      this.db
        .prepare(
          `INSERT INTO search_page(id,kind) SELECT e.id,e.kind FROM ${base} WHERE ${clauses.length ? clauses.join(' AND ') : '1'}
        ORDER BY (e.search=?) DESC,(e.search LIKE ? ESCAPE '\\') DESC,e.search,e.key`
        )
        .run(...values, text, like(text, false) + '%')
      this.db.exec('CREATE INDEX search_page_kind ON search_page(kind,seq)')
      const counts = { all: 0, app: 0, file: 0, folder: 0 }
      for (const row of this.db
        .prepare('SELECT kind,COUNT(*) n FROM search_page GROUP BY kind')
        .all()) {
        counts[row.kind] = Number(row.n)
        counts.all += Number(row.n)
      }
      this.queryCache = { query: text, version: this.state.version, counts }
    }
    for (const kind of offset === 0 ? ['all', 'app', 'file', 'folder'] : [filter]) {
      const where = kind === 'all' ? '' : 'WHERE p.kind=?'
      const rows = this.db
        .prepare(
          `SELECT e.path,e.name,e.kind FROM search_page p JOIN entries e ON e.id=p.id ${where} ORDER BY p.seq LIMIT 100 OFFSET ?`
        )
        .all(...(kind === 'all' ? [] : [kind]), offset)
      buckets[kind] = {
        items: rows.map((row) => ({
          name: row.name,
          path: row.path,
          directory: row.kind === 'folder'
        })),
        limited: offset + rows.length < this.queryCache.counts[kind],
        total: this.queryCache.counts[kind],
        offset,
        version: this.state.version
      }
    }
    return { ...buckets[filter], buckets, reset, engine: 'builtin', version: this.state.version }
  }

  /**
   * 释放目录监听、定时器及数据库。
   * @returns {void} 无返回值。
   */
  close() {
    this.stopped = true
    clearInterval(this.nativeTimer)
    clearInterval(this.flushTimer)
    clearInterval(this.refreshTimer)
    for (const watcher of this.watchers) watcher.close()
    this.db.close()
  }
}

module.exports = { LocalIndex, keyOf }

if (parentPort) {
  try {
    const index = new LocalIndex(workerData.filename, workerData.config)
    parentPort.on('message', ({ id, action, query, filter, offset, version }) => {
      try {
        if (action === 'search')
          parentPort.postMessage({ id, result: index.search(query, filter, offset, version) })
        else if (action === 'status') parentPort.postMessage({ id, result: index.state })
        else if (action === 'refresh') {
          void index.reconcile(true)
          parentPort.postMessage({ id, result: index.state })
        }
      } catch (error) {
        parentPort.postMessage({ id, error: error.message })
      }
    })
    index.start()
    parentPort.postMessage({ ready: true })
  } catch (error) {
    parentPort.postMessage({ fatal: error.message })
  }
}
