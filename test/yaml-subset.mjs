// Minimal YAML-subset reader for repo-owned config fixtures (no dependency).
// Supports what these fixtures use: comments, nested maps, lists of scalars,
// lists of flat maps (one `- k: v` head line plus indented `k: v` lines),
// inline scalars, inline []/[a, b] lists, ${VAR}/:-fallback refs kept raw.
// Anything else throws: fixtures must stay in this subset.
export function parseSubset(text) {
  const lines = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/ #.*$/, '').replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    lines.push({ indent: line.match(/^ */)[0].length, text: line.trim() });
  }
  let pos = 0;
  function scalar(value) {
    const v = value.trim();
    if (v === '[]') return [];
    const inl = v.match(/^\[(.*)\]$/);
    if (inl) {
      const inner = inl[1].trim();
      return inner === '' ? [] : inner.split(',').map((s) => scalarValue(s.trim()));
    }
    return scalarValue(v);
  }
  function scalarValue(v) {
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null' || v === '~') return null;
    if (/^-?\d+$/.test(v)) return Number(v);
    return v;
  }
  function parseMap(indent) {
    const node = {};
    while (pos < lines.length && lines[pos].indent === indent && !lines[pos].text.startsWith('- ')) {
      const m = lines[pos].text.match(/^([^:]+):\s*(.*)$/);
      if (!m) throw new Error(`unparseable map line: ${lines[pos].text}`);
      const key = m[1].trim();
      const rest = m[2].trim();
      pos++;
      if (rest !== '') {
        node[key] = scalar(rest);
      } else if (pos < lines.length && lines[pos].indent > indent) {
        if (lines[pos].text.startsWith('- ')) node[key] = parseList(lines[pos].indent);
        else node[key] = parseMap(lines[pos].indent);
      } else {
        node[key] = null;
      }
    }
    return node;
  }
  function parseList(indent) {
    const list = [];
    while (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith('- ')) {
      const head = lines[pos].text.slice(2).trim();
      pos++;
      if (head === '') {
        if (pos < lines.length && lines[pos].indent > indent) {
          list.push(lines[pos].text.startsWith('- ') ? parseList(lines[pos].indent) : parseMap(lines[pos].indent));
        } else list.push(null);
      } else if (head.includes(':')) {
        const m = head.match(/^([^:]+):\s*(.*)$/);
        if (!m) throw new Error(`unparseable list map line: ${head}`);
        const obj = {};
        const k = m[1].trim();
        const r = m[2].trim();
        obj[k] = r === '' ? null : scalar(r);
        while (pos < lines.length && lines[pos].indent > indent && !lines[pos].text.startsWith('- ')) {
          const m2 = lines[pos].text.match(/^([^:]+):\s*(.*)$/);
          if (!m2) throw new Error(`unparseable list map line: ${lines[pos].text}`);
          const r2 = m2[2].trim();
          if (r2 === '' && pos + 1 < lines.length && lines[pos + 1].indent > lines[pos].indent) {
            pos++;
            obj[m2[1].trim()] = lines[pos].text.startsWith('- ') ? parseList(lines[pos].indent) : parseMap(lines[pos].indent);
          } else {
            obj[m2[1].trim()] = r2 === '' ? null : scalar(r2);
            pos++;
          }
        }
        list.push(obj);
      } else {
        list.push(scalar(head));
      }
    }
    return list;
  }
  const root = parseMap(0);
  if (pos !== lines.length) throw new Error(`trailing unparsed lines at ${lines[pos].text}`);
  return root;
}
