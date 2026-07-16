import React, { useState } from 'react';
import { PageHeader } from '../components/PageHeader.tsx';
import { Tabs } from '../components/Tabs.tsx';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Endpoint {
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  path: string;
  auth: 'none' | 'bearer' | 'admin';
  desc: string;
  body?: string;
  response: string;
  curl: string;
}

// ── Data ──────────────────────────────────────────────────────────────────────

const BASE = 'http://<panel>:9090';

const SECTIONS: { title: string; desc?: string; endpoints: Endpoint[] }[] = [
  {
    title: 'Authentication',
    desc: 'All mutating requests require an Origin header matching the Host header (CSRF protection). The session token is returned on login and passed as a Bearer token.',
    endpoints: [
      {
        method: 'POST',
        path: '/api/auth/login',
        auth: 'none',
        desc: 'Authenticate with PAM credentials. Returns a session token. Users in sudo/wheel/admin groups get the admin role; others get readonly.',
        body: `{
  "user": "alice",
  "password": "secret"
}`,
        response: `{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "role": "admin"       // or "readonly"
}`,
        curl: `curl -s -X POST ${BASE}/api/auth/login \\
  -H "Content-Type: application/json" \\
  -H "Origin: ${BASE}" \\
  -d '{"user":"alice","password":"secret"}'`,
      },
      {
        method: 'POST',
        path: '/api/auth/logout',
        auth: 'bearer',
        desc: 'Invalidate the current session.',
        body: `{
  "session_id": "<session_id>"
}`,
        response: `204 No Content`,
        curl: `curl -s -X POST ${BASE}/api/auth/logout \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer <session_id>" \\
  -H "Origin: ${BASE}" \\
  -d '{"session_id":"<session_id>"}'`,
      },
    ],
  },
  {
    title: 'Hosts',
    desc: 'Enrolled hosts — machines with an approved agent connection.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/hosts',
        auth: 'bearer',
        desc: 'List all enrolled hosts with online status.',
        response: `{
  "hosts": [
    {
      "id": "550e8400...",
      "name": "web-01",
      "hostname": "web-01.internal",
      "display_name": null,
      "added_at": "2026-07-01T10:00:00Z",
      "last_seen": "2026-07-03T12:00:00Z",
      "online": true,
      "is_local": false,
      "remote_ip": "192.168.1.11"
    }
  ]
}`,
        curl: `curl -s ${BASE}/api/hosts \\
  -H "Authorization: Bearer <session_id>"`,
      },
      {
        method: 'PATCH',
        path: '/api/hosts/{id}',
        auth: 'bearer',
        desc: 'Rename a host (set display name). Pass null to clear.',
        body: `{
  "display_name": "Production Web"
}`,
        response: `204 No Content`,
        curl: `curl -s -X PATCH ${BASE}/api/hosts/<id> \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer <session_id>" \\
  -H "Origin: ${BASE}" \\
  -d '{"display_name":"Production Web"}'`,
      },
      {
        method: 'DELETE',
        path: '/api/hosts/{id}',
        auth: 'bearer',
        desc: 'Remove a host from the panel. The agent will re-enter pending on next connect.',
        response: `204 No Content`,
        curl: `curl -s -X DELETE ${BASE}/api/hosts/<id> \\
  -H "Authorization: Bearer <session_id>" \\
  -H "Origin: ${BASE}"`,
      },
    ],
  },
  {
    title: 'Pending',
    desc: 'Agents that connected but have not yet been approved. Each is identified by its Ed25519 key fingerprint.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/agent/pending',
        auth: 'admin',
        desc: 'List agents waiting for approval.',
        response: `{
  "pending": [
    {
      "hostname": "web-02",
      "fingerprint": "SHA256:abc123...",
      "fingerprint_hex": "a1b2c3d4...",
      "remote_ip": "192.168.1.12",
      "waiting_secs": 42
    }
  ]
}`,
        curl: `curl -s ${BASE}/api/agent/pending \\
  -H "Authorization: Bearer <session_id>"`,
      },
      {
        method: 'POST',
        path: '/api/agent/pending/{fingerprint_hex}/approve',
        auth: 'admin',
        desc: 'Approve a pending agent. The agent\'s Ed25519 key is stored and it is immediately enrolled. Optionally set a display name.',
        body: `{
  "display_name": "web-02"   // optional
}`,
        response: `{
  "approved": true,
  "host_id": "550e8400..."
}`,
        curl: `curl -s -X POST ${BASE}/api/agent/pending/<fingerprint_hex>/approve \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer <session_id>" \\
  -H "Origin: ${BASE}" \\
  -d '{"display_name":"web-02"}'`,
      },
    ],
  },
  {
    title: 'Bootstrap Tokens',
    desc: 'Tokens allow agents to self-enroll without manual approval. Each token can be single-use or multi-use with a TTL.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/agent/tokens',
        auth: 'admin',
        desc: 'List all active bootstrap tokens.',
        response: `{
  "tokens": [
    {
      "id": "tok_abc123",
      "single_use": true,
      "use_count": 0,
      "max_uses": null,
      "expires_in_secs": 3540,
      "bound_hostname": null,
      "re_enroll": false,
      "expired": false,
      "exhausted": false
    }
  ]
}`,
        curl: `curl -s ${BASE}/api/agent/tokens \\
  -H "Authorization: Bearer <session_id>"`,
      },
      {
        method: 'POST',
        path: '/api/agent/tokens',
        auth: 'admin',
        desc: 'Create a bootstrap token. Returns the token value and a ready-to-use install command.',
        body: `{
  "ttl_secs": 3600,          // 60–2592000 (30 days)
  "single_use": true,        // false = multi-use
  "max_uses": null,          // limit uses when single_use=false
  "bound_hostname": null,    // restrict to one hostname
  "re_enroll": false         // replace key on existing host
}`,
        response: `{
  "id": "tok_abc123",
  "token": "tkn_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "ttl_secs": 3600,
  "install_cmd": "curl -sSL http://<panel>:9090/tenodera-agent.sh | sudo bash -s -- --gateway http://<panel>:9090 --token tkn_xxx..."
}`,
        curl: `curl -s -X POST ${BASE}/api/agent/tokens \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer <session_id>" \\
  -H "Origin: ${BASE}" \\
  -d '{"ttl_secs":3600,"single_use":true}'`,
      },
      {
        method: 'DELETE',
        path: '/api/agent/tokens/{id}',
        auth: 'admin',
        desc: 'Revoke a token immediately. Agents that have not yet connected with this token will be rejected.',
        response: `204 No Content`,
        curl: `curl -s -X DELETE ${BASE}/api/agent/tokens/<id> \\
  -H "Authorization: Bearer <session_id>" \\
  -H "Origin: ${BASE}"`,
      },
    ],
  },
  {
    title: 'Health',
    desc: 'Health endpoints — no authentication required.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/health',
        auth: 'none',
        desc: 'Basic liveness check. Always returns 200 while the gateway is running.',
        response: `{
  "status": "ok",
  "sessions": 2,
  "uptime_secs": 3612,
  "version": "0.4.0"
}`,
        curl: `curl -s ${BASE}/api/health`,
      },
      {
        method: 'GET',
        path: '/api/health/ready',
        auth: 'none',
        desc: 'Readiness check. Returns 200 only when the agent binary is installed and executable.',
        response: `// Ready (200):
{
  "ready": true,
  "agent_bin": "/usr/local/bin/tenodera-agent"
}

// Not ready (503):
{
  "ready": false,
  "agent_bin": "/usr/local/bin/tenodera-agent",
  "error": "/usr/local/bin/tenodera-agent: No such file or directory"
}`,
        curl: `curl -s ${BASE}/api/health/ready`,
      },
    ],
  },
];

