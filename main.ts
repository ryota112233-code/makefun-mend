// mend: the single-file CLI specified by SPEC.md. Node 22 erasable TypeScript.
// Keep the trial runner hand-over at the end of this file.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; next: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

const parseError = (line: number): never => { throw new Exit2(`error: parse ${line}`); };

function safePaths(...paths: string[]): void {
  for (const p of paths) if (!safe(p)) throw new Fail('unsafe', p);
}

function existing(tree: Tree, p: string): string {
  const text = tree.get(p);
  if (text === null) throw new Fail('missing', p);
  return text;
}

interface FileLines { lines: string[]; br: string; final: boolean }

function readLines(text: string): FileLines {
  const lf = text.indexOf('\n');
  const br = lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(br);
  const final = text !== '' && text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function writeLines(f: FileLines): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

function normalized(line: string, tier: number): string {
  if (tier === 0) return line;
  const right = line.replace(/[ \t]+$/, '');
  return tier === 1 ? right : right.replace(/^[ \t]+/, '');
}

/** Restrict the candidate positions before selecting the first matching tier. */
function occurrences(lines: string[], old: string[], strict: boolean, path: string,
  from = 0, eof = false): { tier: number; positions: number[] } {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
    const pattern = old.map((l) => normalized(l, tier));
    const positions: number[] = [];
    for (let i = from; i + old.length <= lines.length; i++) {
      if (eof && i + old.length !== lines.length) continue;
      if (pattern.every((l, j) => normalized(lines[i + j]!, tier) === l)) positions.push(i);
    }
    if (positions.length) return { tier, positions };
  }
  throw new Fail('no-match', path);
}

interface Replacement {
  old: string[];
  next: { text: string; context?: number }[];
  noFinal: boolean;
  plusNoFinal?: boolean;
}

function replacement(body: string[]): Replacement {
  const old: string[] = [];
  const next: Replacement['next'] = [];
  let lastNew = -1;
  let lastPlus = -1;
  body.forEach((l, i) => {
    if (l.startsWith('\\')) return;
    const kind = l === '' ? ' ' : l[0];
    const text = l === '' ? '' : l.slice(1);
    if (kind === ' ') next.push({ text, context: old.length });
    else if (kind === '+') next.push({ text });
    if (kind === '+') lastPlus = i;
    if (kind === ' ' || kind === '-') old.push(text);
    if (kind === ' ' || kind === '+') lastNew = i;
  });
  return {
    old, next,
    noFinal: lastNew >= 0 && (body[lastNew + 1] ?? '').startsWith('\\'),
    plusNoFinal: lastPlus < 0 ? undefined : (body[lastPlus + 1] ?? '').startsWith('\\'),
  };
}

function replaceLines(lines: string[], r: Replacement, at: number, tier: number): number {
  const f = (lines[at] ?? '').match(/^[ \t]*/)![0];
  const p = (r.old[0] ?? '').match(/^[ \t]*/)![0];
  const next = r.next.map((n) => {
    if (n.context !== undefined) return lines[at + n.context]!;
    if (tier === 2 && !blank(n.text) && n.text.startsWith(p)) return f + n.text.slice(p.length);
    return n.text;
  });
  lines.splice(at, r.old.length, ...next);
  return next.length;
}

function searchEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previousEnd = -1;
  let previousPath: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let path = previousPath;
    for (let j = i - 1; j > previousEnd; j--) {
      const l = lines[j]!.trim();
      if (l !== '' && !l.startsWith('```')) { path = l; break; }
    }
    if (path === undefined) parseError(i + 1);
    let middle = i + 1;
    while (middle < lines.length && lines[middle]!.trimEnd() !== '=======') middle++;
    let end = middle + 1;
    while (end < lines.length && lines[end]!.trimEnd() !== '>>>>>>> REPLACE') end++;
    if (middle >= lines.length || end >= lines.length) parseError(i + 1);
    const old = lines.slice(i + 1, middle);
    const next = lines.slice(middle + 1, end);
    const p = path;
    edits.push((tree) => {
      safePaths(p);
      if (old.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, writeLines({ lines: next, br: '\n', final: true }));
      } else {
        const f = readLines(existing(tree, p));
        const found = occurrences(f.lines, old, strict, p);
        if (found.positions.length > 1) throw new Fail('ambiguous', p);
        replaceLines(f.lines, { old, next: next.map((text) => ({ text })), noFinal: false }, found.positions[0]!, found.tier);
        tree.now.set(p, writeLines(f));
      }
    });
    previousPath = p;
    previousEnd = end;
    i = end;
  }
  return edits;
}

