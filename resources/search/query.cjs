/**
 * Escape literal SQL LIKE characters while optionally enabling familiar * and ? wildcards.
 * @param {string} value User search term.
 * @param {boolean} wildcards Whether * and ? are operators.
 * @returns {string} Bound SQL LIKE pattern fragment.
 */
function like(value, wildcards = true) {
  return [...value]
    .map((c) =>
      c === '%' || c === '_' || c === '\\'
        ? '\\' + c
        : wildcards && c === '*'
          ? '%'
          : wildcards && c === '?'
            ? '_'
            : c
    )
    .join('')
}

/**
 * Compile filename/path terms, quoted phrases, exclusions and extension filters into bound SQL.
 * @param {string} query User input, already limited by the IPC boundary.
 * @returns {object} SQL clauses, bound values and optional trigram accelerator terms.
 * @throws {Error} For incomplete quotes or malformed extension conditions.
 */
function compileQuery(query) {
  const tokens = [],
    clauses = [],
    values = [],
    fts = []
  let token = '',
    quoted = false
  for (const char of query.trim()) {
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (/\s/.test(char) && !quoted) {
      if (token) tokens.push(token)
      token = ''
    } else token += char
  }
  if (quoted) throw new Error('请补全搜索短语的双引号')
  if (token) tokens.push(token)
  for (let term of tokens) {
    const negative = term.startsWith('!')
    if (negative) term = term.slice(1)
    if (!term) continue
    if (/^ext:/i.test(term)) {
      const extensions = term
        .slice(4)
        .toLowerCase()
        .split(/[;,]/)
        .map((value) => value.replace(/^\./, ''))
      if (!extensions.length || extensions.some((value) => !value || /[\\/:*?\s]/.test(value)))
        throw new Error('扩展名格式示例：ext:txt;pdf')
      clauses.push(
        `${negative ? 'NOT ' : ''}(e.kind!='folder' AND (${extensions.map(() => "e.search LIKE ? ESCAPE '\\'").join(' OR ')}))`
      )
      values.push(...extensions.map((value) => '%.' + like(value, false)))
      continue
    }
    const pathTerm = /^path:/i.test(term) || /[\\/]/.test(term)
    if (/^path:/i.test(term)) term = term.slice(5)
    term = term.toLowerCase()
    if (pathTerm) term = term.replace(/\\/g, '/')
    if (!term) continue
    clauses.push(`e.${pathTerm ? 'key' : 'search'} ${negative ? 'NOT ' : ''}LIKE ? ESCAPE '\\'`)
    values.push(/[*?]/.test(term) ? like(term) : '%' + like(term) + '%')
    if (!negative && !pathTerm) {
      // Only literal stretches are used for FTS; wildcard/short Unicode terms keep exact LIKE semantics.
      const longest = term.split(/[*?]/).sort((a, b) => [...b].length - [...a].length)[0]
      if ([...longest].length >= 3) fts.push('"' + longest.replace(/"/g, '""') + '"')
    }
  }
  return { clauses, values, fts }
}
module.exports = { compileQuery, like }
