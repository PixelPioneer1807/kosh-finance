import { describe, expect, it } from "vitest";
import { parseBlocks, safeHref } from "@/components/app/markdown";

describe("assistant markdown renderer", () => {
  it("only allows http(s) and same-site links", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>")).toBeNull();
    expect(safeHref("//evil.example/x")).toBeNull();
    expect(safeHref("/transactions?category=1")).toEqual({ href: "/transactions?category=1", internal: true });
    expect(safeHref("https://example.com/a")).toMatchObject({ internal: false });
  });

  it("parses tables, lists and headings into blocks (raw HTML stays text)", () => {
    const blocks = parseBlocks("## Summary\n\n| Category | Amount |\n|---|---:|\n| Food | $120.00 |\n\n- one\n- two\n\n<img src=x onerror=alert(1)>");
    expect(blocks.map((b) => b.t)).toEqual(["h", "table", "ul", "p"]);
    expect(blocks[1]).toMatchObject({ head: ["Category", "Amount"], rows: [["Food", "$120.00"]], align: [null, "right"] });
    expect(blocks[3]).toMatchObject({ t: "p", text: "<img src=x onerror=alert(1)>" });
  });
});
