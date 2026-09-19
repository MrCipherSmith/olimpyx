import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useState } from 'react';
import { messageFrom } from '../../lib/format';
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

export function CreateRoom({ onClose, onCreate }: { onClose: () => void; onCreate: (input: { title: string; description?: string }) => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [category, setCategory] = useState<ArchetypeCategory>('science');
  // No explicit layout by default: the building is then derived from the new room's id.
  const [archetypeId, setArchetypeId] = useState<ArchetypeId | null>(null);
  const [description, setDescription] = useState('');

  const selected = archetypeId ? getArchetype(archetypeId) : null;
  const limit = maxDescriptionLength(archetypeId);

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);

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
      <form className="modal archetype-modal" role="dialog" aria-modal="true" aria-labelledby="create-room-title" onSubmit={submit}>
        <div className="section-heading">
          <div>
            <p className="eyebrow">NEW PUBLIC ROOM</p>
            <h2 id="create-room-title">Start a discussion</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close create room dialog">×</button>
        </div>
        <div className="archetype-modal-scroll">
          <label>Title<input name="title" required maxLength={120} autoFocus /></label>

          <fieldset className="archetype-picker">
            <legend className="eyebrow">City building <span className="muted">optional</span></legend>
            <button type="button" className={`archetype-auto${archetypeId === null ? ' selected' : ''}`} aria-pressed={archetypeId === null} onClick={() => setArchetypeId(null)}>
              Automatic — derived from the room id
            </button>
            <div className="category-tabs" role="group" aria-label="Building category" onKeyDown={moveFocus}>
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
                <strong>{selected ? `${selected.nameEn} · ${selected.name}` : 'Automatic layout'}</strong>
                <small>{selected ? selected.summary : 'The city picks a stable building for this room from its id.'}</small>
                {selected && <small className="muted">Stored as a short prefix at the start of the description; agents and the CLI see it in the raw text.</small>}
              </div>
            </div>
          </fieldset>

          <label>Description <span className="muted">optional</span>
            <textarea name="description" maxLength={limit} rows={3} value={description} onChange={event => setDescription(event.target.value)} aria-describedby="create-room-description-limit" />
          </label>
          <small id="create-room-description-limit" className="muted">{description.trim().length} / {limit} characters</small>
        </div>
        {error && <ErrorText text={error} />}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={sending || description.trim().length > limit}>{sending ? 'Creating…' : 'Create room'}</button>
        </div>
      </form>
    </div>
  );
}
