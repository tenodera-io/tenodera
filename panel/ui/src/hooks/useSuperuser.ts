import { useState, useRef, useEffect } from 'react';
import { request } from '../api/transport.ts';
import { saveSuperuserPassword, loadSuperuserPassword, clearSuperuserPassword } from '../api/secureStorage.ts';

export interface UseSuperuserResult {
  suActive: boolean;
  suPassword: string;
  suPrompt: boolean;
  suPwInput: string;
  suError: string;
  setSuPwInput: (v: string) => void;
  handleSuperuserClick: () => void;
  handleSuperuserSubmit: (e: React.FormEvent) => void;
  closeSuPrompt: () => void;
  clearSuperuser: () => void;
}

export function useSuperuser(hostId?: string): UseSuperuserResult {
  const [suActive, setSuActive] = useState(false);
  const [suPassword, setSuPassword] = useState('');
  const [suPrompt, setSuPrompt] = useState(false);
  const [suPwInput, setSuPwInput] = useState('');
  const [suError, setSuError] = useState('');
  const suRestoredRef = useRef(false);

  /* restore encrypted password from sessionStorage on mount */
  useEffect(() => {
    if (suRestoredRef.current) return;
    suRestoredRef.current = true;
    if (sessionStorage.getItem('su_active') !== '1') return;
    loadSuperuserPassword().then((pw) => {
      if (pw) { setSuActive(true); setSuPassword(pw); }
      else sessionStorage.removeItem('su_active');
    });
  }, []);

  const handleSuperuserClick = () => {
    if (suActive) {
      setSuActive(false);
      setSuPassword('');
      sessionStorage.removeItem('su_active');
      clearSuperuserPassword();
      return;
    }
    setSuPrompt(true);
    setSuPwInput('');
    setSuError('');
  };

  const handleSuperuserSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!suPwInput) { setSuError('Password required'); return; }
    const opts: Record<string, unknown> = { password: suPwInput };
    if (hostId) opts.host = hostId;
    request('superuser.verify', opts)
      .then((results) => {
        const res = results[0] as { ok?: boolean; error?: string } | undefined;
        if (res?.ok) {
          setSuActive(true);
          setSuPassword(suPwInput);
          sessionStorage.setItem('su_active', '1');
          saveSuperuserPassword(suPwInput);
          setSuPrompt(false);
          setSuError('');
        } else {
          setSuError(res?.error || 'Authentication failed');
        }
      })
      .catch(() => setSuError('Verification request failed'));
  };

  const closeSuPrompt = () => setSuPrompt(false);

  const clearSuperuser = () => {
    setSuActive(false);
    setSuPassword('');
    sessionStorage.removeItem('su_active');
    clearSuperuserPassword();
  };

  return {
    suActive, suPassword,
    suPrompt, suPwInput, suError,
    setSuPwInput,
    handleSuperuserClick,
    handleSuperuserSubmit,
    closeSuPrompt,
    clearSuperuser,
  };
}