// ── Recipes ───────────────────────────────────────────────────────────────────

const RECIPES = [
  {
    title: 'Approve all pending hosts',
    code: `SESSION=$(curl -s -X POST ${BASE}/api/auth/login \\
  -H "Content-Type: application/json" \\
  -H "Origin: ${BASE}" \\
  -d '{"user":"alice","password":"secret"}' \\
  | python3 -c "import sys,json; print(json.load(sys.stdin)['session_id'])")

curl -s ${BASE}/api/agent/pending \\
  -H "Authorization: Bearer $SESSION" \\
  | python3 -c "
import sys, json, urllib.request, urllib.error
data = json.load(sys.stdin)
for p in data.get('pending', []):
    fp  = p['fingerprint_hex']
    hn  = p['hostname']
    req = urllib.request.Request(
        '${BASE}/api/agent/pending/' + fp + '/approve',
        data=json.dumps({'display_name': hn}).encode(),
        headers={
            'Content-Type': 'application/json',
            'Authorization': 'Bearer $SESSION',
            'Origin': '${BASE}',
        },
        method='POST',
    )
    try:
        urllib.request.urlopen(req)
        print(f'Approved: {hn}')
    except urllib.error.HTTPError as e:
        print(f'Failed {hn}: {e}')
"`,
  },
  {
    title: 'Generate token and install agent on remote host',
    code: `SESSION=$(curl -s -X POST ${BASE}/api/auth/login \\
  -H "Content-Type: application/json" \\
  -H "Origin: ${BASE}" \\
  -d '{"user":"alice","password":"secret"}' \\
  | python3 -c "import sys,json; print(json.load(sys.stdin)['session_id'])")

TOKEN=$(curl -s -X POST ${BASE}/api/agent/tokens \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $SESSION" \\
  -H "Origin: ${BASE}" \\
  -d '{"ttl_secs":3600,"single_use":true}' \\
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

ssh user@remote-host \\
  "curl -sSfL ${BASE}/tenodera-agent.sh | sudo bash -s -- --gateway ${BASE} --token $TOKEN"`,
  },
  {
    title: 'List online hosts',
    code: `SESSION=$(curl -s -X POST ${BASE}/api/auth/login \\
  -H "Content-Type: application/json" \\
  -H "Origin: ${BASE}" \\
  -d '{"user":"alice","password":"secret"}' \\
  | python3 -c "import sys,json; print(json.load(sys.stdin)['session_id'])")

curl -s ${BASE}/api/hosts \\
  -H "Authorization: Bearer $SESSION" \\
  | python3 -c "
import sys, json
hosts = json.load(sys.stdin)['hosts']
online = [h for h in hosts if h['online']]
print(f'{len(online)}/{len(hosts)} online')
for h in online:
    print(f\"  {h['name']:20s}  {h.get('remote_ip','local'):15s}\")
"`,
  },
];

