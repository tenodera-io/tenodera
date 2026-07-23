pub mod audit;
mod config;
mod handler;
mod handlers;
mod identity;
mod router;
pub mod util;

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use futures::{SinkExt, StreamExt};
use tenodera_protocol::auth::build_challenge_payload;
use tenodera_protocol::message::{Message, PROTOCOL_VERSION};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tracing_subscriber::EnvFilter;

use crate::config::AgentConfig;
use crate::identity::AgentIdentity;
use crate::router::Router;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("tenodera_agent=debug".parse()?),
        )
        .with_ansi(false)
        .with_writer(std::io::stderr)
        .init();

    let config = match AgentConfig::from_env() {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("{e}");
            std::process::exit(1);
        }
    };

    let identity = match AgentIdentity::load_or_create() {
        Ok(id) => Arc::new(id),
        Err(e) => {
            tracing::error!("failed to load/create agent identity: {e}");
            std::process::exit(1);
        }
    };

    let hostname = hostname();
    tracing::info!(gateway = %config.agent_ws_url(), %hostname, "tenodera-agent starting");

    let mut backoff_secs: u64 = 1;
    loop {
        match run_session(&config, &hostname, &identity).await {
            Ok(()) => {
                tracing::info!("gateway connection closed — reconnecting");
                backoff_secs = 1;
            }
            Err(e) => {
                tracing::error!(error = %e, "connection failed — reconnecting in {backoff_secs}s");
            }
        }
        // Full jitter: sleep a random duration in [0, backoff] so a fleet of
        // agents doesn't reconnect in lockstep when the gateway comes back after
        // an outage. Nanosecond clock skew across hosts is enough entropy here —
        // this is de-synchronization, not security — so no RNG dependency is pulled in.
        let ceiling_ms = backoff_secs.saturating_mul(1000).saturating_add(1);
        let jitter_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| u64::from(d.subsec_nanos()))
            .unwrap_or(0)
            % ceiling_ms;
        tokio::time::sleep(Duration::from_millis(jitter_ms)).await;
        backoff_secs = (backoff_secs * 2).min(30);
    }
}

