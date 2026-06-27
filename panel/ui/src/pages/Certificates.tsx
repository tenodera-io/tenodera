import { useEffect, useState, useCallback } from 'react';
import { useTransport } from '../api/HostTransportContext.tsx';
import { useSuperuser } from '../api/SuperuserContext.tsx';

export function Certificates() {
  const { request } = useTransport();
  const su = useSuperuser();
  const [tab, setTab] = useState<'certs' | 'trust' | 'letsencrypt' | 'selfsigned'>('certs');

  return (
    <div style={S.page}>
      <h2 style={S.title}>Certificates</h2>
      <div style={S.tabBar}>
        {([
          ['certs',       'Certificates'],
          ['trust',       'Trust Store'],
          ['letsencrypt', "Let's Encrypt"],
          ['selfsigned',  'Self-Signed'],
        ] as [typeof tab, string][]).map(([id, label]) => (
          <button
            key={id}
            style={tab === id ? { ...S.tab, ...S.tabActive } : S.tab}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'certs'        && <CertsTab su={su} request={request} />}
      {tab === 'trust'        && <TrustStoreTab su={su} request={request} />}
      {tab === 'letsencrypt'  && <LetsEncryptTab su={su} request={request} />}
      {tab === 'selfsigned'   && <SelfSignedTab su={su} request={request} />}
    </div>
  );
}

// ── types ──────────────────────────────────────────────────────────────────────

interface CertEntry {
  path: string; filename: string; cn: string;
  issuer_cn: string; issuer_org: string;
  not_before: string; not_after: string;
  days_remaining: number; sans: string[];
  is_ca: boolean; source: string;
}

interface LECert {
  name: string; domains: string; expiry: string;
  days_remaining: number; cert_path: string; key_path: string;
}

// ── Certificates tab ───────────────────────────────────────────────────────────

interface CheckedCert extends CertEntry {
  // cert info returned from cert_check, same shape as CertEntry
}

function CertsTab({ su, request }: TabProps) {
  const [certs, setCerts] = useState<CertEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<CertEntry | null>(null);
  const [msg, setMsg] = useState('');

  // Import form
  const [showImport, setShowImport] = useState(false);
  const [importName, setImportName] = useState('');
  const [importCert, setImportCert] = useState('');
  const [importKey, setImportKey]   = useState('');
  const [checking, setChecking]     = useState(false);
  const [checkErr, setCheckErr]     = useState('');
  const [checked, setChecked]       = useState<CheckedCert | null>(null);
  const [saving, setSaving]         = useState(false);

  // Password prompt
  const [pw, setPw]         = useState('');
  const [pwPending, setPwPending] = useState(false);
  const [pwTarget, setPwTarget]   = useState<'remove' | 'save' | null>(null);
  const [pwExtra, setPwExtra]     = useState<object>({});

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 6000); };

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [data] = await request('certs.list', {});
      setCerts((data as { certs: CertEntry[] }).certs ?? []);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [request]);

  useEffect(() => { reload(); }, [reload]);

  // ── trust remove ──────────────────────────────────────────────────────────────

  const execRemove = async (path: string, password: string) => {
    try {
      const [r] = await request('certs.manage', { action: 'trust_remove', path, password });
      const res = r as { ok?: boolean; error?: string };
      if (res?.ok) { flash('✓ Removed'); reload(); }
      else flash(res?.error ?? 'Failed');
    } catch (e) { flash(String(e)); }
  };

  const handleRemove = (path: string) => {
    if (su.active) { execRemove(path, su.password); return; }
    setPwTarget('remove'); setPwExtra({ path }); setPwPending(true); setPw('');
  };

  // ── import: check ─────────────────────────────────────────────────────────────

  const handleCheck = async () => {
    if (!importCert.trim() || !importKey.trim()) return;
    setChecking(true); setCheckErr(''); setChecked(null);
    try {
      const [r] = await request('certs.manage', {
        action: 'cert_check', cert: importCert.trim(), key: importKey.trim(),
      });
      const res = r as { ok?: boolean; cert?: CheckedCert; error?: string };
      if (res.ok && res.cert) {
        setChecked(res.cert);
        if (!importName) setImportName(res.cert.cn.replace(/[^a-z0-9._-]/gi, '_') || 'imported');
      } else {
        setCheckErr(res.error ?? 'Verification failed');
      }
    } catch (e) { setCheckErr(String(e)); }
    finally { setChecking(false); }
  };

  // ── import: save ──────────────────────────────────────────────────────────────

  const execSave = async (password: string) => {
    setSaving(true);
    try {
      const [r] = await request('certs.manage', {
        action: 'cert_save',
        name: importName.trim(),
        cert: importCert.trim(),
        key: importKey.trim(),
        password,
      });
      const res = r as { ok?: boolean; cert_path?: string; key_path?: string; error?: string };
      if (res.ok) {
        flash(`✓ Saved: ${res.cert_path}  +  ${res.key_path}`);
        setShowImport(false); setImportName(''); setImportCert(''); setImportKey('');
        setChecked(null); setCheckErr('');
        reload();
      } else {
        flash(res.error ?? 'Save failed');
      }
    } catch (e) { flash(String(e)); }
    finally { setSaving(false); }
  };

  const handleSave = () => {
    if (!importName.trim()) return;
    if (su.active) { execSave(su.password); return; }
    setPwTarget('save'); setPwExtra({}); setPwPending(true); setPw('');
  };

  // ── password confirm ──────────────────────────────────────────────────────────

  const confirmPw = () => {
    if (!pw || !pwTarget) return;
    const target = pwTarget;
    const extra  = pwExtra as { path?: string };
    setPwPending(false); setPwTarget(null); setPwExtra({}); setPw('');
    if (target === 'remove') execRemove(extra.path ?? '', pw);
    if (target === 'save')   execSave(pw);
  };

  const resetImport = () => {
    setShowImport(false); setImportName(''); setImportCert('');
    setImportKey(''); setChecked(null); setCheckErr('');
  };

  return (
    <div style={S.section}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <button style={S.btn} onClick={reload}>↺ Refresh</button>
        <button style={S.btnAccent} onClick={() => { setShowImport(v => !v); setChecked(null); setCheckErr(''); }}>
          {showImport ? '✕ Cancel import' : '+ Import Certificate'}
        </button>
        {msg && <span style={{ fontSize: '0.82rem', color: msg.startsWith('✓') ? '#9ece6a' : '#f7768e' }}>{msg}</span>}
      </div>

      {/* Import form */}
      {showImport && (
        <div style={S.card}>
          <div style={S.cardTitle}>Import certificate & key</div>

          <div style={{ marginBottom: '0.6rem' }}>
            <label style={S.fieldLabel}>Certificate name</label>
            <input
              style={{ ...S.input, width: '100%', boxSizing: 'border-box' }}
              placeholder="e.g. moja_domena.pl"
              value={importName}
              onChange={e => setImportName(e.target.value)}
              spellCheck={false}
            />
            <span style={S.hint}>Files will be saved as <code>/etc/ssl/&lt;name&gt;.crt</code> and <code>/etc/ssl/private/&lt;name&gt;.key</code></span>
          </div>

          <div style={{ marginBottom: '0.6rem' }}>
            <label style={S.fieldLabel}>Certificate chain (PEM)</label>
            <textarea
              style={{ ...S.textarea, height: 160 }}
              placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n\n# Paste full chain: leaf cert first, then intermediate CA(s)"}
              value={importCert}
              onChange={e => { setImportCert(e.target.value); setChecked(null); setCheckErr(''); }}
              spellCheck={false}
            />
          </div>

          <div style={{ marginBottom: '0.75rem' }}>
            <label style={S.fieldLabel}>Private key (PEM)</label>
            <textarea
              style={{ ...S.textarea, height: 130 }}
              placeholder={"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"}
              value={importKey}
              onChange={e => { setImportKey(e.target.value); setChecked(null); setCheckErr(''); }}
              spellCheck={false}
            />
          </div>

          <div style={S.btnRow}>
            <button
              style={S.btnAccent}
              disabled={checking || !importCert.trim() || !importKey.trim()}
              onClick={handleCheck}
            >
              {checking ? '⟳ Checking…' : '✓ Check / Verify'}
            </button>
            <button style={S.cancelBtn} onClick={resetImport}>Cancel</button>
          </div>

          {checkErr && (
            <p style={{ color: '#f7768e', fontSize: '0.85rem', marginTop: '0.6rem' }}>✗ {checkErr}</p>
          )}
        </div>
      )}

      {/* Check result — preview + save */}
      {checked && (
        <div style={{ ...S.card, borderColor: '#9ece6a44' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
            <span style={{ color: '#9ece6a', fontWeight: 700, fontSize: '0.9rem' }}>✓ Certificate and key match</span>
            <ExpiryBadge days={checked.days_remaining} />
            {checked.is_ca && <span style={{ ...S.badge, color: '#bb9af7', background: '#bb9af722' }}>CA</span>}
          </div>
          <div style={S.detailGrid}>
            <Detail label="Common Name" value={checked.cn || '—'} />
            <Detail label="Issuer CN"   value={checked.issuer_cn || '—'} />
            <Detail label="Issuer Org"  value={checked.issuer_org || '—'} />
            <Detail label="Valid from"  value={checked.not_before} mono />
            <Detail label="Valid until" value={checked.not_after}  mono />
            <Detail label="Days left"   value={String(checked.days_remaining)} />
          </div>
          {checked.sans.length > 0 && (
            <div style={{ marginTop: '0.5rem' }}>
              <div style={S.detailLabel}>Subject Alternative Names</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '0.25rem' }}>
                {checked.sans.map(s => <span key={s} style={S.sanChip}>{s}</span>)}
              </div>
            </div>
          )}
          <div style={{ ...S.btnRow, marginTop: '1rem', alignItems: 'center' }}>
            <button
              style={S.saveBtn}
              disabled={saving || !importName.trim()}
              onClick={handleSave}
            >
              {saving ? 'Saving…' : `Save to /etc/ssl/${importName.trim() || '…'}`}
            </button>
            <button style={S.cancelBtn} onClick={() => { setChecked(null); setCheckErr(''); }}>Back</button>
            {!importName.trim() && (
              <span style={{ fontSize: '0.8rem', color: '#e0af68' }}>Set a name first</span>
            )}
          </div>
        </div>
      )}

      {loading && <p style={S.muted}>Scanning certificates…</p>}
      {!loading && certs.length === 0 && <p style={S.muted}>No certificates found in standard paths.</p>}

      {certs.length > 0 && (
        <div style={S.card}>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Common Name</th>
                <th style={S.th}>Issuer</th>
                <th style={S.th}>Source</th>
                <th style={S.th}>Expires</th>
                <th style={S.th}>Days left</th>
                <th style={S.th}></th>
              </tr>
            </thead>
            <tbody>
              {certs.map(cert => (
                <tr key={cert.path} style={{ cursor: 'pointer' }} onClick={() => setSelected(cert === selected ? null : cert)}>
                  <td style={S.td}>
                    <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>{cert.cn}</div>
                    {cert.sans.length > 0 && (
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                        {cert.sans.slice(0, 3).join(', ')}{cert.sans.length > 3 ? ` +${cert.sans.length - 3}` : ''}
                      </div>
                    )}
                  </td>
                  <td style={S.td}>
                    <div style={{ fontSize: '0.85rem' }}>{cert.issuer_cn || '—'}</div>
                    {cert.issuer_org && <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{cert.issuer_org}</div>}
                  </td>
                  <td style={S.td}><SourceBadge source={cert.source} /></td>
                  <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.82rem' }}>{cert.not_after}</td>
                  <td style={S.td}><ExpiryBadge days={cert.days_remaining} /></td>
                  <td style={S.td}>
                    {cert.source === 'trusted' && (
                      <button
                        style={{ ...S.dangerBtn, fontSize: '0.75rem' }}
                        onClick={e => { e.stopPropagation(); handleRemove(cert.path); }}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail panel */}
      {selected && (
        <div style={S.card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
            <div style={S.cardTitle}>{selected.cn}</div>
            <ExpiryBadge days={selected.days_remaining} />
          </div>
          <div style={S.detailGrid}>
            <Detail label="Path"          value={selected.path} mono />
            <Detail label="Common Name"   value={selected.cn} />
            <Detail label="Issuer CN"     value={selected.issuer_cn || '—'} />
            <Detail label="Issuer Org"    value={selected.issuer_org || '—'} />
            <Detail label="Not Before"    value={selected.not_before} mono />
            <Detail label="Not After"     value={selected.not_after} mono />
            <Detail label="Days remaining" value={String(selected.days_remaining)} />
            <Detail label="CA cert"       value={selected.is_ca ? 'Yes' : 'No'} />
          </div>
          {selected.sans.length > 0 && (
            <div style={{ marginTop: '0.5rem' }}>
              <div style={S.detailLabel}>Subject Alternative Names</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '0.25rem' }}>
                {selected.sans.map(s => <span key={s} style={S.sanChip}>{s}</span>)}
              </div>
            </div>
          )}
          <button style={{ ...S.cancelBtn, marginTop: '0.75rem' }} onClick={() => setSelected(null)}>Close</button>
        </div>
      )}

      {/* Password prompt */}
      {pwPending && (
        <div style={S.pwBar}>
          <span style={S.muted}>
            {pwTarget === 'save' ? 'Hasło sudo do zapisu pliku:' : 'Hasło sudo:'}
          </span>
          <input type="password" value={pw} onChange={e => setPw(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') confirmPw(); if (e.key === 'Escape') { setPwPending(false); setPw(''); } }}
            autoFocus style={S.pwInput} placeholder="sudo password…" />
          <button style={S.saveBtn} onClick={confirmPw} disabled={!pw}>Confirm</button>
          <button style={S.cancelBtn} onClick={() => { setPwPending(false); setPw(''); }}>Cancel</button>
        </div>
      )}
    </div>
  );
}

// ── Trust Store tab ────────────────────────────────────────────────────────────

interface ParsedCert {
  cn: string; issuer_cn: string; issuer_org: string;
  not_before: string; not_after: string; days_remaining: number;
  sans: string[]; is_ca: boolean; pem: string;
}

function TrustStoreTab({ su, request }: TabProps) {
  const [rawInput, setRawInput]   = useState('');
  const [certName, setCertName]   = useState('');
  const [parsed, setParsed]       = useState<ParsedCert | null>(null);
  const [parseErr, setParseErr]   = useState('');
  const [parsing, setParsing]     = useState(false);
  const [msg, setMsg]             = useState('');
  const [pw, setPw]               = useState('');
  const [pwAction, setPwAction]   = useState<null | string>(null);

  // Verify section
  const [verifyHost, setVerifyHost] = useState('');
  const [verifying, setVerifying]   = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; trusted: boolean; output: string; host: string } | null>(null);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 6000); };

  const handleParse = async () => {
    if (!rawInput.trim()) return;
    setParsing(true); setParsed(null); setParseErr('');
    try {
      const [r] = await request('certs.manage', { action: 'parse', pem: rawInput.trim() });
      const res = r as { ok?: boolean; cert?: ParsedCert; error?: string };
      if (res.ok && res.cert) {
        setParsed(res.cert);
        if (!certName) setCertName(res.cert.cn.replace(/[^a-z0-9._-]/gi, '_') || 'imported');
      } else {
        setParseErr(res.error ?? 'Parse failed');
      }
    } catch (e) { setParseErr(String(e)); }
    finally { setParsing(false); }
  };

  const execTrust = async (password: string) => {
    if (!parsed) return;
    try {
      const [r] = await request('certs.manage', {
        action: 'trust_add', pem: parsed.pem,
        name: certName || 'imported', password,
      });
      const res = r as { ok?: boolean; error?: string; output?: string };
      if (res.ok) { flash('✓ Certificate added to trust store'); setParsed(null); setRawInput(''); setCertName(''); }
      else flash(res.error ?? 'Failed');
    } catch (e) { flash(String(e)); }
  };

  const handleTrust = () => {
    if (su.active) { execTrust(su.password); return; }
    setPwAction('trust'); setPw('');
  };

  const confirmPw = () => {
    if (!pw || !pwAction) return;
    setPwAction(null); setPw('');
    execTrust(pw);
  };

  const handleVerify = async () => {
    if (!verifyHost.trim()) return;
    setVerifying(true); setVerifyResult(null);
    try {
      const [r] = await request('certs.manage', { action: 'verify_host', host: verifyHost.trim() });
      setVerifyResult(r as typeof verifyResult);
    } catch (e) { flash(String(e)); }
    finally { setVerifying(false); }
  };

  return (
    <div style={S.section}>
      {/* Import & trust */}
      <div style={S.card}>
        <div style={S.cardTitle}>Import certificate</div>
        <p style={S.hint}>
          Wklej certyfikat w formacie PEM (<code>-----BEGIN CERTIFICATE-----</code>) lub base64-encoded DER.
          Obsługiwane: certyfikaty CA, certyfikaty firmowe, self-signed.
        </p>

        <textarea
          style={{ ...S.textarea, height: 140 }}
          placeholder={"-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----"}
          value={rawInput}
          onChange={e => { setRawInput(e.target.value); setParsed(null); setParseErr(''); }}
          spellCheck={false}
        />

        <div style={S.btnRow}>
          <button style={S.btnAccent} onClick={handleParse} disabled={parsing || !rawInput.trim()}>
            {parsing ? 'Parsing…' : 'Parse & Preview'}
          </button>
          {rawInput && <button style={S.cancelBtn} onClick={() => { setRawInput(''); setParsed(null); setParseErr(''); }}>Clear</button>}
        </div>

        {parseErr && <p style={{ color: '#f7768e', fontSize: '0.85rem', marginTop: '0.5rem' }}>{parseErr}</p>}
      </div>

      {/* Preview & confirm */}
      {parsed && (
        <div style={S.card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
            <div style={S.cardTitle}>Certificate preview</div>
            <ExpiryBadge days={parsed.days_remaining} />
            {parsed.is_ca && <span style={{ ...S.badge, color: '#bb9af7', background: '#bb9af722' }}>CA</span>}
          </div>

          <div style={S.detailGrid}>
            <Detail label="Common Name"  value={parsed.cn || '—'} />
            <Detail label="Issuer CN"    value={parsed.issuer_cn || '—'} />
            <Detail label="Issuer Org"   value={parsed.issuer_org || '—'} />
            <Detail label="Valid from"   value={parsed.not_before} mono />
            <Detail label="Valid until"  value={parsed.not_after}  mono />
            <Detail label="Days left"    value={String(parsed.days_remaining)} />
          </div>

          {parsed.sans.length > 0 && (
            <div style={{ marginTop: '0.5rem' }}>
              <div style={S.detailLabel}>Subject Alternative Names</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '0.25rem' }}>
                {parsed.sans.map(s => <span key={s} style={S.sanChip}>{s}</span>)}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '1rem', flexWrap: 'wrap' }}>
            <input
              style={{ ...S.input, width: 220 }}
              placeholder="Nazwa w trust store"
              value={certName}
              onChange={e => setCertName(e.target.value)}
              spellCheck={false}
            />
            <button style={S.saveBtn} onClick={handleTrust} disabled={!certName.trim()}>
              Dodaj do trust store
            </button>
            <span style={S.hint}>
              {/* distro hint shown inline */}
              Debian: <code>/usr/local/share/ca-certificates/</code> &nbsp;·&nbsp;
              Fedora: <code>/etc/pki/ca-trust/source/anchors/</code> &nbsp;·&nbsp;
              Arch: <code>trust anchor --store</code>
            </span>
          </div>

          {msg && <p style={{ color: msg.startsWith('✓') ? '#9ece6a' : '#f7768e', fontSize: '0.85rem', marginTop: '0.5rem' }}>{msg}</p>}
        </div>
      )}

      {msg && !parsed && <p style={{ color: msg.startsWith('✓') ? '#9ece6a' : '#f7768e', fontSize: '0.85rem' }}>{msg}</p>}

      {/* Verify trust */}
      <div style={S.card}>
        <div style={S.cardTitle}>Weryfikacja zaufania</div>
        <p style={S.hint}>
          Sprawdź czy certyfikat hosta jest uznawany przez system jako zaufany (openssl s_client).
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            style={{ ...S.input, flex: 1, minWidth: 200, fontFamily: 'monospace' }}
            placeholder="example.com lub example.com:8443"
            value={verifyHost}
            onChange={e => setVerifyHost(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleVerify()}
            spellCheck={false}
          />
          <button style={S.btnAccent} onClick={handleVerify} disabled={verifying || !verifyHost.trim()}>
            {verifying ? 'Sprawdzam…' : 'Test'}
          </button>
        </div>

        {verifyResult && (
          <div style={{ marginTop: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <span style={{
                ...S.badge,
                color: verifyResult.trusted ? '#9ece6a' : '#f7768e',
                background: (verifyResult.trusted ? '#9ece6a' : '#f7768e') + '22',
              }}>
                {verifyResult.trusted ? '✓ Zaufany' : '✗ Niezaufany / błąd'}
              </span>
              <span style={S.muted}>{verifyResult.host}</span>
            </div>
            <pre style={{ ...S.codeBlock, maxHeight: 200 }}>{verifyResult.output}</pre>
          </div>
        )}
      </div>

      {/* Password prompt */}
      {pwAction && (
        <div style={S.pwBar}>
          <span style={S.muted}>Wymagane hasło sudo:</span>
          <input type="password" value={pw} onChange={e => setPw(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') confirmPw(); if (e.key === 'Escape') { setPwAction(null); setPw(''); } }}
            autoFocus style={S.pwInput} placeholder="sudo password…" />
          <button style={S.saveBtn} onClick={confirmPw} disabled={!pw}>Confirm</button>
          <button style={S.cancelBtn} onClick={() => { setPwAction(null); setPw(''); }}>Cancel</button>
        </div>
      )}
    </div>
  );
}

// ── Let's Encrypt tab ──────────────────────────────────────────────────────────

function LetsEncryptTab({ su, request }: TabProps) {
  const [info, setInfo] = useState<{ available: boolean; install_hint?: string; version?: string; certs: LECert[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [pw, setPw] = useState('');
  const [pwAction, setPwAction] = useState<null | { action: string; name?: string }>(null);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 6000); };

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [data] = await request('certs.letsencrypt', {});
      setInfo(data as typeof info);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [request]);

  useEffect(() => { reload(); }, [reload]);

  const execAction = async (action: string, password: string, name?: string) => {
    try {
      const [r] = await request('certs.letsencrypt', { action, password, name });
      const res = r as { ok?: boolean; error?: string; output?: string };
      if (res?.ok) { flash(`✓ ${res.output?.split('\n').find(l => l.includes('Congratulations') || l.includes('success') || l.includes('renewed')) ?? 'Done'}`); reload(); }
      else flash(res?.error ?? 'Failed');
    } catch (e) { flash(String(e)); }
  };

  const handleAction = (action: string, name?: string) => {
    if (su.active) { execAction(action, su.password, name); return; }
    setPwAction({ action, name }); setPw('');
  };

  const confirmPw = () => {
    if (!pw || !pwAction) return;
    const { action, name } = pwAction;
    setPwAction(null); setPw('');
    execAction(action, pw, name);
  };

  if (loading) return <p style={S.muted}>Loading…</p>;

  if (!info?.available) {
    return (
      <div style={S.section}>
        <div style={S.card}>
          <div style={S.cardTitle}>certbot not installed</div>
          <p style={S.hint}>certbot is required to manage Let's Encrypt certificates.</p>
          {info?.install_hint && (
            <pre style={S.codeBlock}>{info.install_hint}</pre>
          )}
          <p style={{ ...S.hint, marginTop: '0.5rem' }}>After installing certbot, refresh this tab.</p>
          <button style={S.btn} onClick={reload}>↺ Refresh</button>
        </div>
      </div>
    );
  }

  return (
    <div style={S.section}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <button style={S.btn} onClick={reload}>↺ Refresh</button>
        <button style={S.btnAccent} onClick={() => handleAction('renew_all')}>↺ Renew all</button>
        {info.version && <span style={S.versionBadge}>{info.version}</span>}
        {msg && <span style={{ fontSize: '0.82rem', color: msg.startsWith('✓') ? '#9ece6a' : '#f7768e' }}>{msg}</span>}
      </div>

      {info.certs.length === 0 ? (
        <div style={S.card}>
          <p style={S.hint}>No managed certificates found. Use certbot on the command line to obtain certificates.</p>
          <pre style={S.codeBlock}>sudo certbot certonly --standalone -d example.com</pre>
        </div>
      ) : (
        <div style={S.card}>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Name</th>
                <th style={S.th}>Domains</th>
                <th style={S.th}>Expires</th>
                <th style={S.th}>Days left</th>
                <th style={S.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {info.certs.map(cert => (
                <tr key={cert.name}>
                  <td style={{ ...S.td, fontWeight: 600, fontFamily: 'monospace', fontSize: '0.88rem' }}>{cert.name}</td>
                  <td style={{ ...S.td, fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{cert.domains}</td>
                  <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.82rem' }}>{cert.expiry}</td>
                  <td style={S.td}><ExpiryBadge days={cert.days_remaining} /></td>
                  <td style={S.td}>
                    <div style={{ display: 'flex', gap: '0.35rem' }}>
                      <button style={S.actionBtn} onClick={() => handleAction('renew', cert.name)}>Renew</button>
                      <button style={S.dangerBtn} onClick={() => handleAction('delete', cert.name)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pwAction && (
        <div style={S.pwBar}>
          <span style={S.muted}>Password required for <b>{pwAction.action}{pwAction.name ? ` ${pwAction.name}` : ''}</b>:</span>
          <input type="password" value={pw} onChange={e => setPw(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') confirmPw(); if (e.key === 'Escape') { setPwAction(null); setPw(''); } }}
            autoFocus style={S.pwInput} placeholder="sudo password…" />
          <button style={S.saveBtn} onClick={confirmPw} disabled={!pw}>Confirm</button>
          <button style={S.cancelBtn} onClick={() => { setPwAction(null); setPw(''); }}>Cancel</button>
        </div>
      )}
    </div>
  );
}

// ── Self-Signed tab ────────────────────────────────────────────────────────────

const DEFAULT_FORM = { cn: '', org: '', country: '', san: '', days: '365', key_size: '2048' };

function SelfSignedTab({ su, request }: TabProps) {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [result, setResult] = useState<{ cert: string; key: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [trustAfter, setTrustAfter] = useState(false);
  const [trustName, setTrustName] = useState('');
  const [pw, setPw] = useState('');
  const [needPw, setNeedPw] = useState(false);
  const [msg, setMsg] = useState('');

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 6000); };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const generate = async (password?: string) => {
    if (!form.cn.trim()) { setError('Common Name is required'); return; }
    setLoading(true); setError(''); setResult(null);
    try {
      const [r] = await request('certs.selfsigned', {
        cn: form.cn.trim(), org: form.org.trim(), country: form.country.trim(),
        san: form.san.trim(), days: parseInt(form.days), key_size: parseInt(form.key_size),
      });
      const res = r as { ok?: boolean; cert?: string; key?: string; error?: string };
      if (res.ok && res.cert && res.key) {
        setResult({ cert: res.cert, key: res.key });
        if (trustAfter && password) {
          await addTrust(res.cert, password);
        }
      } else {
        setError(res.error ?? 'Generation failed');
      }
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  };

  const addTrust = async (pem: string, password: string) => {
    const name = trustName || form.cn.replace(/[^a-z0-9._-]/gi, '_');
    try {
      const [r] = await request('certs.manage', { action: 'trust_add', pem, name, password });
      const res = r as { ok?: boolean; error?: string };
      if (res?.ok) flash('✓ Added to trust store');
      else flash(res?.error ?? 'Trust add failed');
    } catch (e) { flash(String(e)); }
  };

  const handleGenerate = () => {
    if (trustAfter && !su.active) { setNeedPw(true); return; }
    generate(su.active ? su.password : undefined);
  };

  const confirmPw = () => {
    setNeedPw(false);
    generate(pw);
    setPw('');
  };

  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => flash('✓ Copied'));

  return (
    <div style={S.section}>
      <div style={S.card}>
        <div style={S.cardTitle}>Generate self-signed certificate</div>

        <div style={S.confGrid}>
          <ConfField label="Common Name *" hint="hostname or domain">
            <input style={S.confInput} value={form.cn} onChange={set('cn')} placeholder="example.com" spellCheck={false} />
          </ConfField>
          <ConfField label="Organization" hint="optional">
            <input style={S.confInput} value={form.org} onChange={set('org')} placeholder="My Org" spellCheck={false} />
          </ConfField>
          <ConfField label="Country" hint="2-letter code">
            <input style={S.confInput} value={form.country} onChange={set('country')} placeholder="PL" maxLength={2} spellCheck={false} />
          </ConfField>
          <ConfField label="Valid days">
            <select style={S.confSelect} value={form.days} onChange={set('days')}>
              {['90', '180', '365', '730', '3650'].map(d => <option key={d} value={d}>{d} days</option>)}
            </select>
          </ConfField>
          <ConfField label="Key size">
            <select style={S.confSelect} value={form.key_size} onChange={set('key_size')}>
              {['2048', '4096'].map(k => <option key={k} value={k}>RSA {k}</option>)}
            </select>
          </ConfField>
        </div>

        <ConfField label="Subject Alternative Names" hint="space or comma-separated — DNS names or IP addresses">
          <textarea
            style={{ ...S.confInput, height: 60, resize: 'vertical', fontFamily: 'monospace' }}
            value={form.san} onChange={set('san')}
            placeholder="www.example.com 192.168.1.1"
            spellCheck={false}
          />
        </ConfField>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={trustAfter} onChange={e => setTrustAfter(e.target.checked)} />
            Add to system trust store after generation
          </label>
          {trustAfter && (
            <input
              style={{ ...S.confInput, width: 200 }}
              placeholder="Trust store name (optional)"
              value={trustName} onChange={e => setTrustName(e.target.value)}
              spellCheck={false}
            />
          )}
        </div>

        {error && <p style={{ color: '#f7768e', fontSize: '0.85rem', marginTop: '0.5rem' }}>{error}</p>}
        {msg && <p style={{ color: msg.startsWith('✓') ? '#9ece6a' : '#f7768e', fontSize: '0.85rem', marginTop: '0.5rem' }}>{msg}</p>}

        <div style={S.btnRow}>
          <button style={S.saveBtn} onClick={handleGenerate} disabled={loading || !form.cn.trim()}>
            {loading ? 'Generating…' : 'Generate'}
          </button>
          <button style={S.cancelBtn} onClick={() => { setForm(DEFAULT_FORM); setResult(null); setError(''); }}>Reset</button>
        </div>
      </div>

      {result && (
        <>
          <div style={S.card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
              <div style={S.cardTitle}>Certificate (PEM)</div>
              <button style={S.btn} onClick={() => copy(result.cert)}>Copy</button>
            </div>
            <pre style={S.codeBlock}>{result.cert}</pre>
          </div>
          <div style={S.card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
              <div style={S.cardTitle}>Private Key (PEM)</div>
              <button style={S.btn} onClick={() => copy(result.key)}>Copy</button>
              <span style={{ fontSize: '0.75rem', color: '#e0af68' }}>Keep this secret — never share</span>
            </div>
            <pre style={S.codeBlock}>{result.key}</pre>
          </div>
        </>
      )}

      {needPw && (
        <div style={S.pwBar}>
          <span style={S.muted}>Password required for trust store:</span>
          <input type="password" value={pw} onChange={e => setPw(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') confirmPw(); if (e.key === 'Escape') { setNeedPw(false); setPw(''); } }}
            autoFocus style={S.pwInput} placeholder="sudo password…" />
          <button style={S.saveBtn} onClick={confirmPw} disabled={!pw}>Confirm</button>
          <button style={S.cancelBtn} onClick={() => { setNeedPw(false); setPw(''); }}>Cancel</button>
        </div>
      )}
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────────

type TabProps = {
  su: ReturnType<typeof useSuperuser>;
  request: ReturnType<typeof useTransport>['request'];
};

function ExpiryBadge({ days }: { days: number }) {
  const color = days < 0 ? '#f7768e' : days < 30 ? '#f7768e' : days < 90 ? '#e0af68' : '#9ece6a';
  const label = days < 0 ? 'EXPIRED' : `${days}d`;
  return <span style={{ ...S.badge, color, background: color + '22' }}>{label}</span>;
}

function SourceBadge({ source }: { source: string }) {
  const colors: Record<string, string> = {
    letsencrypt: '#9ece6a', trusted: '#7aa2f7',
    nginx: '#e0af68', apache: '#e0af68', private: '#bb9af7',
  };
  const color = colors[source] ?? '#565f89';
  return <span style={{ ...S.badge, color, background: color + '22', fontSize: '0.75rem' }}>{source}</span>;
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={S.detailLabel}>{label}</div>
      <div style={{ fontSize: '0.85rem', fontFamily: mono ? 'monospace' : undefined, wordBreak: 'break-all' }}>{value}</div>
    </div>
  );
}

function ConfField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
      <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
        {label}
      </label>
      {children}
      {hint && <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{hint}</span>}
    </div>
  );
}

// ── styles ─────────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  page: { padding: '1.5rem', maxWidth: 1100, margin: '0 auto' },
  title: { marginTop: 0, marginBottom: '1rem', fontSize: '1.4rem' },
  tabBar: { display: 'flex', gap: '0.25rem', borderBottom: '1px solid var(--border)', marginBottom: '1.5rem' },
  tab: {
    background: 'transparent', border: 'none', color: 'var(--text-secondary)',
    padding: '0.5rem 1rem', cursor: 'pointer', fontSize: '0.9rem',
    borderBottom: '2px solid transparent', display: 'flex', alignItems: 'center',
    gap: '0.4rem', transition: 'color 0.15s',
  },
  tabActive: { color: 'var(--accent)', borderBottom: '2px solid var(--accent)' },
  section: { display: 'flex', flexDirection: 'column', gap: '1rem' },
  card: { background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '1rem' },
  cardTitle: { fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.5rem' },
  hint: { fontSize: '0.83rem', color: 'var(--text-secondary)', margin: '0 0 0.5rem' },
  muted: { color: 'var(--text-secondary)', fontSize: '0.85rem' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { textAlign: 'left', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.03em', padding: '0.3rem 0.6rem', borderBottom: '1px solid var(--border)' },
  td: { padding: '0.45rem 0.6rem', borderBottom: '1px solid var(--border)', fontSize: '0.88rem' },
  badge: { display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: '0.78rem', fontWeight: 600 },
  btn: { padding: '0.3rem 0.8rem', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.83rem' },
  btnAccent: { padding: '0.3rem 0.8rem', borderRadius: 5, border: '1px solid #7aa2f766', background: '#7aa2f722', color: '#7aa2f7', cursor: 'pointer', fontSize: '0.83rem' },
  actionBtn: { padding: '0.2rem 0.6rem', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: '#7aa2f7', cursor: 'pointer', fontSize: '0.78rem' },
  dangerBtn: { padding: '0.2rem 0.6rem', borderRadius: 4, border: '1px solid #f7768e44', background: 'transparent', color: '#f7768e', cursor: 'pointer', fontSize: '0.78rem' },
  saveBtn: { padding: '0.35rem 0.9rem', borderRadius: 5, border: '1px solid #9ece6a66', background: '#9ece6a22', color: '#9ece6a', cursor: 'pointer', fontSize: '0.85rem' },
  cancelBtn: { padding: '0.35rem 0.9rem', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.85rem' },
  btnRow: { display: 'flex', gap: '0.5rem', marginTop: '0.75rem' },
  textarea: { width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: '0.85rem', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text-primary)', padding: '0.75rem', resize: 'vertical', outline: 'none', lineHeight: 1.5 },
  input: { padding: '0.35rem 0.55rem', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.85rem', outline: 'none' },
  codeBlock: { margin: 0, fontFamily: 'monospace', fontSize: '0.82rem', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 5, padding: '0.75rem', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--text-primary)', maxHeight: 300, overflow: 'auto' },
  pwBar: { display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.75rem 1rem' },
  pwInput: { padding: '0.3rem 0.5rem', borderRadius: 4, border: '1px solid #7aa2f766', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.85rem', width: 200, outline: 'none' },
  detailGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '0.75rem' },
  detailLabel: { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: '0.15rem' },
  sanChip: { fontFamily: 'monospace', fontSize: '0.8rem', background: '#7aa2f722', color: '#7aa2f7', border: '1px solid #7aa2f733', borderRadius: 4, padding: '0.15rem 0.5rem' },
  versionBadge: { fontSize: '0.75rem', color: 'var(--text-secondary)', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.15rem 0.5rem' },
  fieldLabel: { display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '0.03em', marginBottom: '0.3rem' },
  confGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.75rem', marginBottom: '0.75rem' },
  confInput: { padding: '0.35rem 0.55rem', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.85rem', outline: 'none', width: '100%', boxSizing: 'border-box' },
  confSelect: { padding: '0.35rem 0.55rem', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.85rem', cursor: 'pointer', width: '100%', boxSizing: 'border-box' },
};
