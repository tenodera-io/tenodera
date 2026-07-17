import { useEffect, useState, useCallback } from 'react';
import { PageHeader } from '../components/PageHeader.tsx';
import { Tabs } from '../components/Tabs.tsx';
import { useTabParam } from '../hooks/useTabParam.ts';
import { useTransport } from '../api/HostTransportContext.tsx';
import { useSuperuser } from '../api/SuperuserContext.tsx';
import { useToast } from '../contexts/ToastContext.tsx';
import { SystemChrony } from './SystemChrony.tsx';
import { SystemTimeSync } from './SystemTimeSync.tsx';

// Time-sync daemons with a management tab. chrony uses the richer SystemChrony;
// the rest use the generic SystemTimeSync. Detection is done by the agent
// (system.settings → time.ntp_service).
const SYNC_DAEMONS = ['chrony', 'systemd-timesyncd', 'ntpd', 'ntpsec', 'openntpd', 'ptp4l', 'phc2sys'];

/* ── types ─────────────────────────────────────────────── */

interface Settings {
  time: {
    timezone: string;
    ntp: boolean;
    ntp_synced: boolean;
    can_ntp: boolean;
    local_rtc: boolean;
    local_time: string;
    utc_time: string;
    rtc_time: string;
    ntp_service: string;
    ntp_server: string;
    ntp_servers: string;
    ntp_fallback: string;
  };
  hostname: {
    static: string;
    transient: string;
    pretty: string;
    chassis: string;
    deployment: string;
    location: string;
    icon_name: string;
  };
  locale: { lang: string; keymap: string; x11_layout: string; x11_model: string; x11_variant: string };
  reboot_required: boolean;
  reboot_reason: string;
  options: {
    timezones: string[];
    locales: string[];
    keymaps: string[];
    x11_layouts: string[];
    chassis: string[];
    deployments: string[];
  };
}

type PowerAction = 'restart' | 'poweroff';

/* ── component ─────────────────────────────────────────── */