async fn run_session(
    config: &AgentConfig,
    hostname: &str,
    identity: &AgentIdentity,
) -> anyhow::Result<()> {
    let url = config.agent_ws_url();
    let connector = build_tls_connector(config);
    let request = url.clone().into_client_request()?;

    tracing::info!(%url, "connecting to gateway");
    let (ws_stream, _) =
        tokio_tungstenite::connect_async_tls_with_config(request, None, false, connector).await?;

    let (mut ws_sink, mut ws_stream) = ws_stream.split();

    // ── Hello ────────────────────────────────────────────────────────────────
    let hello = serde_json::to_string(&Message::Hello {
        version: PROTOCOL_VERSION,
        hostname: hostname.to_string(),
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        is_local: config.is_local(),
        public_key: Some(identity.public_key_b64()),
        bootstrap_token: config.bootstrap_token.clone(),
        os_id: read_os_id(),
    })?;
    ws_sink
        .send(tokio_tungstenite::tungstenite::Message::Text(hello.into()))
        .await?;

    // ── Wait for Challenge ───────────────────────────────────────────────────
    let (nonce_b64, gateway_id) = loop {
        match ws_stream.next().await {
            Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                match serde_json::from_str::<Message>(&text) {
                    Ok(Message::Challenge { nonce, gateway_id }) => break (nonce, gateway_id),
                    Ok(other) => anyhow::bail!("expected Challenge, got: {other:?}"),
                    Err(e) => anyhow::bail!("parse error waiting for Challenge: {e}"),
                }
            }
            Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | None => {
                anyhow::bail!("connection closed before Challenge")
            }
            Some(Ok(_)) => continue,
            Some(Err(e)) => anyhow::bail!("WS error waiting for Challenge: {e}"),
        }
    };

    // ── Bilateral TOFU: verify or pin gateway_id ─────────────────────────────
    match identity.load_gateway_id()? {
        Some(pinned) if pinned != gateway_id => {
            anyhow::bail!(
                "gateway_id mismatch: pinned={pinned} got={gateway_id} — possible MITM, refusing connection"
            );
        }
        Some(_) => {}
        None => {
            // First connection. If the operator pinned the expected gateway id
            // out-of-band (TENODERA_GATEWAY_ID), verify it before trusting — this
            // closes the trust-on-first-use MITM window. Without it we fall back to
            // plain TOFU: pin whatever answers first.
            if let Some(expected) = &config.expected_gateway_id
                && expected != &gateway_id
            {
                anyhow::bail!(
                    "gateway_id {gateway_id} does not match the configured TENODERA_GATEWAY_ID {expected} — refusing first-connect enrollment (possible MITM)"
                );
            }
            identity.save_gateway_id(&gateway_id)?;
            if config.expected_gateway_id.is_some() {
                tracing::info!(%gateway_id, "gateway_id pinned (verified against TENODERA_GATEWAY_ID)");
            } else {
                tracing::info!(%gateway_id, "gateway_id pinned (first enrollment, TOFU)");
            }
        }
    }

    // ── Sign challenge ────────────────────────────────────────────────────────
    let nonce_bytes = base64::engine::general_purpose::STANDARD
        .decode(&nonce_b64)
        .map_err(|e| anyhow::anyhow!("invalid nonce encoding: {e}"))?;
    if nonce_bytes.len() != 32 {
        anyhow::bail!("nonce must be 32 bytes, got {}", nonce_bytes.len());
    }
    let nonce_arr: [u8; 32] = nonce_bytes.try_into().unwrap();
    let payload = build_challenge_payload(&nonce_arr, hostname, &gateway_id);
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(identity.sign(&payload));

    // ── ChallengeResponse ────────────────────────────────────────────────────
    let cr = serde_json::to_string(&Message::Challengeresponse { signature: sig_b64 })?;
    ws_sink
        .send(tokio_tungstenite::tungstenite::Message::Text(cr.into()))
        .await?;

    // ── Wait for HelloAck or Pending ──────────────────────────────────────────
    let gateway_version = loop {
        match ws_stream.next().await {
            Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                match serde_json::from_str::<Message>(&text) {
                    Ok(Message::HelloAck { version, warning }) => {
                        if let Some(w) = warning {
                            tracing::warn!("HelloAck warning: {w}");
                        }
                        break version;
                    }
                    Ok(Message::Pending { reason }) => {
                        tracing::info!(
                            %reason,
                            fingerprint = %identity.fingerprint(),
                            "agent pending admin approval — waiting"
                        );
                        // Stay connected; gateway will send HelloAck when approved
                        let version = wait_for_approval(&mut ws_sink, &mut ws_stream).await?;
                        break version;
                    }
                    Ok(other) => {
                        anyhow::bail!("unexpected message after ChallengeResponse: {other:?}")
                    }
                    Err(e) => anyhow::bail!("parse error: {e}"),
                }
            }
            Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | None => {
                anyhow::bail!("connection closed during auth (rejected)")
            }
            Some(Ok(_)) => continue,
            Some(Err(e)) => anyhow::bail!("WS error during auth: {e}"),
        }
    };

    tracing::info!(gateway_version, fingerprint = %identity.fingerprint(), "handshake complete");

    // Enrollment succeeded and our key is now pinned on the gateway — a bootstrap
    // token (if we used one) is single-use in practice. Scrub it from the config
    // so a leftover, possibly multi-use, token can't be replayed to enroll a rogue
    // agent later. No-op on reconnects once it's gone.
    if config.bootstrap_token.is_some() {
        crate::config::scrub_bootstrap_token();
    }

    // ── Normal operation ──────────────────────────────────────────────────────
    let (out_tx, mut out_rx) = mpsc::channel::<Message>(256);

    let writer_handle = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            match serde_json::to_string(&msg) {
                Ok(json) => {
                    if ws_sink
                        .send(tokio_tungstenite::tungstenite::Message::Text(json.into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(e) => tracing::error!(error = %e, "failed to serialize outgoing message"),
            }
        }
        let _ = ws_sink.close().await;
    });

    let mut router = Router::new(out_tx.clone());
    router.register_defaults();

    while let Some(frame) = ws_stream.next().await {
        let text = match frame {
            Ok(tokio_tungstenite::tungstenite::Message::Text(t)) => t,
            Ok(tokio_tungstenite::tungstenite::Message::Close(_)) => break,
            Ok(tokio_tungstenite::tungstenite::Message::Ping(data)) => {
                let _ = out_tx.send(Message::Pong).await;
                let _ = data;
                continue;
            }
            Ok(_) => continue,
            Err(e) => {
                tracing::warn!(error = %e, "WS read error");
                break;
            }
        };

        let msg: Message = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(error = %e, raw = %text, "invalid message from gateway");
                continue;
            }
        };

        let responses = router.handle(msg).await;
        for resp in responses {
            if out_tx.send(resp).await.is_err() {
                break;
            }
        }
    }

    drop(out_tx);
    writer_handle.abort();
    tracing::info!("session ended");
    Ok(())
}

