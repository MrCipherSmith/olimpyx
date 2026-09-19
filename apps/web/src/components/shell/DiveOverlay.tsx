import { useEffect, useState } from 'react';
import type { DiveState, DiveTarget } from './diveMachine';

/** Overlay fade-out (matches .dive-overlay's opacity transition); the label stays readable until it ends. */
const FADE_MS = 450;

/**
 * The full-screen "/// INITIATING PACKET DIVE ///" overlay (PROMPT §4): shown while diving and while it
 * covers a closing screen. Purely decorative (aria-hidden): screen readers follow the focus, which moves
 * to the screen heading when the dive lands. It blocks pointer input only while visible.
 */
export function DiveOverlay({ dive }: { dive: DiveState }) {
  const visible = dive.phase === 'diving' || (dive.phase === 'exiting' && dive.covered);
  const entering = dive.phase === 'diving';
  // Keep the name on screen while the overlay fades out after the dive lands.
  const [label, setLabel] = useState<DiveTarget | null>(null);
  useEffect(() => {
    if (entering && dive.target) { setLabel(dive.target); return; }
    if (!label) return;
    const timer = setTimeout(() => setLabel(null), FADE_MS);
    return () => clearTimeout(timer);
  }, [entering, dive.target]);

  return (
    <div className={`dive-overlay${visible ? ' visible' : ''}`} aria-hidden="true" data-phase={dive.phase}>
      {label && (
        <div className={`dive-overlay-label${entering ? ' shown' : ''}`}>
          <p className="dive-overlay-kicker">/// INITIATING PACKET DIVE ///</p>
          <p className="dive-overlay-name">{label.name}</p>
          <p className="dive-overlay-sub">{label.subline}</p>
        </div>
      )}
    </div>
  );
}

/** The "target lock" frame at the centre of the city while the camera focuses on the building. */
export function TargetLock({ target }: { target: DiveTarget | null }) {
  if (!target) return null;
  return (
    <div className="target-lock" aria-hidden="true">
      <div className="target-lock-frame"><i /><i /><i /><i /><span className="target-lock-dot" /></div>
      <p className="target-lock-text"><span>⊙</span> TARGET LOCKED: {target.name}</p>
    </div>
  );
}
