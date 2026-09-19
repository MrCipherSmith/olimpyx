import { i18n } from '../i18n';
import { ApiError } from './auth-session';

const KNOWN_CODES = new Set([
  'validation_error',
  'embedding_unavailable',
  'rate_limited',
  'forbidden',
  'unauthorized',
  'not_found',
  'conflict',
  'quota_exceeded',
  'internal_error',
  'network_offline',
]);

interface RawErrorPayload {
  error?: { code?: string; message?: string };
  code?: string;
  message?: string;
}

function extractCode(error: unknown): string | null {
  if (error instanceof ApiError) {
    const details = error.details as RawErrorPayload | undefined;
    if (details?.error?.code) return details.error.code;
    if (details?.code) return details.code;
  }
  if (error && typeof error === 'object') {
    const anyError = error as { code?: string };
    if (typeof anyError.code === 'string') return anyError.code;
  }
  return null;
}

function isDev(): boolean {
  return typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV);
}

/**
 * Returns a user-facing, localized message for any thrown error:
 *  - known `error.code` → i18n key `errors:CODE`
 *  - network failure (status 0) → `errors:network_offline`
 *  - unknown code → raw `message`, suffixed with `(en)` only in DEV
 *  - non-Error throw → `errors:internal_error`
 */
export function humanizeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return i18n.t('errors.internal_error');
  }
  if (error instanceof ApiError && error.status === 0) {
    return i18n.t('errors.network_offline', { defaultValue: error.message });
  }
  const code = extractCode(error);
  if (code && KNOWN_CODES.has(code)) {
    return i18n.t(`errors.${code}`, { defaultValue: error.message });
  }
  if (isDev()) {
    return error.message ? `${error.message} (en)` : i18n.t('errors.internal_error');
  }
  return error.message || i18n.t('errors.internal_error');
}