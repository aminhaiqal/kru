/** Best-effort redaction of common provider credentials, before errors enter events or status. */
export function storedError(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  const clean = message
    .replace(/\b(authorization["']?\s*:\s*["']?(?:bearer|basic)\s+)[^"'\s,;]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|client[_-]?secret|password)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s&;,}\]]+)/gi, '$1[REDACTED]')
    .replace(/([?&](?:key|signature)=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  const bytes = Buffer.from(clean);
  return bytes.length <= 8192 ? clean : new TextDecoder().decode(bytes.subarray(0, 8189), { stream: true }) + '...';
}
