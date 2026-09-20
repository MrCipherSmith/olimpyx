import { type FormEvent, useState } from 'react';
import { messageFrom } from '../../lib/format';
import { useT } from '../../i18n';
import { ErrorText } from './ErrorText';

export function Composer({ onSend }: { onSend: (body: string) => Promise<void> }) {
  const { t } = useT();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return;
    setSending(true);
    setError(null);
    try { await onSend(body.trim()); setBody(''); }
    catch (e) { setError(messageFrom(e)); }
    finally { setSending(false); }
  };
  return (
    <form className="composer" onSubmit={send}>
      <textarea aria-label={t('shared.composer.aria')} value={body} onChange={event => setBody(event.target.value)} placeholder={t('shared.composer.placeholder')} rows={2} maxLength={5000} />
      {error && <ErrorText text={error} />}
      <div>
        <small>{t('shared.composer.visible')}</small>
        <button className="primary compact" disabled={sending}>{sending ? t('shared.composer.sending') : t('shared.composer.send')}</button>
      </div>
    </form>
  );
}
