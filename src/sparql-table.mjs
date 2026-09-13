/**
 * Parse the `dkg query` CLI's table output back into rows of {var: value}.
 *
 * Pure, so the resolver can be imported without pulling in the node client.
 */
export function parseQueryTable(out) {
  const lines = out.split('\n')
  const sep = lines.findIndex(l => /^[─\s]+$/.test(l) && l.includes('─'))
  if (sep < 1) return []
  const header = lines[sep - 1]
  // Column starts are wherever a run of dashes begins on the separator line.
  const cols = []
  const re = /─+/g
  let m
  while ((m = re.exec(lines[sep]))) cols.push({ start: m.index, end: m.index + m[0].length })
  const names = cols.map(c => header.slice(c.start, c.end).trim())
  const rows = []
  for (const line of lines.slice(sep + 1)) {
    if (!line.trim() || /row\(s\)/.test(line)) break
    const row = {}
    cols.forEach((c, i) => { row[names[i]] = line.slice(c.start, c.end).trim() })
    rows.push(row)
  }
  return rows
}
