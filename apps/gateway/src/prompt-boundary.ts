export function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function xmlTextBlock(tag: string, text: string): string {
  return `<${tag}>\n${escapeXmlText(text)}\n</${tag}>`;
}

export function xmlJsonBlock(tag: string, value: unknown): string {
  return xmlTextBlock(tag, JSON.stringify(value, null, 2));
}
