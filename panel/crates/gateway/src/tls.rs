use std::io::BufReader;
use std::sync::Arc;

use axum::extract::ConnectInfo;
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

use crate::config::GatewayConfig;

/// Build a `TlsAcceptor` from PEM cert/key files specified in config.
/// Returns `None` if TLS is not configured.
pub fn build_acceptor(config: &GatewayConfig) -> anyhow::Result<Option<TlsAcceptor>> {
    let (cert_path, key_path) = match (&config.tls_cert, &config.tls_key) {
        (Some(c), Some(k)) => (c.clone(), k.clone()),
        _ => return Ok(None),
    };

    let cert_file = std::fs::File::open(&cert_path)
        .map_err(|e| anyhow::anyhow!("failed to open TLS cert {cert_path}: {e}"))?;
    let key_file = std::fs::File::open(&key_path)
        .map_err(|e| anyhow::anyhow!("failed to open TLS key {key_path}: {e}"))?;

    let certs: Vec<_> = rustls_pemfile::certs(&mut BufReader::new(cert_file))
        .collect::<Result<Vec<_>, _>>()?;

    let key = rustls_pemfile::private_key(&mut BufReader::new(key_file))?
        .ok_or_else(|| anyhow::anyhow!("no private key found in {key_path}"))?;

    let tls_config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)?;

    Ok(Some(TlsAcceptor::from(Arc::new(tls_config))))
}

/// Run the TLS server: accept TLS connections, wrap them, and serve with axum's
/// hyper integration via `hyper_util`.
pub async fn serve_tls(
    listener: TcpListener,
    acceptor: TlsAcceptor,
    app: axum::Router,
) -> anyhow::Result<()> {
    use hyper_util::rt::TokioIo;

    loop {
        let (stream, addr) = match listener.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                // TCP accept errors (fd exhaustion, connection reset) must not
                // kill the entire server — log and continue accepting.
                tracing::error!(error = %e, "TCP accept failed");
                // Brief sleep to avoid tight loop on persistent errors
                // (e.g. fd exhaustion).
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
        };
        let acceptor = acceptor.clone();
        let app = app.clone();

        tokio::spawn(async move {
            match acceptor.accept(stream).await {
                Ok(tls_stream) => {
                    let io = TokioIo::new(tls_stream);
                    // Inject ConnectInfo so handlers can extract client IP
                    let svc = app.layer(axum::Extension(ConnectInfo(addr)));
                    let service = hyper_util::service::TowerToHyperService::new(svc.into_service());
                    let conn = hyper_util::server::conn::auto::Builder::new(
                        hyper_util::rt::TokioExecutor::new(),
                    );
                    if let Err(e) = conn.serve_connection_with_upgrades(io, service).await {
                        tracing::debug!(error = %e, addr = %addr, "connection error");
                    }
                }
                Err(e) => {
                    tracing::debug!(error = %e, addr = %addr, "TLS handshake failed");
                }
            }
        });
    }
}
