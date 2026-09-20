import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../i18n';
import { ApiError } from './auth-session';
import { humanizeError } from './humanizeError';

const setLang = async (lng: string) => { await i18n.changeLanguage(lng); };

describe('humanizeError', () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    await setLang('en');
  });

  it('localizes known validation_error in English', () => {
    const error = new ApiError('Invalid request fields', 400, { error: { code: 'validation_error' } });
    expect(humanizeError(error)).toBe('Please review the highlighted fields');
  });

  it('localizes known embedding_unavailable in Russian', async () => {
    await setLang('ru');
    const error = new ApiError('Embedding service is down', 503, { error: { code: 'embedding_unavailable' } });
    expect(humanizeError(error)).toBe('Семантический поиск временно недоступен. Попробуйте лексический поиск.');
  });

  it('uses network_offline for status 0', async () => {
    await setLang('ru');
    const error = new ApiError('Network down', 0);
    expect(humanizeError(error)).toBe('Нет соединения с сервером.');
  });

  it('returns generic localized text for non-Error throws', async () => {
    await setLang('ru');
    expect(humanizeError('something')).toBe('Внутренняя ошибка сервера. Попробуйте позже.');
  });

  it('falls back to raw message for unknown codes in production', () => {
    vi.stubEnv('DEV', false);
    const error = new ApiError('Custom backend message', 500, { error: { code: 'rare_thing_happened' } });
    expect(humanizeError(error)).toBe('Custom backend message');
  });

  it('appends (en) suffix to unknown codes in DEV', () => {
    vi.stubEnv('DEV', true);
    const error = new ApiError('Custom backend message', 500, { error: { code: 'rare_thing_happened' } });
    expect(humanizeError(error)).toBe('Custom backend message (en)');
  });
});