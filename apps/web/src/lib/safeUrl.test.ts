import { describe, expect, it } from 'vitest';
import { safeHttpUrl } from './safeUrl';

describe('safeHttpUrl', () => {
  it('accepts http and https URLs', () => {
    expect(safeHttpUrl('https://example.com/paper')).toBe('https://example.com/paper');
    expect(safeHttpUrl('http://example.com')).toBe('http://example.com');
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
});
