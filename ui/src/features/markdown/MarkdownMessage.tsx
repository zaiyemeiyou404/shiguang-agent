import type { ReactNode } from "react";

export function MarkdownMessage({ content }: { content: string }) {
  return <div className="message-markdown">{renderMarkdownBlocks(content)}</div>;
}

function renderMarkdownBlocks(content: string): ReactNode[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let blockIndex = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^```([\w.+-]*)\s*$/);
    if (fence) {
      const language = fence[1] ?? "";
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <div className="markdown-codeblock" key={`code-${blockIndex++}`}>
          {language ? <span className="markdown-code-lang">{language}</span> : null}
          <pre><code>{codeLines.join("\n")}</code></pre>
        </div>,
      );
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      const headingKey = `heading-${blockIndex++}`;
      const inline = renderMarkdownInline(text, headingKey);
      if (level === 1) blocks.push(<h1 key={headingKey}>{inline}</h1>);
      else if (level === 2) blocks.push(<h2 key={headingKey}>{inline}</h2>);
      else if (level === 3) blocks.push(<h3 key={headingKey}>{inline}</h3>);
      else blocks.push(<h4 key={headingKey}>{inline}</h4>);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test((lines[index] ?? "").trim())) {
        quoteLines.push((lines[index] ?? "").trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push(
        <blockquote key={`quote-${blockIndex++}`}>
          {renderMarkdownInline(quoteLines.join("\n"), `quote-${blockIndex}`)}
        </blockquote>,
      );
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      const headers = splitMarkdownTableRow(lines[index] ?? "");
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && isMarkdownTableRow(lines[index] ?? "")) {
        rows.push(splitMarkdownTableRow(lines[index] ?? ""));
        index += 1;
      }
      blocks.push(
        <div className="markdown-table-wrap" key={`table-${blockIndex++}`}>
          <table>
            <thead>
              <tr>{headers.map((cell, cellIndex) => <th key={`h-${cellIndex}`}>{renderMarkdownInline(cell, `th-${blockIndex}-${cellIndex}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`r-${rowIndex}`}>
                  {headers.map((_, cellIndex) => (
                    <td key={`c-${rowIndex}-${cellIndex}`}>{renderMarkdownInline(row[cellIndex] ?? "", `td-${blockIndex}-${rowIndex}-${cellIndex}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const orderedList = Boolean(ordered);
      const items: string[] = [];
      while (index < lines.length) {
        const current = (lines[index] ?? "").trim();
        const match = orderedList ? current.match(/^\d+[.)]\s+(.+)$/) : current.match(/^[-*+]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]!.trim());
        index += 1;
      }
      const ListTag = orderedList ? "ol" : "ul";
      blocks.push(
        <ListTag key={`list-${blockIndex++}`}>
          {items.map((item, itemIndex) => <li key={itemIndex}>{renderMarkdownInline(item, `li-${blockIndex}-${itemIndex}`)}</li>)}
        </ListTag>,
      );
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && !isMarkdownBlockBoundary(lines, index)) {
      paragraphLines.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push(
      <p key={`p-${blockIndex++}`}>
        {renderMarkdownInline(paragraphLines.join("\n").trim(), `p-${blockIndex}`)}
      </p>,
    );
  }

  return blocks;
}

function renderMarkdownInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;
  let textBuffer = "";
  let nodeIndex = 0;

  const flushText = () => {
    if (!textBuffer) return;
    nodes.push(textBuffer);
    textBuffer = "";
  };

  while (index < text.length) {
    if (text.startsWith("`", index)) {
      const end = text.indexOf("`", index + 1);
      if (end > index + 1) {
        flushText();
        nodes.push(<code key={`${keyPrefix}-code-${nodeIndex++}`}>{text.slice(index + 1, end)}</code>);
        index = end + 1;
        continue;
      }
    }

    if (text.startsWith("**", index)) {
      const end = text.indexOf("**", index + 2);
      if (end > index + 2) {
        flushText();
        nodes.push(<strong key={`${keyPrefix}-strong-${nodeIndex++}`}>{renderMarkdownInline(text.slice(index + 2, end), `${keyPrefix}-strong-${nodeIndex}`)}</strong>);
        index = end + 2;
        continue;
      }
    }

    if (text.startsWith("*", index) && !text.startsWith("**", index)) {
      const end = text.indexOf("*", index + 1);
      if (end > index + 1) {
        flushText();
        nodes.push(<em key={`${keyPrefix}-em-${nodeIndex++}`}>{renderMarkdownInline(text.slice(index + 1, end), `${keyPrefix}-em-${nodeIndex}`)}</em>);
        index = end + 1;
        continue;
      }
    }

    if (text.startsWith("[", index)) {
      const close = text.indexOf("]", index + 1);
      const openParen = close >= 0 ? text.indexOf("(", close + 1) : -1;
      const closeParen = openParen >= 0 ? text.indexOf(")", openParen + 1) : -1;
      if (close > index + 1 && openParen === close + 1 && closeParen > openParen + 1) {
        const label = text.slice(index + 1, close);
        const href = safeMarkdownHref(text.slice(openParen + 1, closeParen));
        if (href) {
          flushText();
          nodes.push(
            <a key={`${keyPrefix}-link-${nodeIndex++}`} href={href} target="_blank" rel="noreferrer">
              {renderMarkdownInline(label, `${keyPrefix}-link-${nodeIndex}`)}
            </a>,
          );
          index = closeParen + 1;
          continue;
        }
      }
    }

    textBuffer += text[index];
    index += 1;
  }

  flushText();
  return nodes;
}

function isMarkdownBlockBoundary(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^```/.test(trimmed)) return true;
  if (/^(#{1,4})\s+/.test(trimmed)) return true;
  if (/^>\s?/.test(trimmed)) return true;
  if (/^[-*+]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) return true;
  if (isMarkdownTableStart(lines, index)) return true;
  return false;
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  const current = lines[index] ?? "";
  const next = lines[index + 1] ?? "";
  return isMarkdownTableRow(current) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next);
}

function isMarkdownTableRow(line: string): boolean {
  return line.includes("|") && splitMarkdownTableRow(line).length >= 2;
}

function splitMarkdownTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function safeMarkdownHref(rawHref: string): string | null {
  const href = rawHref.trim();
  if (!href) return null;
  if (/^(https?:|mailto:)/i.test(href)) return href;
  if (/^[#/][^\s]*$/.test(href)) return href;
  return null;
}
