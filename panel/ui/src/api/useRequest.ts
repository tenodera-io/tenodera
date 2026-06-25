import { useState, useEffect, useCallback, useRef } from 'react';
import { useTransport } from './HostTransportContext.tsx';

export interface UseRequestResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Hook for one-shot channel requests.
 *
 * Fires on mount and on every `deps` change, re-fires on `reload()`.
 * Returns `{ data, loading, error, reload }`.
 *
 * The `transform` function converts the raw results array from `request()`
 * into the typed value stored in `data`. Defaults to `results[0]`.
 */
export function useRequest<T = unknown>(
  payload: string,
  options: Record<string, unknown> = {},
  transform: (results: unknown[]) => T = (r) => r[0] as T,
): UseRequestResult<T> {
  const { request } = useTransport();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reloadCounter = useRef(0);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => {
    reloadCounter.current++;
    setTick((n) => n + 1);
  }, []);

  // Stringify options once so the effect dep is stable
  const optionsKey = JSON.stringify(options);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    request(payload, JSON.parse(optionsKey) as Record<string, unknown>)
      .then((results) => {
        if (cancelled) return;
        setData(transform(results));
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, optionsKey, tick]);

  return { data, loading, error, reload };
}
