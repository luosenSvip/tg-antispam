import { marked, Parser, Renderer, TextRenderer, Token } from "marked";

function escapeHtml(text: string): string {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/'/g, "&#39;");
}

function normalizeMarkdown(markdown: string): string {
  return String(markdown || "").replace(/\r/g, "").trim();
}

function buildTelegramMarkdownRenderer(): Renderer<string, string> {
  const renderer = new Renderer<string, string>();

  renderer.space = () => "";
  renderer.text = ({ text }) => escapeHtml(text);
  renderer.html = ({ text }) => escapeHtml(text);
  renderer.strong = ({ tokens }) => `<b>${renderer.parser.parseInline(tokens)}</b>`;
  renderer.em = ({ tokens }) => `<i>${renderer.parser.parseInline(tokens)}</i>`;
  renderer.codespan = ({ text }) => `<code>${escapeHtml(text)}</code>`;
  renderer.del = ({ tokens }) => `<s>${renderer.parser.parseInline(tokens)}</s>`;
  renderer.br = () => "\n";
  renderer.hr = () => "\n──────────\n\n";
  renderer.paragraph = ({ tokens }) => `${renderer.parser.parseInline(tokens)}\n\n`;
  renderer.heading = ({ tokens }) => `<b>${renderer.parser.parseInline(tokens)}</b>\n\n`;
  renderer.blockquote = ({ tokens }) => `<blockquote>${renderer.parser.parse(tokens).trim()}</blockquote>\n\n`;
  renderer.link = ({ href, tokens }) => {
    const text = renderer.parser.parseInline(tokens);
    const safeHref = String(href || "").trim();
    if (!safeHref) return text;
    return `<a href="${escapeHtmlAttr(safeHref)}">${text}</a>`;
  };
  renderer.image = ({ href, text }) => {
    const label = escapeHtml(String(text || href || "图片"));
    const safeHref = String(href || "").trim();
    if (!safeHref) return label;
    return `<a href="${escapeHtmlAttr(safeHref)}">${label}</a>`;
  };
  renderer.code = ({ text, lang }) => {
    const safeText = escapeHtml(text);
    const safeLang = String(lang || "").trim().replace(/[^a-zA-Z0-9_+-]/g, "");
    if (safeLang) return `<pre><code class="language-${safeLang}">${safeText}</code></pre>\n\n`;
    return `<pre>${safeText}</pre>\n\n`;
  };
  renderer.list = (token) => {
    const start = typeof token.start === "number" ? token.start : 1;
    const lines = token.items.map((item, index) => {
      const marker = token.ordered ? `${start + index}. ` : "• ";
      const content = renderer.listitem(item).trim().replace(/\n/g, "\n   ");
      return `${marker}${content}`;
    });
    return `${lines.join("\n")}\n\n`;
  };
  renderer.listitem = (item) => renderer.parser.parse(item.tokens).trim();
  renderer.table = (token) => {
    const header = token.header.map((cell) => renderInlineTokens(cell.tokens)).join(" | ");
    const rows = token.rows.map((row) => row.map((cell) => renderInlineTokens(cell.tokens)).join(" | "));
    return [`<b>${header}</b>`, ...rows].join("\n") + "\n\n";
  };
  renderer.tablecell = (token) => renderInlineTokens(token.tokens);
  renderer.tablerow = ({ text }) => text;

  function renderInlineTokens(tokens: Token[] = []): string {
    return Parser.parseInline<string, string>(tokens, { renderer, gfm: true, breaks: true });
  }

  return renderer;
}

export function renderMarkdownToWebHtml(markdown: string): string {
  const source = normalizeMarkdown(markdown);
  if (!source) return "";
  return String(marked.parse(source, { gfm: true, breaks: true }));
}

export function renderMarkdownToTelegramHtml(markdown: string): string {
  const source = normalizeMarkdown(markdown);
  if (!source) return "";
  const rendered = String(marked.parse(source, {
    gfm: true,
    breaks: true,
    renderer: buildTelegramMarkdownRenderer(),
  }));
  return rendered.replace(/\n{3,}/g, "\n\n").trim();
}

export function renderMarkdownToPlainText(markdown: string): string {
  const source = normalizeMarkdown(markdown);
  if (!source) return "";
  return String(marked.parseInline(source, {
    gfm: true,
    breaks: true,
    renderer: new TextRenderer<string>() as any,
  })).trim();
}
