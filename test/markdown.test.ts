import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../web/src/markdown.js";

describe("renderMarkdown", () => {
  it("renders paragraphs and escapes HTML", () => {
    expect(renderMarkdown("hello <script>alert(1)</script>")).toBe(
      "<p>hello &lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  it("renders fenced code blocks with language and escaping", () => {
    const html = renderMarkdown('```js\nconst a = "<b>";\n```');
    expect(html).toContain('data-lang="js"');
    expect(html).toContain("const a = &quot;&lt;b&gt;&quot;;");
    expect(html).not.toContain("<b>");
  });

  it("does not format inline markdown inside code fences", () => {
    const html = renderMarkdown("```\n**not bold** `x`\n```");
    expect(html).toContain("**not bold** `x`");
    expect(html).not.toContain("<strong>");
  });

  it("renders inline code, bold, italic, and links", () => {
    expect(renderMarkdown("use `pi --help` now")).toContain("<code>pi --help</code>");
    expect(renderMarkdown("**bold** and *it*")).toBe("<p><strong>bold</strong> and <em>it</em></p>");
    expect(renderMarkdown("[docs](https://example.com/a?b=1)")).toContain(
      '<a href="https://example.com/a?b=1" target="_blank" rel="noopener">docs</a>',
    );
    expect(renderMarkdown("see https://example.com/x")).toContain('href="https://example.com/x"');
  });

  it("does not linkify javascript: URLs", () => {
    expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("<a ");
  });

  it("keeps underscores in identifiers literal", () => {
    expect(renderMarkdown("call foo_bar_baz()")).toBe("<p>call foo_bar_baz()</p>");
  });

  it("renders headings", () => {
    expect(renderMarkdown("## Title")).toBe("<h2>Title</h2>");
  });

  it("renders unordered and ordered lists with nesting", () => {
    const html = renderMarkdown("- one\n- two\n  - two.a\n- three");
    expect(html).toBe("<ul><li>one</li><li>two<ul><li>two.a</li></ul></li><li>three</li></ul>");
    expect(renderMarkdown("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  it("renders blockquotes and hr", () => {
    expect(renderMarkdown("> quoted")).toBe("<blockquote><p>quoted</p></blockquote>");
    expect(renderMarkdown("---")).toBe("<hr>");
  });

  it("renders pipe tables", () => {
    const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>2</td>");
  });

  it("treats a lone pipe line without divider as a paragraph", () => {
    expect(renderMarkdown("a | b")).toBe("<p>a | b</p>");
  });

  it("survives an unterminated code fence", () => {
    expect(renderMarkdown("```\nhalf")).toContain("half");
  });
});
