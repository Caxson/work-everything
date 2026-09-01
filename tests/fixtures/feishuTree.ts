/**
 * Loads `spikes/evidence/feishu_tree.txt` — the accessibility tree that was
 * actually dumped out of Feishu during the spike — as `AxNode`s.
 *
 * The parser under test then runs against the real thing rather than against
 * a hand-written mock that agrees with it by construction. The dump's format
 * is one indented line per node:
 *
 *     [30] AXGroup val='hi' #7616028639817157825 cls=js-message-item.message-item
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AxNode } from '../../src/perception/macos/axProtocol.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const EVIDENCE_PATH = join(HERE, '..', '..', 'spikes', 'evidence', 'feishu_tree.txt');

interface MutableNode {
  nodeId: number;
  role: string;
  subrole?: string;
  title?: string;
  value?: string;
  description?: string;
  domId?: string;
  domClasses?: string[];
  children: MutableNode[];
}

const HEADER = /^(\s*)\[(\d+)\]\s+(\S+)\s*(.*)$/;
const LABELS: Record<string, keyof MutableNode> = { sub: 'subrole', title: 'title', val: 'value', desc: 'description' };

export function loadFeishuTree(path: string = EVIDENCE_PATH): readonly AxNode[] {
  const roots: MutableNode[] = [];
  const stack: MutableNode[] = [];
  let nextId = 1;

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const header = HEADER.exec(line);
    if (header === null) continue;
    const depth = Number(header[2]);
    const node: MutableNode = { nodeId: nextId++, role: header[3] ?? 'AXUnknown', children: [], ...parseAttributes(header[4] ?? '') };

    stack.length = depth;
    const parent = stack[depth - 1];
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
    stack[depth] = node;
  }
  return roots as readonly AxNode[];
}

function parseAttributes(rest: string): Partial<MutableNode> {
  const out: Partial<MutableNode> = {};
  let cursor = 0;
  while (cursor < rest.length) {
    if (rest[cursor] === ' ') {
      cursor += 1;
      continue;
    }
    const label = Object.keys(LABELS).find((name) => rest.startsWith(`${name}=`, cursor));
    if (label !== undefined) {
      const literal = readLiteral(rest, cursor + label.length + 1);
      Object.assign(out, { [LABELS[label] as string]: literal.value });
      cursor = literal.end;
      continue;
    }
    if (rest.startsWith('cls=', cursor)) {
      const token = readToken(rest, cursor + 4);
      out.domClasses = token.value.split('.').filter((name) => name !== '');
      cursor = token.end;
      continue;
    }
    if (rest[cursor] === '#') {
      const token = readToken(rest, cursor + 1);
      out.domId = token.value;
      cursor = token.end;
      continue;
    }
    cursor = readToken(rest, cursor).end;
  }
  return out;
}

function readToken(text: string, start: number): { value: string; end: number } {
  const space = text.indexOf(' ', start);
  const end = space === -1 ? text.length : space;
  return { value: text.slice(start, end), end };
}

/** Reads one Python string literal, honouring backslash escapes. */
function readLiteral(text: string, start: number): { value: string; end: number } {
  const quote = text[start];
  if (quote !== "'" && quote !== '"') return readToken(text, start);
  let out = '';
  let cursor = start + 1;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === '\\') {
      const decoded = decodeEscape(text, cursor + 1);
      out += decoded.value;
      cursor = decoded.end;
      continue;
    }
    if (char === quote) return { value: out, end: cursor + 1 };
    out += char;
    cursor += 1;
  }
  return { value: out, end: cursor };
}

function decodeEscape(text: string, start: number): { value: string; end: number } {
  const char = text[start];
  if (char === 'u') return { value: String.fromCharCode(parseInt(text.slice(start + 1, start + 5), 16)), end: start + 5 };
  if (char === 'x') return { value: String.fromCharCode(parseInt(text.slice(start + 1, start + 3), 16)), end: start + 3 };
  const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' };
  return { value: simple[char ?? ''] ?? (char ?? ''), end: start + 1 };
}