// ── Component ─────────────────────────────────────────────────────────────────

const METHOD_COLORS: Record<string, string> = {
  GET:    'var(--c-green)',
  POST:   'var(--c-blue)',
  DELETE: 'var(--c-red)',
  PATCH:  'var(--c-yellow)',
};

const AUTH_LABELS: Record<string, string> = {
  none:   'Public',
  bearer: 'Bearer token',
  admin:  'Bearer token + admin role',
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button style={S.copyBtn} onClick={copy}>
      {copied ? '✓' : 'Copy'}
    </button>
  );
}

function CodeBlock({ code, lang = 'bash' }: { code: string; lang?: string }) {
  return (
    <div style={{ position: 'relative' }}>
      <pre style={{ ...S.pre, ...(lang === 'json' ? { color: 'var(--c-green)' } : {}) }}>
        <code>{code}</code>
      </pre>
      <CopyButton text={code} />
    </div>
  );
}

function EndpointCard({ ep }: { ep: Endpoint }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={S.epCard}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <span style={{ ...S.methodBadge, background: `${METHOD_COLORS[ep.method]}22`, color: METHOD_COLORS[ep.method], borderColor: `${METHOD_COLORS[ep.method]}44` }}>
          {ep.method}
        </span>
        <code style={S.pathCode}>{ep.path}</code>
        <span style={{ ...S.authBadge, marginLeft: 'auto' }}>{AUTH_LABELS[ep.auth]}</span>
        <span style={{ color: 'var(--text-3)', fontSize: '0.75rem' }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div style={S.epBody}>
          <p style={S.epDesc}>{ep.desc}</p>

          {ep.body && (
            <>
              <div style={S.subLabel}>Request body</div>
              <CodeBlock code={ep.body} lang="json" />
            </>
          )}

          <div style={S.subLabel}>Response</div>
          <CodeBlock code={ep.response} lang="json" />

          <div style={S.subLabel}>curl example</div>
          <CodeBlock code={ep.curl} />
        </div>
      )}
    </div>
  );
}

