/**
 * Turn an assistant reply (light Markdown with links) into text Siri can read
 * aloud: link labels instead of URLs, no Markdown symbols, no bare URLs.
 */
export function spokenAnswer(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^#{1,4}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
