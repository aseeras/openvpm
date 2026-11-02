"use client";

import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Renders the small Markdown subset the agent uses: paragraphs, "-" bullets,
 * "#" headings, **bold**, [label](href) links and bare https URLs. Built from
 * React elements (no innerHTML), and links are limited to in-app paths and
 * http(s) so a reply can never inject markup or script URLs.
 */

export type InlineToken =
  | { type: "text"; value: string }
  | { type: "bold"; value: string }
  | { type: "link"; label: string; href: string };

const INLINE_PATTERN =
  /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s)]+)/g;

/** Only in-app paths ("/patients/…") and http(s) URLs are allowed. */
export function safeHref(href: string): string | null {
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ type: "text", value: text.slice(last, index) });
    if (match[1] !== undefined) {
      tokens.push({ type: "bold", value: match[1] });
    } else if (match[2] !== undefined && match[3] !== undefined) {
      const href = safeHref(match[3]);
      tokens.push(
        href
          ? { type: "link", label: match[2], href }
          : { type: "text", value: match[2] },
      );
    } else if (match[4] !== undefined) {
      const href = safeHref(match[4]);
      tokens.push(
        href
          ? { type: "link", label: match[4], href }
          : { type: "text", value: match[4] },
      );
    }
    last = index + match[0].length;
  }
  if (last < text.length) tokens.push({ type: "text", value: text.slice(last) });
  return tokens;
}

function Inline({
  text,
  onNavigate,
}: {
  text: string;
  onNavigate?: () => void;
}) {
  return (
    <>
      {tokenizeInline(text).map((token, i) => {
        if (token.type === "bold") return <strong key={i}>{token.value}</strong>;
        if (token.type === "link") {
          const className =
            "font-medium text-primary underline underline-offset-2 break-words";
          return token.href.startsWith("/") ? (
            <Link key={i} href={token.href} className={className} onClick={onNavigate}>
              {token.label}
            </Link>
          ) : (
            <a
              key={i}
              href={token.href}
              target="_blank"
              rel="noopener noreferrer"
              className={className}
            >
              {token.label}
            </a>
          );
        }
        return <span key={i}>{token.value}</span>;
      })}
    </>
  );
}

export function AgentMessageText({
  text,
  onNavigate,
}: {
  text: string;
  onNavigate?: () => void;
}) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  let ordered = false;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const lines = paragraph;
    blocks.push(
      <p key={`p${blocks.length}`}>
        {lines.map((line, i) => (
          <span key={i}>
            {i > 0 ? <br /> : null}
            <Inline text={line} onNavigate={onNavigate} />
          </span>
        ))}
      </p>,
    );
    paragraph = [];
  };
  const flushBullets = () => {
    if (bullets.length === 0) return;
    const items = bullets.map((item, i) => (
      <li key={i}>
        <Inline text={item} onNavigate={onNavigate} />
      </li>
    ));
    blocks.push(
      ordered ? (
        <ol key={`o${blocks.length}`} className="list-decimal space-y-1 pl-5">
          {items}
        </ol>
      ) : (
        <ul key={`u${blocks.length}`} className="list-disc space-y-1 pl-5">
          {items}
        </ul>
      ),
    );
    bullets = [];
  };

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushParagraph();
      flushBullets();
    } else if (heading) {
      flushParagraph();
      flushBullets();
      blocks.push(
        <p key={`h${blocks.length}`} className="font-semibold">
          <Inline text={heading[1]!} onNavigate={onNavigate} />
        </p>,
      );
    } else if (bullet) {
      flushParagraph();
      const isOrdered = /\d/.test(bullet[1]!);
      // Only top-level lists change type; indented items join the open list.
      if (bullets.length > 0 && isOrdered !== ordered && !/^\s/.test(line)) {
        flushBullets();
      }
      if (bullets.length === 0) ordered = isOrdered;
      bullets.push(bullet[2]!);
    } else {
      flushBullets();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushBullets();

  return <div className="space-y-2 break-words">{blocks}</div>;
}
