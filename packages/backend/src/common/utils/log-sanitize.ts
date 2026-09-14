/** Longest connection label echoed into a log line. */
const MAX_LOGGED_LABEL_LENGTH = 64;

/**
 * Connection labels are user-authored text. Strip control characters (a
 * newline would let a label forge extra log lines) and cap the length before
 * interpolating one into a log message.
 */
export function forLogLabel(label: string): string {
  const cleaned = [...label].map((c) => {
    const code = c.codePointAt(0) ?? 0;
    // C0 (0x00-0x1f), DEL (0x7f) and C1 (0x80-0x9f, which includes the 0x9b
    // CSI escape opener) can forge log lines or drive a terminal, so replace
    // them with a space. Iterating the string keeps surrogate pairs whole.
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : c;
  });
  // Truncate by code point so a multi-byte character is never split.
  return cleaned.length > MAX_LOGGED_LABEL_LENGTH
    ? `${cleaned.slice(0, MAX_LOGGED_LABEL_LENGTH).join('')}…`
    : cleaned.join('');
}