export function System() {
  const { request } = useTransport();
  const su = useSuperuser();
  const toast = useToast();

  const [s, setS] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Local edit state for the form fields.
  const [tz, setTz] = useState('');
  const [host, setHost] = useState('');
  const [pretty, setPretty] = useState('');
  const [chassis, setChassis] = useState('');
  const [deployment, setDeployment] = useState('');
  const [location, setLocation] = useState('');
  const [lang, setLang] = useState('');
  const [keymap, setKeymap] = useState('');
  const [x11Layout, setX11Layout] = useState('');
  const [x11Variant, setX11Variant] = useState('');
  const [manualTime, setManualTime] = useState('');
  const [ntpServers, setNtpServers] = useState('');
  const [ntpFallback, setNtpFallback] = useState('');

  // Power section.
  const [delay, setDelay] = useState('');
  const [scheduleAt, setScheduleAt] = useState('');
  const [confirming, setConfirming] = useState<PowerAction | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    request('system.settings')
      .then((results) => {
        const data = results[0] as Settings | undefined;
        if (data) {
          setS(data);
          setTz(data.time.timezone);
          setHost(data.hostname.static);
          setPretty(data.hostname.pretty);
          setChassis(data.hostname.chassis);
          setDeployment(data.hostname.deployment);
          setLocation(data.hostname.location);
          setLang(data.locale.lang);
          setKeymap(data.locale.keymap);
          setX11Layout(data.locale.x11_layout);
          setX11Variant(data.locale.x11_variant);
          setNtpServers(data.time.ntp_servers);
          setNtpFallback(data.time.ntp_fallback);
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [request]);

  useEffect(() => { load(); }, [load]);

  const runAction = useCallback(
    async (action: string, params: Record<string, unknown>, okMsg: string): Promise<boolean> => {
      setBusy(true);
      try {
        const [res] = await request('system.settings', { action, ...params, password: su.password });
        const data = res as { error?: string } | undefined;
        if (data?.error) throw new Error(data.error);
        toast.success(okMsg);
        load();
        return true;
      } catch (e) {
        toast.error(`Failed: ${e}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [request, su.password, toast, load],
  );

  // Minutes from now to fire the power action: an absolute date/time takes
  // precedence over the plain minute delay. shutdown(1) only accepts a relative
  // offset, so an absolute schedule is converted to minutes here.
  const powerDelayMins = useCallback((): number => {
    if (scheduleAt) {
      const target = new Date(scheduleAt).getTime();
      if (Number.isFinite(target)) {
        return Math.max(0, Math.ceil((target - Date.now()) / 60000));
      }
    }
    const mins = parseInt(delay, 10);
    return Number.isFinite(mins) && mins > 0 ? mins : 0;
  }, [scheduleAt, delay]);

  const runPower = useCallback(
    async (action: PowerAction) => {
      const delay_mins = powerDelayMins();
      setBusy(true);
      try {
        const [res] = await request('host.action', { action, delay_mins, password: su.password });
        const data = res as { error?: string; msg?: string } | undefined;
        if (data?.error) throw new Error(data.error);
        toast.warn(data?.msg || (action === 'restart' ? 'Reboot initiated.' : 'Shutdown initiated.'));
      } catch (e) {
        toast.error(`${action === 'restart' ? 'Reboot' : 'Shutdown'} failed: ${e}`);
      } finally {
        setBusy(false);
        setConfirming(null);
      }
    },
    [request, su.password, powerDelayMins, toast],
  );

  const cancelScheduled = useCallback(async () => {
    setBusy(true);
    try {
      const [res] = await request('host.action', { action: 'cancel_shutdown', password: su.password });
      const data = res as { error?: string; msg?: string } | undefined;
      if (data?.error) throw new Error(data.error);
      toast.success(data?.msg || 'Cancelled.');
    } catch (e) {
      toast.error(`Cancel failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }, [request, su.password, toast]);

  const gated = !su.active;

  const syncDaemon = s?.time.ntp_service ?? '';
  const isChrony = syncDaemon === 'chrony';
  // Whether this host's detected time-sync daemon has a management tab.
  const hasSyncTab = SYNC_DAEMONS.includes(syncDaemon);
  const [tab, setTab] = useTabParam<'settings' | 'timesync'>(['settings', 'timesync'], 'settings');
  const activeTab = tab === 'timesync' && hasSyncTab ? 'timesync' : 'settings';

  // If the URL asks for the time-sync tab but this host's daemon has no
  // management tab, clean the param so the sidebar and page agree on Settings.
  useEffect(() => {
    if (s && tab === 'timesync' && !hasSyncTab) setTab('settings');
  }, [s, tab, hasSyncTab, setTab]);

  return (
    <div style={S.page}>
      <PageHeader
        icon="system"
        title="System"
        actions={activeTab === 'settings' && <button onClick={load} style={S.btn} disabled={loading}>Refresh</button>}
      />

      {hasSyncTab && (
        <Tabs
          tabs={[{ id: 'settings', label: 'Settings' }, { id: 'timesync', label: 'Time sync' }]}
          active={activeTab}
          onChange={(t) => setTab(t as 'settings' | 'timesync')}
          style={{ marginBottom: '1rem' }}
        />
      )}

      {activeTab === 'timesync' && (isChrony ? <SystemChrony /> : <SystemTimeSync daemon={syncDaemon} />)}

      {activeTab === 'settings' && (<>
      {error && <p style={{ color: 'var(--c-red)' }}>Error: {error}</p>}

      {s?.reboot_required && (
        <div style={S.rebootBanner}>
          <span style={{ flex: 1 }}>
            <b>Reboot required.</b> {s.reboot_reason}
          </span>
          <button
            style={gated ? { ...S.btnWarn, ...S.btnDisabled } : S.btnWarn}
            disabled={gated}
            onClick={() => setConfirming('restart')}
          >
            Reboot now
          </button>
        </div>
      )}

      {gated && (
        <p style={S.notice}>
          Enable <b>superuser</b> mode (top bar) to change settings or power the host on/off.
        </p>
      )}

      <div style={S.columns}>
          {/* Clock & Timezone */}
          <div style={S.card}>
            <h3 style={S.cardTitle}>Clock &amp; Timezone</h3>
            <div style={S.clockGrid}>
              <Clock label="Local" value={s?.time.local_time || (loading ? '…' : '—')} />
              <Clock label="Universal (UTC)" value={s?.time.utc_time || '—'} />
              <Clock label="RTC (hardware)" value={s?.time.rtc_time || '—'} />
            </div>
            <div style={S.field}>
              <label style={S.label}>Timezone</label>
              <div style={S.controlRow}>
                <input
                  style={S.input}
                  list="tz-list"
                  value={tz}
                  onChange={(e) => setTz(e.target.value)}
                  disabled={gated}
                  placeholder="e.g. Europe/Warsaw"
                />
                <datalist id="tz-list">
                  {s?.options.timezones.map((t) => <option key={t} value={t} />)}
                </datalist>
                <button
                  style={saveStyle(gated || busy || tz === s?.time.timezone)}
                  disabled={gated || busy || tz === s?.time.timezone}
                  onClick={() => runAction('set_timezone', { timezone: tz }, `Timezone set to ${tz}.`)}
                >
                  Save
                </button>
              </div>
            </div>
          </div>

          {/* Time synchronization */}
          <div style={S.card}>
            <h3 style={S.cardTitle}>Time Synchronization</h3>
            <div style={S.field}>
              <label style={S.label}>
                Network time (NTP){s?.time.ntp_service ? ` — ${s.time.ntp_service}` : ''}
              </label>
              <div style={S.controlRow}>
                <span style={S.toggleState}>
                  {s?.time.ntp ? 'On' : 'Off'}
                  {s?.time.ntp && (
                    <span style={{ color: s.time.ntp_synced ? 'var(--c-green)' : 'var(--c-yellow)', marginLeft: 8 }}>
                      {s.time.ntp_synced ? '● synchronized' : '○ syncing…'}
                    </span>
                  )}
                  {s?.time.ntp && s.time.ntp_server && (
                    <span style={S.serverHint}> · {s.time.ntp_server}</span>
                  )}
                </span>
                <button
                  style={saveStyle(gated || busy)}
                  disabled={gated || busy}
                  onClick={() => runAction('set_ntp', { enabled: !s?.time.ntp }, `NTP turned ${s?.time.ntp ? 'off' : 'on'}.`)}
                >
                  {s?.time.ntp ? 'Turn off' : 'Turn on'}
                </button>
              </div>
            </div>

            {/* NTP servers — editable for systemd-timesyncd and chrony */}
            {(s?.time.ntp_service === 'systemd-timesyncd' || s?.time.ntp_service === 'chrony') ? (
              <>
                <div style={S.field}>
                  <label style={S.label}>NTP servers (space-separated)</label>
                  <div style={S.controlRow}>
                    <input
                      style={S.input}
                      value={ntpServers}
                      onChange={(e) => setNtpServers(e.target.value)}
                      disabled={gated}
                      placeholder="e.g. 0.pool.ntp.org 1.pool.ntp.org"
                    />
                    <button
                      style={saveStyle(gated || busy || (ntpServers === s?.time.ntp_servers && ntpFallback === s?.time.ntp_fallback))}
                      disabled={gated || busy || (ntpServers === s?.time.ntp_servers && ntpFallback === s?.time.ntp_fallback)}
                      onClick={() => runAction('set_ntp_servers', { servers: ntpServers, fallback: ntpFallback }, 'NTP servers updated.')}
                    >
                      Save
                    </button>
                  </div>
                  <span style={S.fieldHint}>
                    {s?.time.ntp_service === 'chrony'
                      ? 'Rewrites server/pool lines in chrony.conf and restarts chronyd.'
                      : 'Written to a systemd-timesyncd drop-in.'}
                  </span>
                </div>
                {s?.time.ntp_service === 'systemd-timesyncd' && (
                  <div style={S.field}>
                    <label style={S.label}>Fallback NTP servers (optional)</label>
                    <input
                      style={S.input}
                      value={ntpFallback}
                      onChange={(e) => setNtpFallback(e.target.value)}
                      disabled={gated}
                      placeholder="e.g. 2.pool.ntp.org"
                    />
                  </div>
                )}
              </>
            ) : s?.time.ntp_service ? (
              <div style={S.field}>
                <label style={S.label}>NTP servers</label>
                <div style={S.readonlyBox}>
                  {s.time.ntp_server || `Managed by ${s.time.ntp_service}`}
                  <span style={S.fieldHint}>Edit via {s.time.ntp_service} config on the host.</span>
                </div>
              </div>
            ) : null}

            {/* Manual time — only meaningful when NTP is off (timedatectl refuses otherwise) */}
            <div style={S.field}>
              <label style={S.label}>Set time manually</label>
              <div style={S.controlRow}>
                <input
                  style={S.input}
                  type="datetime-local"
                  step={1}
                  value={manualTime}
                  onChange={(e) => setManualTime(e.target.value)}
                  disabled={gated || s?.time.ntp}
                />
                <button
                  style={saveStyle(gated || busy || !!s?.time.ntp || !manualTime)}
                  disabled={gated || busy || !!s?.time.ntp || !manualTime}
                  onClick={() => runAction('set_time', { time: manualTime.replace('T', ' ') + (manualTime.length === 16 ? ':00' : '') }, 'Time updated.')}
                >
                  Set
                </button>
              </div>
              {s?.time.ntp && <span style={S.fieldHint}>Turn off NTP to set the time manually.</span>}
            </div>

            {/* RTC in local timezone (advanced) */}
            <div style={{ ...S.field, marginBottom: 0 }}>
              <label style={S.label}>Hardware clock (RTC) in local time</label>
              <div style={S.controlRow}>
                <span style={S.toggleState}>{s?.time.local_rtc ? 'Local time' : 'UTC (recommended)'}</span>
                <button
                  style={saveStyle(gated || busy)}
                  disabled={gated || busy}
                  onClick={() => runAction('set_local_rtc', { enabled: !s?.time.local_rtc }, `RTC set to ${s?.time.local_rtc ? 'UTC' : 'local time'}.`)}
                >
                  {s?.time.local_rtc ? 'Use UTC' : 'Use local'}
                </button>
              </div>
            </div>
          </div>

          {/* Hostname */}
          <div style={S.card}>
            <h3 style={S.cardTitle}>Hostname</h3>
            {s && s.hostname.transient && s.hostname.transient !== s.hostname.static && (
              <InfoRow label="Transient" value={s.hostname.transient} />
            )}
            <div style={S.field}>
              <label style={S.label}>Static hostname</label>
              <div style={S.controlRow}>
                <input
                  style={S.input}
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  disabled={gated}
                  placeholder="e.g. web-01"
                />
                <button
                  style={saveStyle(gated || busy || !host || host === s?.hostname.static)}
                  disabled={gated || busy || !host || host === s?.hostname.static}
                  onClick={() => runAction('set_hostname', { hostname: host }, `Hostname set to ${host}.`)}
                >
                  Save
                </button>
              </div>
            </div>
            <div style={S.field}>
              <label style={S.label}>Pretty hostname</label>
              <div style={S.controlRow}>
                <input
                  style={S.input}
                  value={pretty}
                  onChange={(e) => setPretty(e.target.value)}
                  disabled={gated}
                  placeholder="e.g. Kitchen Server"
                />
                <button
                  style={saveStyle(gated || busy || pretty === s?.hostname.pretty)}
                  disabled={gated || busy || pretty === s?.hostname.pretty}
                  onClick={() => runAction('set_pretty_hostname', { pretty }, 'Pretty hostname updated.')}
                >
                  Save
                </button>
              </div>
            </div>
            <div style={S.field}>
              <label style={S.label}>Chassis</label>
              <div style={S.controlRow}>
                <input
                  style={S.input}
                  list="chassis-list"
                  value={chassis}
                  onChange={(e) => setChassis(e.target.value)}
                  disabled={gated}
                  placeholder="e.g. server, vm, laptop"
                />
                <datalist id="chassis-list">
                  {s?.options.chassis.map((c) => <option key={c} value={c} />)}
                </datalist>
                <button
                  style={saveStyle(gated || busy || !chassis || chassis === s?.hostname.chassis)}
                  disabled={gated || busy || !chassis || chassis === s?.hostname.chassis}
                  onClick={() => runAction('set_chassis', { chassis }, `Chassis set to ${chassis}.`)}
                >
                  Save
                </button>
              </div>
            </div>
            <div style={S.field}>
              <label style={S.label}>Deployment</label>
              <div style={S.controlRow}>
                <input
                  style={S.input}
                  list="deploy-list"
                  value={deployment}
                  onChange={(e) => setDeployment(e.target.value)}
                  disabled={gated}
                  placeholder="e.g. production"
                />
                <datalist id="deploy-list">
                  {s?.options.deployments.map((d) => <option key={d} value={d} />)}
                </datalist>
                <button
                  style={saveStyle(gated || busy || deployment === s?.hostname.deployment)}
                  disabled={gated || busy || deployment === s?.hostname.deployment}
                  onClick={() => runAction('set_deployment', { deployment }, 'Deployment updated.')}
                >
                  Save
                </button>
              </div>
            </div>
            <div style={{ ...S.field, marginBottom: 0 }}>
              <label style={S.label}>Location</label>
              <div style={S.controlRow}>
                <input
                  style={S.input}
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  disabled={gated}
                  placeholder="e.g. Rack 4, Warsaw DC"
                />
                <button
                  style={saveStyle(gated || busy || location === s?.hostname.location)}
                  disabled={gated || busy || location === s?.hostname.location}
                  onClick={() => runAction('set_location', { location }, 'Location updated.')}
                >
                  Save
                </button>
              </div>
            </div>
          </div>

          {/* Locale & Keyboard */}
          <div style={S.card}>
            <h3 style={S.cardTitle}>Locale &amp; Keyboard</h3>
            <div style={S.field}>
              <label style={S.label}>System locale (LANG)</label>
              <div style={S.controlRow}>
                <input
                  style={S.input}
                  list="locale-list"
                  value={lang}
                  onChange={(e) => setLang(e.target.value)}
                  disabled={gated}
                  placeholder="e.g. en_US.UTF-8"
                />
                <datalist id="locale-list">
                  {s?.options.locales.map((l) => <option key={l} value={l} />)}
                </datalist>
                <button
                  style={saveStyle(gated || busy || !lang || lang === s?.locale.lang)}
                  disabled={gated || busy || !lang || lang === s?.locale.lang}
                  onClick={() => runAction('set_locale', { lang }, `Locale set to ${lang}.`)}
                >
                  Save
                </button>
              </div>
            </div>
            <div style={S.field}>
              <label style={S.label}>Console keymap (VC)</label>
              <div style={S.controlRow}>
                <input
                  style={S.input}
                  list="keymap-list"
                  value={keymap}
                  onChange={(e) => setKeymap(e.target.value)}
                  disabled={gated}
                  placeholder="e.g. pl, us"
                />
                <datalist id="keymap-list">
                  {s?.options.keymaps.map((k) => <option key={k} value={k} />)}
                </datalist>
                <button
                  style={saveStyle(gated || busy || !keymap || keymap === s?.locale.keymap)}
                  disabled={gated || busy || !keymap || keymap === s?.locale.keymap}
                  onClick={() => runAction('set_keymap', { keymap }, `Keymap set to ${keymap}.`)}
                >
                  Save
                </button>
              </div>
            </div>
            <div style={{ ...S.field, marginBottom: 0 }}>
              <label style={S.label}>X11 keyboard layout</label>
              <div style={S.controlRow}>
                <input
                  style={{ ...S.input, flexBasis: 120 }}
                  list="x11-list"
                  value={x11Layout}
                  onChange={(e) => setX11Layout(e.target.value)}
                  disabled={gated}
                  placeholder="layout, e.g. pl"
                />
                <datalist id="x11-list">
                  {s?.options.x11_layouts.map((l) => <option key={l} value={l} />)}
                </datalist>
                <input
                  style={{ ...S.input, flexBasis: 120 }}
                  value={x11Variant}
                  onChange={(e) => setX11Variant(e.target.value)}
                  disabled={gated}
                  placeholder="variant (optional)"
                />
                <button
                  style={saveStyle(gated || busy || !x11Layout || (x11Layout === s?.locale.x11_layout && x11Variant === s?.locale.x11_variant))}
                  disabled={gated || busy || !x11Layout || (x11Layout === s?.locale.x11_layout && x11Variant === s?.locale.x11_variant)}
                  onClick={() => runAction('set_x11_keymap', { x11_layout: x11Layout, x11_variant: x11Variant }, 'X11 keymap updated.')}
                >
                  Save
                </button>
              </div>
            </div>
          </div>

          {/* Power */}
          <div style={S.card}>
            <h3 style={S.cardTitle}>Power</h3>
            {confirming ? (
              <div style={S.confirm}>
                <span>
                  {confirming === 'restart' ? 'Reboot' : 'Shut down'}{' '}
                  <b>{s?.hostname.static || 'this host'}</b>{' '}
                  {powerDelayMins() > 0 ? `in ${powerDelayMins()} min` : 'now'}?
                </span>
                <div style={S.confirmBtns}>
                  <button
                    style={confirming === 'restart' ? S.btnWarn : S.btnDanger}
                    onClick={() => runPower(confirming)}
                    disabled={busy}
                  >
                    {busy ? '…' : confirming === 'restart' ? 'Reboot' : 'Shut down'}
                  </button>
                  <button style={S.btnGhost} onClick={() => setConfirming(null)} disabled={busy}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div style={S.field}>
                  <label style={S.label}>Delay (minutes, optional)</label>
                  <input
                    style={{ ...S.input, maxWidth: 120 }}
                    type="number"
                    min={0}
                    value={delay}
                    onChange={(e) => { setDelay(e.target.value); if (e.target.value) setScheduleAt(''); }}
                    disabled={gated || !!scheduleAt}
                    placeholder="0 = now"
                  />
                </div>
                <div style={S.field}>
                  <label style={S.label}>…or schedule at a specific date &amp; time</label>
                  <input
                    style={{ ...S.input, maxWidth: 240 }}
                    type="datetime-local"
                    value={scheduleAt}
                    onChange={(e) => { setScheduleAt(e.target.value); if (e.target.value) setDelay(''); }}
                    disabled={gated}
                  />
                  {scheduleAt && powerDelayMins() === 0 && (
                    <span style={S.fieldHint}>That time is in the past — pick a future time.</span>
                  )}
                  {scheduleAt && powerDelayMins() > 0 && (
                    <span style={S.fieldHint}>≈ {powerDelayMins()} min from now.</span>
                  )}
                </div>
                <div style={S.actions}>
                  <button style={gated ? { ...S.btnWarn, ...S.btnDisabled } : S.btnWarn}
                    onClick={() => setConfirming('restart')} disabled={gated}>
                    Reboot
                  </button>
                  <button style={gated ? { ...S.btnDanger, ...S.btnDisabled } : S.btnDanger}
                    onClick={() => setConfirming('poweroff')} disabled={gated}>
                    Shut down
                  </button>
                  <button style={gated ? { ...S.btnGhost, ...S.btnDisabled } : S.btnGhost}
                    onClick={cancelScheduled} disabled={gated || busy}>
                    Cancel scheduled
                  </button>
                </div>
              </>
            )}
          </div>
      </div>
      </>)}
    </div>
  );
}

/* ── helpers ───────────────────────────────────────────── */

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={S.statusRow}>
      <span style={S.statusLabel}>{label}</span>
      <span style={S.statusValue}>{value}</span>
    </div>
  );
}

function Clock({ label, value }: { label: string; value: string }) {
  return (
    <div style={S.clock}>
      <div style={S.clockLabel}>{label}</div>
      <div style={S.clockValue}>{value}</div>
    </div>
  );
}

function saveStyle(disabled: boolean): React.CSSProperties {
  return disabled ? { ...S.saveOn, ...S.btnDisabled } : S.saveOn;
}

/* ── styles ────────────────────────────────────────────── */

const S: Record<string, React.CSSProperties> = {
  page: { width: '100%', maxWidth: 1600, margin: '0 auto' },
  btn: { padding: '0.5rem 1rem', borderRadius: 4, border: 'none', background: 'var(--c-blue)', color: 'var(--bg-app)', cursor: 'pointer' },
  // Masonry-style flow: up to 3 columns, each ≥300px so it collapses gracefully.
  columns: { columnCount: 3, columnWidth: 300, columnGap: '1rem' },
  card: { background: 'var(--bg-panel)', borderRadius: 8, padding: '1rem', marginBottom: '1rem', breakInside: 'avoid' },
  cardTitle: { margin: '0 0 0.75rem 0', fontSize: '1.05rem' },
  notice: { color: 'var(--text-2)', fontSize: '0.85rem', margin: '0 0 1rem 0' },
  rebootBanner: {
    display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem',
    padding: '0.6rem 0.85rem', borderRadius: 8, fontSize: '0.85rem',
    background: 'color-mix(in srgb, var(--c-yellow) 12%, var(--bg-surface))',
    border: '1px solid color-mix(in srgb, var(--c-yellow) 35%, transparent)',
    color: 'color-mix(in srgb, var(--c-yellow) 85%, var(--text-1))',
  },
  readonlyBox: {
    display: 'flex', flexDirection: 'column', gap: '0.2rem',
    padding: '0.45rem 0.6rem', borderRadius: 5, background: 'var(--bg-app)',
    fontSize: '0.83rem', fontFamily: 'monospace',
  },
  statusRow: { display: 'flex', justifyContent: 'space-between', padding: '0.35rem 0.5rem', borderRadius: 4, background: 'var(--bg-app)', marginBottom: '0.5rem' },
  statusLabel: { color: 'var(--text-2)', fontSize: '0.9rem' },
  statusValue: { fontWeight: 600, fontSize: '0.9rem', fontFamily: 'monospace' },
  clockGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '0.5rem', marginBottom: '0.85rem' },
  clock: { background: 'var(--bg-app)', borderRadius: 6, padding: '0.5rem 0.65rem' },
  clockLabel: { fontSize: '0.7rem', color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.2rem' },
  clockValue: { fontSize: '0.85rem', fontWeight: 600, fontFamily: 'monospace' },
  serverHint: { color: 'var(--text-2)', fontWeight: 400 },
  fieldHint: { display: 'block', fontSize: '0.72rem', color: 'var(--text-2)', marginTop: '0.3rem' },
  field: { marginBottom: '0.75rem' },
  label: { display: 'block', fontSize: '0.78rem', color: 'var(--text-2)', marginBottom: '0.3rem' },
  controlRow: { display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' },
  input: { flex: 1, minWidth: 160, padding: '0.4rem 0.6rem', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-1)', fontSize: '0.85rem', outline: 'none' },
  toggleState: { flex: 1, minWidth: 160, fontSize: '0.85rem', fontWeight: 600 },
  saveOn: { padding: '0.4rem 0.9rem', borderRadius: 5, border: 'none', background: 'var(--c-blue)', color: 'var(--bg-app)', cursor: 'pointer', fontWeight: 600, fontSize: '0.83rem' },
  actions: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' },
  confirm: { display: 'flex', flexDirection: 'column', gap: '0.6rem', fontSize: '0.9rem' },
  confirmBtns: { display: 'flex', gap: '0.5rem' },
  btnWarn: { padding: '0.45rem 1rem', borderRadius: 5, border: 'none', background: 'var(--c-yellow)', color: 'var(--bg-app)', cursor: 'pointer', fontWeight: 600 },
  btnDanger: { padding: '0.45rem 1rem', borderRadius: 5, border: 'none', background: 'var(--c-red)', color: 'var(--bg-app)', cursor: 'pointer', fontWeight: 600 },
  btnGhost: { padding: '0.45rem 1rem', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-1)', cursor: 'pointer' },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
};
