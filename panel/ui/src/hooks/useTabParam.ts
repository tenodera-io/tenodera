import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

// Keeps a page's active sub-tab in the URL (?tab=…) so the sidebar
// sub-navigation and the in-page tabs stay in sync and the view is linkable.
// The default tab is represented by the absence of the param (clean URL).
export function useTabParam<T extends string>(
  valid: readonly T[],
  fallback: T,
): [T, (t: T) => void] {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get('tab');
  const tab = (valid as readonly string[]).includes(raw ?? '') ? (raw as T) : fallback;

  const setTab = useCallback(
    (t: T) => {
      setSp(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (t === fallback) next.delete('tab');
          else next.set('tab', t);
          return next;
        },
        { replace: true },
      );
    },
    [setSp, fallback],
  );

  return [tab, setTab];
}
