// Lets other views open the store on a given tab (e.g. "Downloaded" or "On this phone").
import { create } from 'zustand';
import { setState } from './store';

export type StoreTab = 'discover' | 'categories' | 'downloads' | 'device';

export const useStoreTabRequest = create<{ tab: StoreTab | null; seq: number }>(() => ({ tab: null, seq: 0 }));

export function openStoreTab(tab: StoreTab) {
  useStoreTabRequest.setState((s) => ({ tab, seq: s.seq + 1 }));
  setState({ section: 'store', part: null });
}
