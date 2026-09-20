import { type FormEvent, useState } from 'react';
import type { OlimpyxApi } from '../../lib/api';
import type { StoredSession } from '../../lib/auth-session';
import { messageFrom } from '../../lib/format';
import { useT } from '../../i18n';

export function AuthScreen({ api, onAuthenticated, onBack }: { api: OlimpyxApi; onAuthenticated: (session: StoredSession) => void; onBack?: () => void }) {
  const { t } = useT();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setLoading(true);
    setError(null);
    try {
      onAuthenticated(mode === 'login'
        ? await api.login({ email: String(form.get('email')), password: String(form.get('password')) })
        : await api.register({ email: String(form.get('email')), password: String(form.get('password')), displayName: String(form.get('displayName')) }));
    } catch (e) { setError(messageFrom(e)); }
    finally { setLoading(false); }
  };
  return (
    <main className="auth-page">
      <section className="auth-copy">
        <div className="brand"><span className="brand-mark">◈</span>olimpyx</div>
        <p className="eyebrow">{t('auth.eyebrow')}</p>
        <h1>{t('auth.headline')}</h1>
        <p>{t('auth.lead')}</p>
        <div className="principles">
          <span>{t('auth.principles.showcase')}</span>
          <span>{t('auth.principles.authorship')}</span>
          <span>{t('auth.principles.owner')}</span>
        </div>
        {onBack && <button className="text-button" onClick={onBack}>{t('auth.backToShowcase')}</button>}
      </section>
      <section className="auth-card">
        <p className="eyebrow">{mode === 'login' ? t('auth.login.eyebrow') : t('auth.register.eyebrow')}</p>
        <h2>{mode === 'login' ? t('auth.login.title') : t('auth.register.title')}</h2>
        <form onSubmit={submit}>
          {mode === 'register' && <label>{t('auth.register.displayName')}<input name="displayName" required autoComplete="name" /></label>}
          <label>{t('auth.login.email')}<input name="email" type="email" required autoComplete="email" /></label>
          <label>{t('auth.login.password')}<input name="password" type="password" minLength={12} required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary" disabled={loading}>{loading ? t('auth.login.submitting') : mode === 'login' ? t('auth.login.submit') : t('auth.register.submit')}</button>
        </form>
        <button className="text-button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}>{mode === 'login' ? t('auth.login.switchMode') : t('auth.register.switchMode')}</button>
      </section>
    </main>
  );
}
