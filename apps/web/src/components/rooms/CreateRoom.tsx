import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';
import { messageFrom } from '../../lib/format';
import { useT } from '../../i18n';
import { ArchetypePreview } from '../city/ArchetypePreview';
import {
  archetypeColorVar, categoryInfo, encodeRoomMetadata, getArchetype, maxDescriptionLength,
  ROOM_ARCHETYPES, ROOM_CATEGORIES, type ArchetypeCategory, type ArchetypeId,
} from '../city/roomArchetypes';
import { accentStyle } from '../shared/accentStyle';
import { ErrorText } from '../shared/ErrorText';

/** Arrow keys move focus between the buttons of a group; Tab still leaves the group as usual. */
function moveFocus(event: ReactKeyboardEvent<HTMLElement>) {
  const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
  if (!step) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  buttons[(index + step + buttons.length) % buttons.length].focus();
}

const FOCUSABLE_SELECTOR = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function CreateRoom({ onClose, onCreate }: { onClose: () => void; onCreate: (input: { title: string; description?: string }) => Promise<void> }) {
  const { t } = useT();
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [category, setCategory] = useState<ArchetypeCategory>('science');
  // No explicit layout by default: the building is then derived from the new room's id.
  const [archetypeId, setArchetypeId] = useState<ArchetypeId | null>(null);
  const [description, setDescription] = useState('');

  const selected = archetypeId ? getArchetype(archetypeId) : null;
  const limit = maxDescriptionLength(archetypeId);

  const formRef = useRef<HTMLFormElement | null>(null);
  // Captured during the first render, before the dialog's own autoFocus can move focus away from the
  // opener (e.g. "+ New room"), so it reliably points back at whatever launched the dialog.
  const [opener] = useState<HTMLElement | null>(() => document.activeElement as HTMLElement | null);
  const sendingRef = useRef(sending);
  useEffect(() => { sendingRef.current = sending; }, [sending]);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // Restore focus to whatever opened the dialog once it closes/unmounts.
  useEffect(() => () => { opener?.focus?.(); }, [opener]);

  // Focus trap (Tab/Shift+Tab cycle within the dialog) and Escape-to-close, ignored while sending.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (sendingRef.current) return;
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const form = formRef.current;
      if (!form) return;
      const focusable = Array.from(form.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const insideForm = Boolean(active) && form.contains(active);
      if (event.shiftKey) {
        if (!insideForm || active === first) { event.preventDefault(); last.focus(); }
      } else if (!insideForm || active === last) {
        event.preventDefault(); first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSending(true);
    setError(null);
    try {
      const title = String(form.get('title') || '').trim();
      const stored = encodeRoomMetadata(archetypeId, description);
      await onCreate({ title, description: stored || undefined });
    } catch (e) {
      setError(messageFrom(e));
      setSending(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <form ref={formRef} className="modal archetype-modal" role="dialog" aria-modal="true" aria-labelledby="create-room-title" onSubmit={submit}>
        <div className="section-heading">
          <div>
            <p className="eyebrow">{t('rooms.create.eyebrow')}</p>
            <h2 id="create-room-title">{t('rooms.create.heading')}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={sending} aria-label={t('rooms.create.close')}>×</button>
        </div>
        <div className="archetype-modal-scroll">
          <label>{t('rooms.create.titleLabel')}<input name="title" required maxLength={120} autoFocus /></label>

          <fieldset className="archetype-picker">
            <legend className="eyebrow">{t('rooms.create.building')} <span className="muted">{t('rooms.create.optional')}</span></legend>
            <button type="button" className={`archetype-auto${archetypeId === null ? ' selected' : ''}`} aria-pressed={archetypeId === null} onClick={() => setArchetypeId(null)}>
              {t('rooms.create.automatic')}
            </button>
            <div className="category-tabs" role="group" aria-label={t('rooms.create.buildingCategory')} onKeyDown={moveFocus}>
              {ROOM_CATEGORIES.map(item => (
                <button key={item.id} type="button" className={`category-tab${category === item.id ? ' active' : ''}`} aria-pressed={category === item.id} onClick={() => setCategory(item.id)}>
                  <span aria-hidden="true">{item.icon}</span> {item.labelEn}
                </button>
              ))}
            </div>
            <div className="archetype-grid" role="group" aria-label={`${categoryInfo(category).labelEn} buildings`} onKeyDown={moveFocus}>
              {ROOM_ARCHETYPES.filter(item => item.category === category).map(item => {
                const isSelected = item.id === archetypeId;
                return (
                  <button type="button" key={item.id} className={`archetype-card${isSelected ? ' selected' : ''}`} aria-pressed={isSelected} onClick={() => setArchetypeId(isSelected ? null : item.id)} style={accentStyle(archetypeColorVar(item.color))}>
                    <span className="archetype-card-head">
                      <span className="archetype-card-icon" aria-hidden="true">{item.icon}</span>
                      <span className="archetype-card-badge">{categoryInfo(item.category).labelEn}</span>
                    </span>
                    <strong>{item.nameEn}</strong>
                    <span lang="ru">{item.name}</span>
                  </button>
                );
              })}
            </div>
            <div className="archetype-preview" style={accentStyle(archetypeColorVar(selected?.color ?? 'cyan'))} aria-live="polite">
              {selected ? <ArchetypePreview archetype={selected} /> : <span className="archetype-preview-auto" aria-hidden="true">✦</span>}
              <div>
                <strong>{selected ? `${selected.nameEn} · ${selected.name}` : t('rooms.create.automaticLayout')}</strong>
                <small>{selected ? selected.summary : t('rooms.create.automaticSummary')}</small>
                {selected && <small className="muted">{t('rooms.create.storedHint')}</small>}
              </div>
            </div>
          </fieldset>

          <label>{t('rooms.create.descriptionLabel')}
            <textarea name="description" maxLength={limit} rows={3} value={description} onChange={event => setDescription(event.target.value)} aria-describedby="create-room-description-limit" />
          </label>
          <small id="create-room-description-limit" className="muted">{t('rooms.create.charactersCount', { count: description.trim().length, limit })}</small>
        </div>
        {error && <ErrorText text={error} />}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={sending}>{t('rooms.create.cancel')}</button>
          <button className="primary" disabled={sending || description.trim().length > limit}>{sending ? t('rooms.create.submitting') : t('rooms.create.submit')}</button>
        </div>
      </form>
    </div>
  );
}
