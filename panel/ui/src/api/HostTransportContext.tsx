import { createContext, useContext, useCallback, useMemo } from 'react';
import {
  openChannel as realOpenChannel,
  request as realRequest,
} from './transport.ts';

const HostIdContext = createContext<string | null>(null);

export const HostTransportProvider = HostIdContext.Provider;

/**
 * Transport hook that transparently routes channels to the correct bridge.
 *
 * When hostId is null → channels go to local bridge (normal).
 * When hostId is set  → `host: hostId` is added to Open options,
 *                        so the gateway routes to the remote bridge via SSH.
 *
 * The remote bridge speaks the exact same protocol — no proxies, no polling.
 */
export function useTransport() {
  const hostId = useContext(HostIdContext);

  const request = useCallback(
    (payload: string, options: Record<string, unknown> = {}): Promise<unknown[]> => {
      const opts = hostId ? { ...options, host: hostId } : options;
      return realRequest(payload, opts);
    },
    [hostId],
  );

  const openChannel = useCallback(
    (payload: string, options: Record<string, unknown> = {}) => {
      const opts = hostId ? { ...options, host: hostId } : options;
      return realOpenChannel(payload, opts);
    },
    [hostId],
  );

  return useMemo(() => ({ request, openChannel }), [request, openChannel]);
}
