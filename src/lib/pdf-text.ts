/**
 * Best-effort text extraction from simple, text-based PDFs (e.g. emailed receipts), in the
 * browser, with no dependencies: inflates FlateDecode content streams (DecompressionStream)
 * and reads the strings shown by Tj/TJ/'/" operators.
 *
 * It can't read scanned PDFs (images) or fonts that need a ToUnicode map (hex/CID strings);
 * in that case it returns "" and the caller falls back to manual entry.
 */

const MAX_STREAMS = 300;

function unescapePdfString(s: string): string {
  return s.replace(/\\(n|r|t|b|f|\(|\)|\\|[0-7]{1,3}|\r?\n)/g, (_m, c: string) => {
    switch (c) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "b":
      case "f":
        return "";
      case "(":
      case ")":
      case "\\":
        return c;
      default:
        return /^[0-7]+$/.test(c) ? String.fromCharCode(parseInt(c, 8)) : "";
    }
  });
}

const TOKEN = /\[((?:\\.|[^\]\\])*)\]\s*TJ|\(((?:\\.|[^\\)])*)\)\s*(?:Tj|'|")|(-?[\d.]+)\s+(-?[\d.]+)\s+T[dD]|T\*|(?:-?[\d.]+\s+){6}Tm|\bET\b/g;

/** Text shown by one content stream. Exported for tests. */
export function textFromContentStream(content: string): string {
  let out = "";
  for (const m of content.matchAll(TOKEN)) {
    if (m[1] !== undefined) {
      // TJ array: strings interleaved with kerning; a large negative kern is a word gap.
      for (const part of m[1].matchAll(/\(((?:\\.|[^\\)])*)\)|(-?[\d.]+)/g)) {
        if (part[1] !== undefined) out += unescapePdfString(part[1]);
        else if (Number(part[2]) < -200) out += " ";
      }
    } else if (m[2] !== undefined) out += unescapePdfString(m[2]);
    else if (m[3] !== undefined) out += Number(m[4]) !== 0 ? "\n" : " ";
    else out += "\n";
  }
  return out;
}

async function inflate(data: Uint8Array): Promise<string | null> {
  if (typeof DecompressionStream === "undefined") return null;
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
    const buf = await new Response(stream).arrayBuffer();
    return new TextDecoder("latin1").decode(buf);
  } catch {
    return null;
  }
}

export async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  const raw = new TextDecoder("latin1").decode(bytes);
  const parts: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(raw)) && n++ < MAX_STREAMS) {
    const start = m.index + m[0].length;
    let end = raw.indexOf("endstream", start);
    if (end < 0) break;
    re.lastIndex = end + 9;
    while (end > start && (raw[end - 1] === "\n" || raw[end - 1] === "\r")) end--;
    const dict = raw.slice(Math.max(0, raw.lastIndexOf("<<", m.index)), m.index);
    if (/\/(Image|XObject|FontFile|Metadata)\b/.test(dict) && !/\/Contents/.test(dict)) continue;
    let content: string | null = null;
    if (/\/FlateDecode/.test(dict)) content = await inflate(bytes.subarray(start, end));
    else if (!/\/Filter/.test(dict)) content = raw.slice(start, end);
    if (content && /\bBT\b/.test(content)) parts.push(textFromContentStream(content));
  }
  const text = parts
    .join("\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  // Garbage guard: CID-encoded fonts come out as control characters.
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  return letters >= 15 && letters / Math.max(1, text.length) > 0.2 ? text.slice(0, 20000) : "";
}
