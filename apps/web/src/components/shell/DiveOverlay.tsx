import { useEffect, useState } from 'react';
import type { DiveState, DiveTarget } from './diveMachine';

/** Overlay fade-out (matches .dive-overlay's opacity transition); the label stays readable until it ends. */
const FADE_MS = 450;

/**
 * The full-screen "/// INITIATING PACKET DIVE ///" overlay (PROMPT §4): shown while diving and while it
 * covers a closing screen. The visual overlay is decorative (aria-hidden): a polite, visually hidden status
 * region announces "Opening <name>…" during the dive instead, and focus moves to the screen heading when the
 * dive lands. It blocks pointer input only while visible. Names are untrusted: sanitised by diveTargetFor and
 * isolated with <bdi> here.
 */
export function DiveOverlay({ dive }: { dive: DiveState }) {
  const visible = dive.phase === 'diving' || (dive.phase === 'exiting' && dive.covered);
  const entering = dive.phase === 'diving';
  const showing = entering ? dive.target : null;
  // Keep the name on screen while the overlay fades out after the dive lands.
  const [label, setLabel] = useState<DiveTarget | null>(null);
  useEffect(() => {
    if (showing) { setLabel(showing); return; }
    const timer = setTimeout(() => setLabel(null), FADE_MS);
    return () => clearTimeout(timer);
  }, [showing]);
  const announced = (dive.phase === 'focusing' || dive.phase === 'diving') && dive.target ? dive.target.name : null;

  return (
    <>
      <div className={`dive-overlay${visible ? ' visible' : ''}`} aria-hidden="true" data-phase={dive.phase}>
        {label && (
          <div className={`dive-overlay-label${entering ? ' shown' : ''}`}>
            <p className="dive-overlay-kicker">/// INITIATING PACKET DIVE ///</p>
            <p className="dive-overlay-name"><bdi>{label.name}</bdi></p>
            <p className="dive-overlay-sub"><bdi>{label.subline}</bdi></p>
          </div>
        )}
      </div>
      <p className="visually-hidden dive-status" role="status" aria-live="polite">{announced && <>Opening <bdi>{announced}</bdi>…</>}</p>
    </>
  );
}

/** The "target lock" frame at the centre of the city while the camera focuses on the building. */
export function TargetLock({ target }: { target: DiveTarget | null }) {
  if (!target) return null;
  return (
    <div className="target-lock" aria-hidden="true">
      <div className="target-lock-frame"><i /><i /><i /><i /><span className="target-lock-dot" /></div>
      <p className="target-lock-text"><span>⊙</span> TARGET LOCKED: <bdi>{target.name}</bdi></p>
    </div>
  );
}
