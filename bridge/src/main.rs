pub mod audit;
mod config;
mod handler;
mod handlers;
mod router;
pub mod util;

use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use tenodera_protocol::message::{Message, PROTOCOL_VERSION};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tracing_subscriber::EnvFilter;

use crate::config::BridgeConfig;
use crate::router::Router;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("tenodera_bridge=debug".parse()?),
        )
        .with_ansi(false)
        .with_writer(std::io::stderr)
        .init();

    let config = match BridgeConfig::from_env() {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("{e}");
            std::process::exit(1);
        }
    };

    let hostname = hostname();
    tracing::info!(gateway = %config.bridge_ws_url(), %hostname, "tenodera-bridge starting");

    let mut backoff_secs: u64 = 1;
    loop {
        match run_session(&config, &hostname).await {
            Ok(()) => {
                tracing::info!("gateway connection closed — reconnecting");
                backoff_secs = 1;
            }
            Err(e) => {
                tracing::error!(error = %e, "connection failed — reconnecting in {backoff_secs}s");
            }
        }
        tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
        backoff_secs = (backoff_secs * 2).min(30);
    }
}

async fn run_session(config: &BridgeConfig, hostname: &str) -> anyhow::Result<()> {
    let url = config.bridge_ws_url();
    let connector = build_tls_connector(config);
    let mut request = url.clone().into_client_request()?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", config.token).parse()?,
    );
    request.headers_mut().insert(
        "X-Bridge-Hostname",
        hostname.parse()?,
    );

    tracing::info!(%url, "connecting to gateway");
    let (ws_stream, _) = tokio_tungstenite::connect_async_tls_with_config(
        request, None, false, connector,
    ).await?;

    tracing::info!("WebSocket connected — starting handshake");

    let (mut ws_sink, mut ws_stream) = ws_stream.split();

    // Send Hello as first message
    let hello = serde_json::to_string(&Message::Hello { version: PROTOCOL_VERSION })?;
    ws_sink.send(tokio_tungstenite::tungstenite::Message::Text(hello.into())).await?;

    // Wait for HelloAck
    let ack = loop {
        match ws_stream.next().await {
            Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                match serde_json::from_str::<Message>(&text) {
                    Ok(Message::HelloAck { version, warning }) => {
                        if let Some(w) = warning {
                            tracing::warn!("HelloAck warning: {w}");
                        }
                        break version;
                    }
                    Ok(other) => {
                        anyhow::bail!("expected HelloAck, got: {other:?}");
                    }
                    Err(e) => {
                        anyhow::bail!("failed to parse HelloAck: {e}");
                    }
                }
            }
            Some(Ok(_)) => continue,
            Some(Err(e)) => anyhow::bail!("WS error waiting for HelloAck: {e}"),
            None => anyhow::bail!("WS closed before HelloAck"),
        }
    };

    tracing::info!(gateway_version = ack, "handshake complete");

    // Channel for outgoing messages (handlers → WS sink)
    let (out_tx, mut out_rx) = mpsc::channel::<Message>(256);

    // Spawn WS sink writer task
    let writer_handle = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            match serde_json::to_string(&msg) {
                Ok(json) => {
                    if ws_sink.send(tokio_tungstenite::tungstenite::Message::Text(json.into())).await.is_err() {
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
                // tungstenite handles Pong automatically, but send our own Pong too
                let _ = out_tx.send(Message::Pong).await;
                let _ = data; // suppress unused warning
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
    let _ = writer_handle.await;
    tracing::info!("session ended");
    Ok(())
}

fn build_tls_connector(config: &BridgeConfig) -> Option<tokio_tungstenite::Connector> {
    if config.accept_insecure {
        tracing::warn!("TLS certificate verification disabled (TENODERA_BRIDGE_ACCEPT_INSECURE=1)");
        let rustls_config = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(SkipVerify))
            .with_no_client_auth();
        Some(tokio_tungstenite::Connector::Rustls(Arc::new(rustls_config)))
    } else {
        // None → tokio-tungstenite uses its built-in rustls connector
        // (webpki roots, enabled via feature rustls-tls-webpki-roots)
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
