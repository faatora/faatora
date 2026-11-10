import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  ACTIVE_FIRM_STORAGE_KEY,
  UnauthorizedError,
  getActiveFirmId,
  setActiveFirmId,
} from '../../../lib/api';
import { fetchMyFirms } from '../api';
import type { Firm, FirmMembership } from '../types';

export type FirmLoadState = 'idle' | 'loading' | 'ready' | 'unauthenticated' | 'error';

export interface FirmContextValue {
  /** Null while loading, or when the user has no firms (SME mode). */
  activeFirm: Firm | null;
  /** All memberships returned by GET /firms/mine. Empty => SME mode. */
  firmList: FirmMembership[];
  /** True if the user is a firm member (irrespective of which firm is active). */
  isFirmUser: boolean;
  state: FirmLoadState;
  /** Switch the active firm. Pass null to clear context (reverts to SME mode). */
  switchFirm: (firmId: string | null) => void;
  /** Re-fetch the firm list, e.g. after creating a firm or accepting an invite. */
  refreshFirms: () => Promise<void>;
}

const noop = () => {
  /* placeholder */
};

const defaultValue: FirmContextValue = {
  activeFirm: null,
  firmList: [],
  isFirmUser: false,
  state: 'idle',
  switchFirm: noop,
  refreshFirms: async () => {
    /* placeholder */
  },
};

const FirmContext = createContext<FirmContextValue>(defaultValue);

export interface FirmContextProviderProps {
  children: ReactNode;
  /**
   * Optional override so tests can skip the initial network call. When false
   * the provider behaves exactly as if the user were in SME mode.
   */
  loadOnMount?: boolean;
}

export function FirmContextProvider({ children, loadOnMount = true }: FirmContextProviderProps) {
  const [state, setState] = useState<FirmLoadState>('idle');
  const [firmList, setFirmList] = useState<FirmMembership[]>([]);
  const [activeFirmId, setActiveFirmIdState] = useState<string | null>(() => getActiveFirmId());

  const refreshFirms = useCallback(async () => {
    setState('loading');
    try {
      const memberships = await fetchMyFirms();
      setFirmList(memberships);

      if (memberships.length === 0) {
        // SME mode: no firms, clear any stale firm selection.
        setActiveFirmId(null);
        setActiveFirmIdState(null);
        setState('ready');
        return;
      }

      // Prefer the stored selection, fall back to first membership.
      const stored = getActiveFirmId();
      const found = memberships.find((m) => m.firm.id === stored);
      const nextId = found ? found.firm.id : memberships[0].firm.id;
      setActiveFirmId(nextId);
      setActiveFirmIdState(nextId);
      setState('ready');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        setState('unauthenticated');
        // Keep whatever selection the user had so that re-auth restores context.
        setFirmList([]);
        return;
      }
      setState('error');
    }
  }, []);

  useEffect(() => {
    if (!loadOnMount) {
      setState('ready');
      return;
    }
    void refreshFirms();
  }, [loadOnMount, refreshFirms]);

  const switchFirm = useCallback((firmId: string | null) => {
    setActiveFirmId(firmId);
    setActiveFirmIdState(firmId);
  }, []);

  const value = useMemo<FirmContextValue>(() => {
    const active =
      activeFirmId != null
        ? (firmList.find((m) => m.firm.id === activeFirmId)?.firm ?? null)
        : null;
    return {
      activeFirm: active,
      firmList,
      isFirmUser: firmList.length > 0,
      state,
      switchFirm,
      refreshFirms,
    };
  }, [activeFirmId, firmList, refreshFirms, state, switchFirm]);

  return <FirmContext.Provider value={value}>{children}</FirmContext.Provider>;
}

export function useFirmContext(): FirmContextValue {
  return useContext(FirmContext);
}

export { FirmContext, ACTIVE_FIRM_STORAGE_KEY };
