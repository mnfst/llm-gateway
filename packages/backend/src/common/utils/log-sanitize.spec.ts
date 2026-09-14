import { forLogLabel } from './log-sanitize';

describe('forLogLabel', () => {
  it('replaces C0, DEL and C1 control characters with spaces', () => {
    // A newline could forge an extra log line; 0x9b is the CSI escape opener.
    expect(forLogLabel('a\nb')).toBe('a b');
    expect(forLogLabel('x\u007fy')).toBe('x y');
    expect(forLogLabel('x\u009by')).toBe('x y');
  });

  it('caps by code point without splitting a surrogate pair', () => {
    const emoji = '\u{1F600}';
    expect(forLogLabel(emoji.repeat(70))).toBe(emoji.repeat(64) + '…');
  });

  it('leaves a short clean label unchanged', () => {
    expect(forLogLabel('Work')).toBe('Work');
  });
});
