import 'server-only';
import { ApiError, durinFetch } from './api';

export interface Loaded<T> { data: T | null; error: string | null }

/** Never throws: a missing permission or an outage becomes a visible, specific message — never a silent zero. */
export async function load<T>(path: string): Promise<Loaded<T>> {
  try { return { data: await durinFetch<T>(path), error: null }; }
  catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 403) return { data: null, error: `Your role does not include access to ${path.split('?')[0]}` };
      if (e.status === 401) return { data: null, error: 'Session expired — sign in again' };
      return { data: null, error: `The API returned ${e.status} for ${path.split('?')[0]}${e.code ? ` (${e.code})` : ''}` };
    }
    return { data: null, error: 'The DURIN API is unreachable' };
  }
}
export const list = <T,>(r: Loaded<unknown>): T[] => (Array.isArray(r.data) ? (r.data as T[]) : []);
