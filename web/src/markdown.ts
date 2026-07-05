export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInline(raw: string): string {
  let out = "";
  let rest = raw;
  const pattern =
    /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*(?=\S)([\s\S]*?\S)\*\*|(?<!\w)__(?=\S)([\s\S]*?\S)__(?!\w)|\*(?=[^\s*])([^*\n]*[^\s*])\*|(?<!\w)_(?=[^\s_])([^_\n]*[^\s_])_(?!\w)|(https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?])/;
  for (;;) {
    const match = pattern.exec(rest);
    if (!match) {
      out += escapeHtml(rest);
      return out;
    }
    out += escapeHtml(rest.slice(0, match.index));
    if (match[1] !== undefined) {
      out += `<code>${escapeHtml(match[2] ?? "")}</code>`;
    } else if (match[3] !== undefined && match[4] !== undefined) {
      out += `<a href="${escapeHtml(match[4])}" target="_blank" rel="noopener">${escapeHtml(match[3])}</a>`;
    } else if (match[5] !== undefined || match[6] !== undefined) {
      out += `<strong>${renderInline(match[5] ?? match[6] ?? "")}</strong>`;
    } else if (match[7] !== undefined || match[8] !== undefined) {
      out += `<em>${renderInline(match[7] ?? match[8] ?? "")}</em>`;
    } else if (match[9] !== undefined) {
      out += `<a href="${escapeHtml(match[9])}" target="_blank" rel="noopener">${escapeHtml(match[9])}</a>`;
    }
    rest = rest.slice(match.index + match[0].length);
  }
}

interface ListItem {
  ordered: boolean;
  indent: number;
  text: string;
}

function parseListLine(line: string): ListItem | undefined {
  const match = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
  if (!match) return undefined;
  return {
    ordered: /\d/.test(match[2] ?? ""),
    indent: (match[1] ?? "").length,
    text: match[3] ?? "",
  };
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

/**
 * Renders the markdown subset agents actually emit — fenced code, headings,
 * lists, blockquotes, pipe tables, hr, and inline code/bold/italic/links —
 * to HTML with all source text escaped.
 */
export function renderMarkdown(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    out.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`);
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    const fence = /^\s*(`{3,}|~{3,})\s*(\S*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1] ?? "```";
      const lang = fence[2] ?? "";
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith(marker.slice(0, 3))) {
        code.push(lines[i] ?? "");
        i++;
      }
      out.push(
        `<div class="codeblock"${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}><pre><code>${escapeHtml(code.join("\n"))}</code></pre></div>`,
      );
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushParagraph();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = (heading[1] ?? "#").length;
      out.push(`<h${level}>${renderInline(heading[2] ?? "")}</h${level}>`);
      continue;
    }

    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flushParagraph();
      out.push("<hr>");
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushParagraph();
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? "")) {
        quoted.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i++;
      }
      i--;
      out.push(`<blockquote>${renderMarkdown(quoted.join("\n"))}</blockquote>`);
      continue;
    }

    const listStart = parseListLine(line);
    if (listStart) {
      flushParagraph();
      const items: ListItem[] = [];
      while (i < lines.length) {
        const item = parseListLine(lines[i] ?? "");
        if (!item) break;
        items.push(item);
        i++;
      }
      i--;
      out.push(renderList(items, 0));
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1] ?? "")) {
      flushParagraph();
      const headers = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|") && !/^\s*$/.test(lines[i] ?? "")) {
        rows.push(splitTableRow(lines[i] ?? ""));
        i++;
      }
      i--;
      const head = `<tr>${headers.map((h) => `<th>${renderInline(h)}</th>`).join("")}</tr>`;
      const body = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
        .join("");
      out.push(`<div class="table-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`);
      continue;
    }

    paragraph.push(line);
  }
  flushParagraph();
  return out.join("");
}

function renderList(items: ListItem[], depth: number): string {
  if (items.length === 0) return "";
  const baseIndent = items[0]?.indent ?? 0;
  const ordered = items[0]?.ordered ?? false;
  const parts: string[] = [];
  let index = 0;
  while (index < items.length) {
    const item = items[index];
    if (!item) break;
    const children: ListItem[] = [];
    index++;
    while (index < items.length && (items[index]?.indent ?? 0) > baseIndent) {
      children.push(items[index]!);
      index++;
    }
    const nested = depth < 4 ? renderList(children, depth + 1) : "";
    parts.push(`<li>${renderInline(item.text)}${nested}</li>`);
  }
  const tag = ordered ? "ol" : "ul";
  return `<${tag}>${parts.join("")}</${tag}>`;
}
