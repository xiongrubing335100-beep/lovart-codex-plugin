// Hosts may preserve structuredContent, or expose the same JSON as text only.
export function decodeToolResult(result, depth = 0) {
  if (!result || depth > 3) return null;
  if (typeof result === 'string') {
    try { return decodeToolResult(JSON.parse(result), depth + 1); } catch { return null; }
  }
  if (result.isError) return null;
  if (result.contract_version === '1') return result;
  const structured = decodeToolResult(result.structuredContent, depth + 1);
  if (structured) return structured;
  for (const block of result.content ?? []) {
    if (block.type !== 'text') continue;
    const decoded = decodeToolResult(block.text, depth + 1);
    if (decoded) return decoded;
  }
  return null;
}
