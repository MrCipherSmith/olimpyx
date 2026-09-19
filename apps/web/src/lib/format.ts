export const ago = (date?: string | null) => date ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date)) : '—';

export function messageFrom(error: unknown) { return error instanceof Error ? error.message : 'Something unexpected happened.'; }