/// Wait for HelloAck while keeping the connection alive during pending approval.
async fn wait_for_approval<S, R>(sink: &mut S, stream: &mut R) -> anyhow::Result<u32>
where
    S: SinkExt<tokio_tungstenite::tungstenite::Message> + Unpin,
    R: StreamExt<
            Item = Result<
                tokio_tungstenite::tungstenite::Message,
                tokio_tungstenite::tungstenite::Error,
            >,
        > + Unpin,
{
    let mut ping_interval = tokio::time::interval(Duration::from_secs(30));
    ping_interval.tick().await; // consume immediate first tick

    loop {
        tokio::select! {
            frame = stream.next() => {
                match frame {
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                        match serde_json::from_str::<Message>(&text) {
                            Ok(Message::HelloAck { version, warning }) => {
                                if let Some(w) = warning { tracing::warn!("HelloAck warning: {w}"); }
                                tracing::info!("admin approved — resuming");
                                return Ok(version);
                            }
                            Ok(Message::Ping) => {
                                let _ = sink.send(
                                    tokio_tungstenite::tungstenite::Message::Pong(vec![].into())
                                ).await;
                            }
                            Ok(_) => {}
                            Err(_) => {}
                        }
                    }
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Ping(data))) => {
                        let _ = sink.send(tokio_tungstenite::tungstenite::Message::Pong(data)).await;
                    }
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | None => {
                        anyhow::bail!("connection closed while pending approval");
                    }
                    Some(Err(e)) => anyhow::bail!("WS error while pending: {e}"),
                    Some(Ok(_)) => {}
                }
            }
            _ = ping_interval.tick() => {
                if sink.send(tokio_tungstenite::tungstenite::Message::Ping(vec![].into())).await.is_err() {
                    anyhow::bail!("failed to send keepalive ping");
                }
            }
        }
    }
}

fn build_tls_connector(config: &AgentConfig) -> Option<tokio_tungstenite::Connector> {
    if config.accept_insecure {
        tracing::warn!("TLS certificate verification disabled (TENODERA_AGENT_ACCEPT_INSECURE=1)");
        let rustls_config = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(SkipVerify))
            .with_no_client_auth();
        Some(tokio_tungstenite::Connector::Rustls(Arc::new(
            rustls_config,
        )))
    } else {
        None
    }
}

fn hostname() -> String {
    nix::unistd::gethostname()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "unknown".to_string())
}

// ── TLS skip-verify implementation ────────────────────────────────────────────

#[derive(Debug)]
struct SkipVerify;

impl rustls::client::danger::ServerCertVerifier for SkipVerify {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        vec![
            rustls::SignatureScheme::RSA_PKCS1_SHA1,
            rustls::SignatureScheme::RSA_PKCS1_SHA256,
            rustls::SignatureScheme::RSA_PKCS1_SHA384,
            rustls::SignatureScheme::RSA_PKCS1_SHA512,
            rustls::SignatureScheme::ECDSA_NISTP256_SHA256,
            rustls::SignatureScheme::ECDSA_NISTP384_SHA384,
            rustls::SignatureScheme::ECDSA_NISTP521_SHA512,
            rustls::SignatureScheme::RSA_PSS_SHA256,
            rustls::SignatureScheme::RSA_PSS_SHA384,
            rustls::SignatureScheme::RSA_PSS_SHA512,
            rustls::SignatureScheme::ED25519,
            rustls::SignatureScheme::ED448,
        ]
    }
}

fn read_os_id() -> Option<String> {
    let content = std::fs::read_to_string("/etc/os-release").ok()?;
    for line in content.lines() {
        if let Some(val) = line.strip_prefix("ID=") {
            return Some(val.trim_matches('"').to_lowercase());
        }
    }
    None
}
