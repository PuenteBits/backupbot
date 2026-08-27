/**
 * Dump tools echo connection strings into their own error output, so every
 * captured stream is scrubbed before it is written to a log or shown anywhere.
 */
export function redact(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join("****");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join("****");
  }
  return out;
}

export function createRedactor(secrets: Iterable<string>) {
  const list = [...secrets].filter((s) => s && s.length >= 4);
  return (text: string) => redact(text, list);
}