export function ApiDocs() {
  const [activeTab, setActiveTab] = useState<'reference' | 'recipes'>('reference');

  return (
    <div style={S.page}>
      <PageHeader icon="api" title="API Reference" />
      <Tabs
        tabs={[
          { id: 'reference', label: 'Endpoints' },
          { id: 'recipes', label: 'Recipes' },
        ]}
        active={activeTab}
        onChange={(t) => setActiveTab(t as 'reference' | 'recipes')}
        style={{ marginBottom: '1.25rem' }}
      />

      {activeTab === 'reference' && (
        <>
          <div style={S.notice}>
            All mutating requests (POST / PATCH / DELETE) require an <code>Origin</code> header matching the <code>Host</code> header — CSRF protection. The examples below use the same value for both.
          </div>
          {SECTIONS.map(sec => (
            <div key={sec.title} style={{ marginBottom: '2rem' }}>
              <div style={S.sectionTitle}>{sec.title}</div>
              {sec.desc && <p style={S.sectionDesc}>{sec.desc}</p>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {sec.endpoints.map(ep => (
                  <EndpointCard key={ep.method + ep.path} ep={ep} />
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      {activeTab === 'recipes' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div style={S.notice}>
            Replace <code>{BASE}</code> with your panel URL and <code>alice</code> / <code>secret</code> with your credentials. Requires Python 3 (standard library only).
          </div>
          {RECIPES.map(r => (
            <div key={r.title} style={S.recipeCard}>
              <div style={S.sectionTitle}>{r.title}</div>
              <CodeBlock code={r.code} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  page:        { padding: '1.5rem', maxWidth: 900, margin: '0 auto' },
  title:       { margin: 0, fontSize: '1.4rem' },
  tabBtn:      { padding: '0.3rem 0.7rem', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-2)', cursor: 'pointer', fontSize: '0.8rem' },
  tabActive:   { background: 'var(--c-blue)', color: 'var(--bg-app)', borderColor: 'var(--c-blue)', fontWeight: 600 },

  notice:      { fontSize: '0.82rem', color: 'var(--text-2)', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.65rem 0.9rem', marginBottom: '1.5rem', lineHeight: 1.6 },

  sectionTitle: { fontSize: '1rem', fontWeight: 700, marginBottom: '0.35rem', color: 'var(--text-1)' },
  sectionDesc:  { fontSize: '0.83rem', color: 'var(--text-2)', margin: '0 0 0.75rem 0', lineHeight: 1.5 },

  epCard:      { background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.75rem 1rem' },
  epBody:      { marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '0.5rem' },
  epDesc:      { margin: 0, fontSize: '0.84rem', color: 'var(--text-2)', lineHeight: 1.5 },

  methodBadge: { fontSize: '0.72rem', fontWeight: 700, padding: '0.15rem 0.45rem', borderRadius: 4, border: '1px solid', flexShrink: 0, fontFamily: 'monospace', letterSpacing: '0.03em' },
  pathCode:    { fontFamily: 'monospace', fontSize: '0.88rem', color: 'var(--text-1)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  authBadge:   { fontSize: '0.72rem', color: 'var(--text-2)', background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.1rem 0.4rem', whiteSpace: 'nowrap', flexShrink: 0 },

  subLabel:    { fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.06em' },

  pre:         { background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.7rem 0.9rem', margin: 0, fontSize: '0.78rem', fontFamily: 'monospace', overflowX: 'auto', color: 'var(--text-1)', lineHeight: 1.6, whiteSpace: 'pre' },
  copyBtn:     { position: 'absolute', top: '0.4rem', right: '0.4rem', padding: '0.15rem 0.45rem', fontSize: '0.72rem', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-2)', cursor: 'pointer' },

  recipeCard:  { background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.9rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' },
};