interface UnifiedSection {
  old: string; next: string; renameOld?: string; renameNext?: string;
  pair: boolean; create: boolean; remove: boolean;
  hunks: { a: number; r: Replacement }[];
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let section: UnifiedSection | undefined;
  const newSection = (old: string, next: string): UnifiedSection => {
    const s: UnifiedSection = { old, next, pair: false, create: false, remove: false, hunks: [] };
    sections.push(s);
    section = s;
    return s;
  };
  const pairAt = (i: number): boolean => lines[i]?.startsWith('--- ') === true && lines[i + 1]?.startsWith('+++ ') === true;
  const headerPath = (l: string): string => {
    const p = l.slice(4).split('\t')[0]!.trim();
    return p === '/dev/null' ? p : p.replace(/^[ab]\//, '');
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith('diff --git')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
      if (!m) parseError(i + 1);
      newSection(m[1]!, m[2]!);
    } else if (pairAt(i)) {
      if (!section || section.hunks.length > 0 || section.pair) newSection('', '');
      section!.old = headerPath(l);
      section!.next = headerPath(lines[++i]!);
      section!.pair = true;
    } else if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@.*$/.exec(l);
      if (!m || !section) parseError(i + 1);
      const body: string[] = [];
      while (i + 1 < lines.length) {
        const b = lines[i + 1]!;
        if (b.startsWith('diff --git ') || pairAt(i + 1) || (b !== '' && !/^[ +\-\\]/.test(b))) break;
        body.push(b);
        i++;
      }
      while (body[body.length - 1] === '') body.pop();
      section.hunks.push({ a: Number(m[1]), r: replacement(body) });
    } else if (section && section.hunks.length === 0) {
      if (l.startsWith('--- ')) parseError(i + 2);
      if (l.startsWith('rename from ')) section.renameOld = l.slice(12).trim();
      if (l.startsWith('rename to ')) section.renameNext = l.slice(10).trim();
      if (l.startsWith('new file mode')) section.create = true;
      if (l.startsWith('deleted file mode')) section.remove = true;
    }
  }
  return sections.map((s) => (tree) => {
    const old = s.pair ? s.old : s.renameOld ?? s.old;
    const next = s.pair ? s.next : s.renameNext ?? s.next;
    safePaths(...[old, next].filter((p) => p !== '/dev/null'));
    if (old === '/dev/null' || s.create) {
      // /dev/null denotes absence only on the appropriate side of a header pair.
      if (next === '/dev/null') throw new Fail('unsafe', next);
      if (tree.get(next) !== null) throw new Fail('exists', next);
      const added = s.hunks.flatMap((h) => h.r.next.filter((n) => n.context === undefined).map((n) => n.text));
      // For a creation the final marker refers specifically to the last '+' line.
      const lastPlus = s.hunks.findLast((h) => h.r.plusNoFinal !== undefined);
      tree.now.set(next, writeLines({ lines: added, br: '\n', final: !lastPlus?.r.plusNoFinal }));
      return;
    }
    if (next === '/dev/null' || s.remove) {
      existing(tree, old);
      tree.now.set(old, null);
      return;
    }
    const f = readLines(existing(tree, old));
    if (old !== next && tree.get(next) !== null) throw new Fail('exists', next);
    let d = 0;
    for (const { a, r } of s.hunks) {
      let at: number;
      let tier = 0;
      if (r.old.length === 0) at = Math.max(0, Math.min(a + d, f.lines.length));
      else {
        const found = occurrences(f.lines, r.old, strict, old);
        tier = found.tier;
        // Clamping preserves the nearest occurrence even for enormous A values.
        const target = Math.max(0, Math.min(a - 1 + d, f.lines.length));
        at = found.positions.reduce((best, pos) => Math.abs(pos - target) < Math.abs(best - target) ? pos : best);
      }
      if (at + r.old.length === f.lines.length) f.final = !r.noFinal;
      replaceLines(f.lines, r, at, tier);
      d += r.next.length - r.old.length;
    }
    tree.now.set(next, writeLines(f));
    if (old !== next) {
      tree.now.set(old, null);
      tree.moves.push({ old, next });
    }
  });
}

