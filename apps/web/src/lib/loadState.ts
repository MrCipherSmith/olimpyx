export type LoadState<T> = { data: T; loading: boolean; error: string | null };

export const empty = <T,>(data: T): LoadState<T> => ({ data, loading: false, error: null });
