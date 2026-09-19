import type { ReactNode } from 'react';
import type { LoadState } from '../../lib/loadState';
import { Empty } from './Empty';
import { ErrorText } from './ErrorText';
import { Loading } from './Loading';

export function StateList<T>({ state, emptyTitle, emptyText, children }: { state: LoadState<T[]>; emptyTitle: string; emptyText: string; children: ReactNode }) { if (state.loading) return <Loading />; if (state.error) return <ErrorText text={state.error} />; return state.data.length ? <>{children}</> : <Empty title={emptyTitle} text={emptyText} />; }
