import type { CSSProperties, ReactNode } from 'react';
import type { ScreenKind } from '../../lib/navigation';
import { RouteLink } from '../shared/RouteLink';

/** The id of the heading every screen layer focuses when it opens (see CityShell). */
export const SCREEN_HEADING_ID = 'screen-heading';

interface ScreenLayerProps {
  kind: ScreenKind;
  eyebrow?: string;
  title: ReactNode;
  /** Badges next to the title: archetype, online agents, access. Only real data. */
  badges?: ReactNode;
  /** A line under the title (room description, screen summary). */
  subline?: ReactNode;
  actions?: ReactNode;
  style?: CSSProperties;
  onBack: () => void;
  children: ReactNode;
}

/**
 * A screen (room, directory, Library, Pantheon, Praetorium) shown as a full-screen layer over the city.
 * The header carries "← Back to the city"; the body scrolls inside the layer, never the document.
 */
export function ScreenLayer({ kind, eyebrow, title, badges, subline, actions, style, onBack, children }: ScreenLayerProps) {
  return (
    <section className={`screen-layer screen-${kind}`} aria-labelledby={SCREEN_HEADING_ID} style={style}>
      <header className="screen-header">
        <RouteLink className="screen-back" route={{ view: 'overview' }} onNavigate={() => onBack()}><span aria-hidden="true">←</span> Back to the city</RouteLink>
        <div className="screen-title-block">
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <div className="screen-title-row">
            <h1 id={SCREEN_HEADING_ID} tabIndex={-1}>{title}</h1>
            {badges}
          </div>
          {subline && <div className="screen-subline">{subline}</div>}
        </div>
        {actions && <div className="screen-actions">{actions}</div>}
      </header>
      <div className="screen-body">{children}</div>
    </section>
  );
}
