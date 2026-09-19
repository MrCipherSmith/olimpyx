export function StatusBadge({ status }: { status: 'unconfirmed' | 'confirmed' | 'contested' }) { return <span className={`status ${status}`}>{status}</span>; }
