// Conflict-marker parsing and resolution on plain text (used by the editor and Git panel).

export interface ConflictBlock {
  /** 1-based line numbers of the `<<<<<<<`, `=======`, `>>>>>>>` markers (and optional `|||||||`). */
  start: number;
  base: number | null;
  mid: number;
  end: number;
  oursLabel: string;
  theirsLabel: string;
}

export function parseConflicts(text: string): ConflictBlock[] {
  const lines = text.split("\n");
  const out: ConflictBlock[] = [];
  let cur: Partial<ConflictBlock> | null = null;
  for (let i = 0; i < lines.length; i++) {
    // CRLF files: the marker lines end in "\r" too.
    const l = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
    if (l.startsWith("<<<<<<< ") || l === "<<<<<<<") { cur = { start: i + 1, base: null, oursLabel: l.slice(8).trim() }; }
    else if (cur && (l.startsWith("||||||| ") || l === "|||||||") && cur.mid === undefined) cur.base = i + 1;
    else if (cur && l === "=======" && cur.mid === undefined) cur.mid = i + 1;
    else if (cur && (l.startsWith(">>>>>>> ") || l === ">>>>>>>") && cur.mid !== undefined) {
      out.push({ ...(cur as ConflictBlock), end: i + 1, theirsLabel: l.slice(8).trim() });
      cur = null;
    }
  }
  return out;
}

export type Side = "ours" | "theirs" | "both";

/** Lines (0-based slice) to keep for a block, given the full line array. */
export function resolveBlockLines(lines: string[], b: ConflictBlock, side: Side): string[] {
  const ours = lines.slice(b.start, (b.base ?? b.mid) - 1);
  const theirs = lines.slice(b.mid, b.end - 1);
  return side === "ours" ? ours : side === "theirs" ? theirs : [...ours, ...theirs];
}

/** Return the text with every block resolved to `side`. */
export function resolveAll(text: string, side: Side): string {
  const lines = text.split("\n");
  const blocks = parseConflicts(text);
  const out: string[] = [];
  let i = 0;
  for (const b of blocks) {
    out.push(...lines.slice(i, b.start - 1));
    out.push(...resolveBlockLines(lines, b, side));
    i = b.end;
  }
  out.push(...lines.slice(i));
  return out.join("\n");
}

export function hasMarkers(text: string): boolean {
  return parseConflicts(text).length > 0;
}
