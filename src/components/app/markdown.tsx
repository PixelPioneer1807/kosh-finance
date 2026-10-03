import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * A small, safe Markdown renderer for model output. It builds React elements directly — no
 * HTML string is ever injected — so text can't smuggle markup or script. Supported: headings,
 * paragraphs, bold/italic/inline code, fenced code, bullet & numbered lists, tables, block
 * quotes, rules and links (http(s) or in-app paths only).
 */

type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "code"; text: string }
  | { t: "ul" | "ol"; items: string[]; start: number }
  | { t: "table"; head: string[]; rows: string[][]; align: ("left" | "right" | "center" | null)[] }
  | { t: "quote"; text: string }
  | { t: "hr" };

const LIST_RE = /^\s*([-*+•]|\d{1,3}[.)])\s+(.*)$/;
const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ t: "p", text: para.join(" ") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      out.push({ t: "code", text: code.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      out.push({ t: "h", level: h[1].length, text: h[2].replace(/\s#+\s*$/, "") });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push({ t: "hr" });
      continue;
    }
    if (line.trim().startsWith("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush();
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
      const rows: string[][] = [];
      i += 1;
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith("|")) rows.push(splitRow(lines[++i]));
      out.push({ t: "table", head, rows, align });
      continue;
    }
    const li = line.match(LIST_RE);
    if (li) {
      flush();
      const ordered = /\d/.test(li[1]);
      const items = [li[2]];
      const start = ordered ? parseInt(li[1], 10) || 1 : 1;
      while (i + 1 < lines.length) {
        const next = lines[i + 1].match(LIST_RE);
        if (next && /\d/.test(next[1]) === ordered) {
          items.push(next[2]);
          i++;
        } else if (lines[i + 1].trim() && /^\s{2,}\S/.test(lines[i + 1]) && !next) {
          items[items.length - 1] += " " + lines[++i].trim(); // continuation line
        } else break;
      }
      out.push({ t: ordered ? "ol" : "ul", items, start });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flush();
      const q = [line.replace(/^\s*>\s?/, "")];
      while (i + 1 < lines.length && /^\s*>\s?/.test(lines[i + 1])) q.push(lines[++i].replace(/^\s*>\s?/, ""));
      out.push({ t: "quote", text: q.join(" ") });
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return out;
}

/** Only http(s) URLs and same-site paths are clickable. */
export function safeHref(url: string): { href: string; internal: boolean } | null {
  const u = url.trim();
  if (/^\/(?!\/)[^\s]*$/.test(u)) return { href: u, internal: true };
  try {
    const parsed = new URL(u);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return { href: parsed.toString(), internal: false };
  } catch {
    /* not a URL */
  }
  return null;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)|(\[[^\]\n]+\]\([^)\s]+\))/;

export function renderInline(text: string, keyPrefix = "i"): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let rest = text;
  let k = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const tok = m[0];
    const key = `${keyPrefix}-${k++}`;
    if (m[1]) out.push(<code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key} className="font-semibold">{renderInline(tok.slice(2, -2), key)}</strong>);
    else if (m[3]) out.push(<em key={key}>{renderInline(tok.slice(1, -1), key)}</em>);
    else if (m[4]) {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      const link = safeHref(lm[2]);
      const label = renderInline(lm[1], key);
      if (!link) out.push(<React.Fragment key={key}>{label}</React.Fragment>);
      else if (link.internal)
        out.push(
          <Link key={key} href={link.href} className="font-medium underline underline-offset-2 hover:text-accent">
            {label}
          </Link>,
        );
      else
        out.push(
          <a key={key} href={link.href} target="_blank" rel="noopener noreferrer nofollow" className="font-medium underline underline-offset-2 hover:text-accent">
            {label}
          </a>,
        );
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

const NUMERIC_CELL = /^[\s(+\-−]*([A-Z]{3}\s?|[^\d\s\w]{1,3}\s?)?[\d,. ]+%?\)?\s*([A-Z]{3})?$/;

export function Markdown({ content, className }: { content: string; className?: string }) {
  const blocks = React.useMemo(() => parseBlocks(content), [content]);
  return (
    <div className={cn("grid gap-2.5 text-[14.5px] leading-relaxed break-words", className)}>
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.t) {
          case "h":
            return b.level <= 2 ? (
              <h3 key={key} className="mt-1 text-[15.5px] font-semibold tracking-tight">
                {renderInline(b.text, key)}
              </h3>
            ) : (
              <h4 key={key} className="mt-1 text-[14.5px] font-semibold">
                {renderInline(b.text, key)}
              </h4>
            );
          case "p":
            return <p key={key}>{renderInline(b.text, key)}</p>;
          case "code":
            return (
              <pre key={key} className="overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-[12.5px]">
                <code>{b.text}</code>
              </pre>
            );
          case "ul":
            return (
              <ul key={key} className="grid list-disc gap-1 pl-5 marker:text-muted-foreground">
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, `${key}-${j}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={key} start={b.start} className="grid list-decimal gap-1 pl-5 marker:text-muted-foreground">
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, `${key}-${j}`)}</li>
                ))}
              </ol>
            );
          case "quote":
            return (
              <blockquote key={key} className="border-l-2 border-border-strong pl-3 text-muted-foreground">
                {renderInline(b.text, key)}
              </blockquote>
            );
          case "hr":
            return <hr key={key} className="my-1 border-border" />;
          case "table": {
            const alignOf = (j: number, cell: string) => b.align[j] ?? (NUMERIC_CELL.test(cell) && /\d/.test(cell) ? "right" : "left");
            return (
              <div key={key} className="-mx-1 overflow-x-auto">
                <table className="w-full min-w-max border-collapse text-[13.5px]">
                  <thead>
                    <tr className="border-b border-border-strong">
                      {b.head.map((h, j) => (
                        <th key={j} scope="col" className={cn("px-2 py-1.5 font-medium text-muted-foreground", alignOf(j, b.rows[0]?.[j] ?? "") === "right" ? "text-right" : "text-left")}>
                          {renderInline(h, `${key}-h${j}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={ri} className="border-b border-border last:border-0">
                        {b.head.map((_, j) => {
                          const cell = r[j] ?? "";
                          const right = alignOf(j, cell) === "right";
                          return (
                            <td key={j} className={cn("px-2 py-1.5 align-top", right && "num text-right whitespace-nowrap")}>
                              {renderInline(cell, `${key}-${ri}-${j}`)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
        }
      })}
    </div>
  );
}