interface VChunk { anchor: string; r: Replacement; eof: boolean }

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') parseError(first < 0 ? 1 : first + 1);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') parseError(lines.length + 1);
  const sectionHeader = (l: string): RegExpExecArray | null => /^\*\*\* (Add|Delete|Update) File: (.*)$/.exec(l);
  const edits: Edit[] = [];
  for (let i = first + 1; i < last;) {
    if (blank(lines[i]!)) { i++; continue; }
    const header = sectionHeader(lines[i]!);
    if (!header) parseError(i + 1);
    const headerLine = i + 1;
    const kind = header[1]!;
    const p = header[2]!.trim();
    let end = i + 1;
    while (end < last && !sectionHeader(lines[end]!)) end++;
    let bodyEnd = end;
    while (bodyEnd > i + 1 && blank(lines[bodyEnd - 1]!)) bodyEnd--;
    let j = i + 1;
    let move: string | undefined;
    const chunks: VChunk[] = [];
    const added: string[] = [];
    if (kind === 'Add') {
      for (; j < bodyEnd; j++) {
        const l = lines[j]!;
        if (l !== '' && !l.startsWith('+')) parseError(j + 1);
        added.push(l.slice(1));
      }
    } else if (kind === 'Delete') {
      if (j < bodyEnd) parseError(j + 1);
    } else {
      if (j < bodyEnd && lines[j]!.startsWith('*** Move to: ')) move = lines[j++]!.slice(13).trim();
      while (j < bodyEnd) {
        let anchor = '';
        if (lines[j]!.startsWith('@@')) anchor = lines[j++]!.slice(2).trim();
        else if (chunks.length > 0 || (lines[j] !== '' && !/^[ +\-]/.test(lines[j]!))) parseError(j + 1);
        const body: string[] = [];
        while (j < bodyEnd && !lines[j]!.startsWith('@@') && lines[j] !== '*** End of File') {
          const l = lines[j]!;
          if (l !== '' && !/^[ +\-]/.test(l)) parseError(j + 1);
          body.push(l);
          j++;
        }
        const eof = j < bodyEnd && lines[j] === '*** End of File';
        if (eof) j++;
        chunks.push({ anchor, r: replacement(body), eof });
      }
      if (chunks.length === 0 && move === undefined) parseError(headerLine);
    }
    edits.push((tree) => {
      safePaths(p, ...(move === undefined ? [] : [move]));
      if (kind === 'Add') {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, writeLines({ lines: added, br: '\n', final: true }));
      } else if (kind === 'Delete') {
        existing(tree, p);
        tree.now.set(p, null);
      } else {
        const f = readLines(existing(tree, p));
        if (move !== undefined && tree.get(move) !== null) throw new Fail('exists', move);
        let cursor = 0;
        for (const { anchor, r, eof } of chunks) {
          if (anchor !== '') cursor = occurrences(f.lines, [anchor], strict, p, cursor).positions[0]! + 1;
          let at = eof ? f.lines.length : cursor;
          let tier = 0;
          if (r.old.length > 0) {
            const found = occurrences(f.lines, r.old, strict, p, cursor, eof);
            at = found.positions[0]!;
            tier = found.tier;
          }
          cursor = at + replaceLines(f.lines, r, at, tier);
        }
        tree.now.set(move ?? p, writeLines(f));
        if (move !== undefined) {
          tree.now.set(p, null);
          tree.moves.push({ old: p, next: move });
        }
      }
    });
    i = end;
  }
  return edits;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      tree.moves.length = moveCount;
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moves = new Map<string, string>();
  const movedOld = new Set<string>();
  for (const { old, next } of tree.moves) {
    if (!movedOld.has(old) && !moves.has(next) && tree.original(old) !== null && tree.get(old) === null
      && tree.original(next) === null && tree.get(next) !== null) {
      moves.set(next, old);
      movedOld.add(old);
    }
  }
  const rows: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moves.has(p)) rows.push(`R ${moves.get(p)} -> ${p}`);
    else if (!movedOld.has(p)) rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
