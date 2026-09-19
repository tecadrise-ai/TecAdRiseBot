/** If the SDK flattened markdown into one line, put structure back. */
export function restoreFlattenedMarkdown(raw: string): string {
  let s = String(raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\\n/g, '\n');
  s = s.replace(/\s+(#{1,6})\s+/g, '\n\n$1 ');
  s = s.replace(/\s+(- |\* )(?=[A-Za-z0-9*`])/g, '\n$1');
  s = rebuildPipeTables(s);
  return s.trim();
}

function isSepCell(cell: string): boolean {
  return /^:?-{2,}:?$/.test(cell.replace(/\s/g, ''));
}

function formatTableFromPipes(chunk: string): string {
  const cells = chunk
    .split('|')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const sepIdx = cells.findIndex(isSepCell);
  if (sepIdx <= 0) return chunk;
  const cols = sepIdx;
  if (cells.length < cols * 2) return chunk;
  const rows: string[][] = [];
  for (let i = 0; i < cells.length; i += cols) {
    const row = cells.slice(i, i + cols);
    if (!row.length) continue;
    while (row.length < cols) row.push('');
    rows.push(row.slice(0, cols));
  }
  if (rows.length < 2) return chunk;
  return '\n\n' + rows.map((r) => '| ' + r.join(' | ') + ' |').join('\n') + '\n\n';
}

function rebuildPipeTables(s: string): string {
  const sep = /\|[\t ]*:?-{2,}:?[\t ]*(?:\|[\t ]*:?-{2,}:?[\t ]*)+\|/;
  const m = sep.exec(s);
  if (!m || m.index == null) return s;

  let start = m.index;
  while (start > 0) {
    const prev = s.lastIndexOf('|', start - 1);
    if (prev < 0) break;
    const between = s.slice(prev + 1, start);
    if (between.includes('\n\n')) break;
    if (between.length > 280) break;
    if (/^\s*[-*]\s/.test(between) || /^\s*#{1,6}\s/.test(between)) break;
    start = prev;
  }

  let end = m.index + m[0].length;
  while (end < s.length) {
    const next = s.indexOf('|', end);
    if (next < 0) break;
    const between = s.slice(end, next);
    if (between.includes('\n\n')) break;
    if (between.length > 280) break;
    if (/^\s*[-*]\s/.test(between) || /^\s*#{1,6}\s/.test(between)) break;
    end = next + 1;
  }

  const chunk = s.slice(start, end);
  const formatted = formatTableFromPipes(chunk);
  if (formatted === chunk) return s;
  return s.slice(0, start) + formatted + s.slice(end);
}
