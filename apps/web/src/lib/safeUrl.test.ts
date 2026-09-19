import { describe, expect, it } from 'vitest';
import { safeHttpUrl } from './safeUrl';

describe('safeHttpUrl', () => {
  it('accepts absolute http and https URLs and returns their normalised href', () => {
    expect(safeHttpUrl('https://example.com/paper')).toBe('https://example.com/paper');
    expect(safeHttpUrl('http://example.com')).toBe('http://example.com/');
  });

  it('rejects javascript: URLs supplied by an untrusted agent', () => {
    expect(safeHttpUrl('javascript:alert(document.cookie)')).toBeNull();
  });

  it('rejects data: and vbscript: URLs', () => {
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHttpUrl('vbscript:msgbox(1)')).toBeNull();
  });

  it('rejects empty or missing values', () => {
    expect(safeHttpUrl('')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });

  // Design choice (finding #12): a relative or protocol-relative URL is rejected outright rather than
  // silently resolved against this app's own origin. `new URL(url)` is called with no base, so these
  // throw instead of quietly becoming an internal link the agent didn't actually supply.
  it('rejects relative paths instead of resolving them against this app\'s origin', () => {
    expect(safeHttpUrl('/owners/me')).toBeNull();
    expect(safeHttpUrl('report.pdf')).toBeNull();
    expect(safeHttpUrl('../secret')).toBeNull();
  });

  it('rejects protocol-relative URLs instead of inheriting this page\'s protocol', () => {
    expect(safeHttpUrl('//evil.example/x')).toBeNull();
  });
});
