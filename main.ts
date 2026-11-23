// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

// ---- shared line helpers (SPEC.md sections 3 and 5) ----

function leadWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
function trimEndWS(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimBothWS(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function normLine(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? trimEndWS(s) : trimBothWS(s);
}
function lineEq(a: string, b: string, tier: number): boolean {
  return normLine(a, tier) === normLine(b, tier);
}

interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}
function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const crlf = nl > 0 && text[nl - 1] === '\r';
  const br = crlf ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}
function joinFile(p: FileParts): string {
  if (p.lines.length === 0) return '';
  return p.lines.join(p.br) + (p.final ? p.br : '');
}

interface Occ {
  tier: number;
  positions: number[];
}
function findOccurrences(fileLines: string[], oldLines: string[], strict: boolean, from = 0, endAtLast = false): Occ | null {
  if (oldLines.length === 0) return null;
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + oldLines.length <= fileLines.length; i++) {
      if (endAtLast && i + oldLines.length !== fileLines.length) continue;
      let ok = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (!lineEq(fileLines[i + j]!, oldLines[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

// Single-line anchor search (V4A section 8): first line at/after `from` equal to
// the anchor at the first tier where one is.
function findAnchor(fileLines: string[], anchor: string, strict: boolean, from: number): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < fileLines.length; i++) {
      if (lineEq(fileLines[i]!, anchor, tier)) return { tier, pos: i };
    }
  }
  return null;
}

// ctx[k] >= 0 means newLines[k] is a context line equal to oldLines[ctx[k]].
function buildReplacement(fileLines: string[], pos: number, oldLines: string[], newLines: string[], ctx: number[], tier: number): string[] {
  const out: string[] = [];
  let p = '';
  let f = '';
  if (tier === 2 && oldLines.length > 0) {
    p = leadWS(oldLines[0]!);
    f = leadWS(fileLines[pos]!);
  }
  for (let k = 0; k < newLines.length; k++) {
    const t = newLines[k]!;
    if (ctx[k]! >= 0) out.push(fileLines[pos + ctx[k]!]!);
    else if (tier === 2 && t !== '' && !/^[ \t]*$/.test(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
    else out.push(t);
  }
  return [...fileLines.slice(0, pos), ...out, ...fileLines.slice(pos + oldLines.length)];
}

// Body entries of a unified hunk / V4A chunk: ' ' context, '-' old, '+' new,
// '\' no-newline marker.
interface BodyEntry {
  kind: string;
  text: string;
}
function splitBody(entries: BodyEntry[]): { oldLines: string[]; newLines: string[]; ctx: number[] } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const ctx: number[] = [];
  for (const e of entries) {
    if (e.kind === ' ') {
      ctx.push(oldLines.length);
      oldLines.push(e.text);
      newLines.push(e.text);
    } else if (e.kind === '-') oldLines.push(e.text);
    else if (e.kind === '+') {
      ctx.push(-1);
      newLines.push(e.text);
    }
  }
  return { oldLines, newLines, ctx };
}
// True when a '\' line immediately follows the hunk/chunk's last context or '+' line.
function backslashAfterLast(entries: BodyEntry[]): boolean {
  let last = -1;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.kind === ' ' || entries[i]!.kind === '+') last = i;
  }
  if (last < 0) return false;
  return last + 1 < entries.length && entries[last + 1]!.kind === '\\';
}
// True when a '\' line immediately follows the section's very last '+' line
// (creation final-break rule, section 6.4).
function backslashAfterLastPlus(hunks: BodyEntry[][]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const entries = hunks[h]!;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]!.kind === '+') return i + 1 < entries.length && entries[i + 1]!.kind === '\\';
    }
  }
  return false;
}

// ---- unified diffs (SPEC.md section 6) ----

interface Hunk {
  a: number;
  entries: BodyEntry[];
}
interface Section {
  diffOld: string | undefined;
  diffNew: string | undefined;
  pairOld: string | undefined;
  pairNew: string | undefined;
  renFrom: string | undefined;
  renTo: string | undefined;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}
function stripPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}
function parseHunkHeader(line: string, lineNo: number): number {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return Number(m[1]);
}
function parseHunkBody(lines: string[], i: number): { entries: BodyEntry[]; next: number } {
  const entries: BodyEntry[] = [];
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    // The body ends at a '--- ' line followed by a '+++ ' line (section 6.2):
    // such a line starts with '-' but is a new section header, not a '-' line.
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) break;
    if (line === '') {
      entries.push({ kind: ' ', text: '' });
      i += 1;
      continue;
    }
    const c = line[0]!;
    if (c === ' ' || c === '-' || c === '+' || c === '\\') {
      entries.push({ kind: c, text: line.slice(1) });
      i += 1;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it (section 6.2).
  while (entries.length > 0 && entries[entries.length - 1]!.kind === ' ' && entries[entries.length - 1]!.text === '') entries.pop();
  return { entries, next: i };
}
function parseUnifiedSection(lines: string[], i: number, sec: Section, isSectionStart: (idx: number) => boolean, isDiffGit: (l: string) => boolean): number {
  const n = lines.length;
  let inHeader = true;
  let pairSeen = false;
  while (i < n) {
    const line = lines[i]!;
    if (inHeader) {
      if (isDiffGit(line)) break;
      if (line.startsWith('--- ')) {
        if (i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
          if (pairSeen) break; // a new section starts
          sec.pairOld = stripPrefix(headerPath(line));
          sec.pairNew = stripPrefix(headerPath(lines[i + 1]!));
          pairSeen = true;
          i += 2;
          continue;
        }
        // '--- ' not followed by '+++ ' inside a section's header (section 6.1).
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('+++ ')) {
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        const a = parseHunkHeader(line, i + 1);
        inHeader = false;
        i += 1;
        const res = parseHunkBody(lines, i);
        sec.hunks.push({ a, entries: res.entries });
        i = res.next;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (sec.renFrom === undefined) sec.renFrom = stripPrefix(line.slice(12).trim());
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (sec.renTo === undefined) sec.renTo = stripPrefix(line.slice(10).trim());
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.isNew = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.isDel = true;
        i += 1;
        continue;
      }
      i += 1; // index / modes / any other header line: ignored
      continue;
    }
    // Between hunks.
    if (isDiffGit(line)) break;
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) break;
    if (line.startsWith('@@')) {
      const a = parseHunkHeader(line, i + 1);
      i += 1;
      const res = parseHunkBody(lines, i);
      sec.hunks.push({ a, entries: res.entries });
      i = res.next;
      continue;
    }
    i += 1; // prose and any other line outside a body: ignored
  }
  return i;
}
function unifiedEdits(lines: string[], strict: boolean, moves: { old: string; new: string }[]): Edit[] {
  const sections: Section[] = [];
  const n = lines.length;
  const isDiffGit = (l: string): boolean => l.startsWith('diff --git ');
  const isSectionStart = (idx: number): boolean => {
    if (idx >= n) return false;
    if (isDiffGit(lines[idx]!)) return true;
    return lines[idx]!.startsWith('--- ') && idx + 1 < n && lines[idx + 1]!.startsWith('+++ ');
  };
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (isDiffGit(line)) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = { diffOld: m[1], diffNew: m[2], pairOld: undefined, pairNew: undefined, renFrom: undefined, renTo: undefined, isNew: false, isDel: false, hunks: [] };
      i += 1;
      i = parseUnifiedSection(lines, i, sec, isSectionStart, isDiffGit);
      sections.push(sec);
    } else if (line.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
      const sec: Section = { diffOld: undefined, diffNew: undefined, pairOld: undefined, pairNew: undefined, renFrom: undefined, renTo: undefined, isNew: false, isDel: false, hunks: [] };
      i = parseUnifiedSection(lines, i, sec, isSectionStart, isDiffGit);
      sections.push(sec);
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return sections.map((sec) => unifiedEdit(sec, strict, moves));
}
function unifiedEdit(sec: Section, strict: boolean, moves: { old: string; new: string }[]): Edit {
  const oldPath = sec.pairOld ?? sec.renFrom ?? sec.diffOld;
  const newPath = sec.pairNew ?? sec.renTo ?? sec.diffNew;
  if (oldPath === undefined || newPath === undefined) throw new Exit2('error: parse 1');
  const isCreate = oldPath === '/dev/null' || sec.isNew;
  const isDelete = !isCreate && (newPath === '/dev/null' || sec.isDel);
  const isMove = !isCreate && !isDelete && oldPath !== newPath;
  return (tree) => {
    if (isCreate) {
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const e of h.entries) if (e.kind === '+') plus.push(e.text);
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (backslashAfterLastPlus(sec.hunks.map((h) => h.entries)) ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (isMove && !safe(newPath)) throw new Fail('unsafe', newPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const parts = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const { oldLines, newLines, ctx } = splitBody(h.entries);
      if (oldLines.length === 0) {
        if (newLines.length === 0) continue;
        const at = Math.min(Math.max(h.a + d, 0), parts.lines.length);
        const atEnd = at === parts.lines.length;
        parts.lines.splice(at, 0, ...newLines);
        if (atEnd) parts.final = !backslashAfterLast(h.entries);
        d += newLines.length;
        continue;
      }
      const occ = findOccurrences(parts.lines, oldLines, strict);
      if (occ === null) throw new Fail('no-match', oldPath);
      const target = h.a - 1 + d;
      let best = occ.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of occ.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const touchesEnd = best + oldLines.length === parts.lines.length;
      parts.lines = buildReplacement(parts.lines, best, oldLines, newLines, ctx, occ.tier);
      if (touchesEnd) parts.final = !backslashAfterLast(h.entries);
      d += newLines.length - oldLines.length;
    }
    const text = joinFile(parts);
    if (isMove) {
      tree.now.set(newPath, text);
      tree.now.set(oldPath, null);
      moves.push({ old: oldPath, new: newPath });
    } else {
      tree.now.set(oldPath, text);
    }
  };
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const parts = splitFile(before);
    const occ = findOccurrences(parts.lines, oldLines, strict);
    if (occ === null) throw new Fail('no-match', path);
    if (occ.positions.length > 1) throw new Fail('ambiguous', path);
    const ctx = newLines.map(() => -1);
    parts.lines = buildReplacement(parts.lines, occ.positions[0]!, oldLines, newLines, ctx, occ.tier);
    tree.now.set(path, joinFile(parts));
  };
}
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | undefined = undefined;
  let prevEnd = -1;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | undefined = undefined;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === undefined) {
      if (prevPath === undefined) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface V4aChunk {
  anchor: string | null;
  entries: BodyEntry[];
  eof: boolean;
}
function v4aUpdateEdit(path: string, moveTo: string | undefined, chunks: V4aChunk[], strict: boolean, moves: { old: string; new: string }[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const parts = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findAnchor(parts.lines, ch.anchor, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.pos + 1;
      }
      const { oldLines, newLines, ctx } = splitBody(ch.entries);
      if (oldLines.length === 0) {
        if (newLines.length === 0) continue;
        const at = ch.eof ? parts.lines.length : Math.min(cursor, parts.lines.length);
        parts.lines.splice(at, 0, ...newLines);
        cursor = at + newLines.length;
        continue;
      }
      const occ = findOccurrences(parts.lines, oldLines, strict, cursor, ch.eof);
      if (occ === null) throw new Fail('no-match', path);
      const pos = occ.positions[0]!;
      parts.lines = buildReplacement(parts.lines, pos, oldLines, newLines, ctx, occ.tier);
      cursor = pos + newLines.length;
    }
    const text = joinFile(parts);
    if (moveTo !== undefined) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}
function v4aEdits(lines: string[], strict: boolean, moves: { old: string; new: string }[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secStart = (l: string): string | null => {
    const t = l.trim();
    if (t.startsWith('*** Add File: ') || t === '*** Add File:') return 'add';
    if (t.startsWith('*** Delete File: ') || t === '*** Delete File:') return 'delete';
    if (t.startsWith('*** Update File: ') || t === '*** Update File:') return 'update';
    return null;
  };
  const secPath = (l: string): string => {
    const t = l.trim();
    const idx = t.indexOf(': ');
    return idx >= 0 ? t.slice(idx + 2).trim() : '';
  };
  const edits: Edit[] = [];
  const end = last;
  let i = first + 1;
  while (i < end) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = secStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = secPath(line);
    if (kind === 'add') {
      const fileLines: string[] = [];
      i += 1;
      while (i < end) {
        const l = lines[i]!;
        if (secStart(l) !== null) break;
        if (l.startsWith('+')) {
          fileLines.push(l.slice(1));
          i += 1;
          continue;
        }
        if (l === '') {
          fileLines.push('');
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      // Blank lines at the end of a section are not part of it (section 8, A4).
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      const fl = fileLines;
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fl.length === 0 ? '' : fl.join('\n') + '\n');
      });
      continue;
    }
    if (kind === 'delete') {
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      i += 1;
      continue;
    }
    // Update File section.
    const updateLine = i;
    i += 1;
    while (i < end && blank(lines[i]!)) i += 1; // blanks before Move to are skipped (A6)
    let moveTo: string | undefined = undefined;
    if (i < end) {
      const t = lines[i]!.trim();
      if (t.startsWith('*** Move to: ') || t === '*** Move to:') {
        moveTo = t.startsWith('*** Move to: ') ? t.slice(13).trim() : '';
        i += 1;
      }
    }
    const chunks: V4aChunk[] = [];
    let cur: V4aChunk | null = null;
    let firstChunk = true;
    const endChunk = (): void => {
      if (cur !== null) {
        chunks.push(cur);
        cur = null;
      }
    };
    while (i < end) {
      const l = lines[i]!;
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
        if (cur === null) {
          if (!firstChunk) {
            if (l === '') {
              i += 1;
              continue; // blank line between chunks: ignored
            }
            throw new Exit2(`error: parse ${i + 1}`);
          }
          cur = { anchor: null, entries: [], eof: false };
          firstChunk = false;
        }
        cur.entries.push({ kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1) });
        i += 1;
        continue;
      }
      if (l.trimEnd() === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
        cur.eof = true;
        endChunk();
        i += 1;
        firstChunk = false;
        continue;
      }
      if (l.startsWith('@@')) {
        endChunk();
        const anchorText = l.slice(2).trim();
        cur = { anchor: anchorText === '' ? null : anchorText, entries: [], eof: false };
        i += 1;
        firstChunk = false;
        continue;
      }
      if (secStart(l) !== null) break;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    endChunk();
    if (chunks.length > 0) {
      const lastChunk = chunks[chunks.length - 1]!;
      while (lastChunk.entries.length > 0) {
        const e = lastChunk.entries[lastChunk.entries.length - 1]!;
        if (e.kind === ' ' && e.text === '') lastChunk.entries.pop();
        else break;
      }
    }
    if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${updateLine + 1}`);
    edits.push(v4aUpdateEdit(path, moveTo, chunks, strict, moves));
  }
  return edits;
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
  const moves: { old: string; new: string }[] = [];
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict, moves) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A successful move is one R line, sorted by its new path (section 2.4, A9):
  // the old path existed before the patch and does not after it, the new path
  // did not exist before it and does after it.
  const rByNew = new Map<string, string>();
  for (const m of moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null) rByNew.set(m.new, m.old);
  }
  const rOlds = new Set<string>([...rByNew.values()]);
  const items: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    if (rOlds.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rByNew.has(p)) items.push({ key: p, text: `R ${rByNew.get(p)} -> ${p}` });
    else items.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  items.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = items.map((r) => r.text);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
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
