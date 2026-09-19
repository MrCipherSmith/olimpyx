import { type FormEvent, useEffect, useState } from 'react';
import { messageFrom } from '../../lib/format';
import { encodeRoomMetadata, getArchetype, ROOM_ARCHETYPES, ROOM_CATEGORIES } from '../city/roomArchetypes';
import { accentStyle } from '../shared/accentStyle';
import { ErrorText } from '../shared/ErrorText';

export function CreateRoom({ onClose, onCreate }: { onClose: () => void; onCreate: (input: { title: string; description?: string }) => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedArchetypeId, setSelectedArchetypeId] = useState<string>('lab_observatory');

  const selectedArch = getArchetype(selectedArchetypeId);
  const filteredArchetypes = selectedCategory === 'all'
    ? ROOM_ARCHETYPES
    : ROOM_ARCHETYPES.filter(a => a.category === selectedCategory);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSending(true);
    try {
      const title = String(form.get('title') || '').trim();
      const rawDesc = String(form.get('description') || '').trim();
      const finalDescription = encodeRoomMetadata(selectedArchetypeId, rawDesc);
      await onCreate({
        title,
        description: finalDescription || undefined
      });
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

          <div className="archetype-picker" role="group" aria-labelledby="archetype-picker-label">
            <span className="eyebrow" id="archetype-picker-label">АРХИТЕКТУРНЫЙ МАКЕТ ДЛЯ ГОРОДА ({ROOM_ARCHETYPES.length} ТИПОВ)</span>
            <div className="category-tabs">
              <button type="button" className={`category-tab${selectedCategory === 'all' ? ' active' : ''}`} aria-pressed={selectedCategory === 'all'} onClick={() => setSelectedCategory('all')}>
                ✦ Все ({ROOM_ARCHETYPES.length})
              </button>
              {ROOM_CATEGORIES.map(cat => (
                <button key={cat.id} type="button" className={`category-tab${selectedCategory === cat.id ? ' active' : ''}`} aria-pressed={selectedCategory === cat.id} onClick={() => setSelectedCategory(cat.id)}>
                  <span aria-hidden="true">{cat.icon}</span> {cat.label}
                </button>
              ))}
            </div>
          </div>

          <div className="archetype-grid">
            {filteredArchetypes.map(arch => {
              const isSelected = arch.id === selectedArchetypeId;
              return (
                <button type="button" key={arch.id} className={`archetype-card${isSelected ? ' selected' : ''}`} aria-pressed={isSelected} onClick={() => setSelectedArchetypeId(arch.id)} style={accentStyle(arch.color)}>
                  <span className="archetype-card-head">
                    <span className="archetype-card-icon" aria-hidden="true">{arch.icon}</span>
                    <span className="archetype-card-badge">{arch.badge}</span>
                  </span>
                  <strong>{arch.name}</strong>
                  <span>{arch.description}</span>
                  {isSelected && <span className="archetype-card-selected">✓ ВЫБРАН МАКЕТ</span>}
                </button>
              );
            })}
          </div>

          <div className="archetype-preview" style={accentStyle(selectedArch.color)}>
            <span aria-hidden="true">{selectedArch.icon}</span>
            <div>
              <strong>{selectedArch.name} ({selectedArch.badge})</strong>
              <small>{selectedArch.description}</small>
            </div>
          </div>

          <label>Description <span className="muted">optional</span><textarea name="description" maxLength={500} rows={3} placeholder={`Например: ${selectedArch.defaultTopic}`} /></label>
        </div>
        {error && <ErrorText text={error} />}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={sending}>{sending ? 'Creating…' : 'Create room'}</button>
        </div>
      </form>
    </div>
  );
}
