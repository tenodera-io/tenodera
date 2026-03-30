use std::sync::Arc;

use axum::{
    middleware::Next,
    extract::{Request, State},
    response::Response,
};
use axum::http::{HeaderValue, Method, StatusCode};

use crate::AppState;

/// Middleware that enforces CSRF Origin checks on state-changing requests
/// and adds security headers to every HTTP response.
pub async fn security_headers(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    // ── CSRF: Origin check on mutating methods ──────────────
    // If the request carries an Origin header and the method is
    // state-changing (POST, PUT, DELETE, PATCH), verify that the
    // Origin matches the Host header.  Mismatches indicate a
    // cross-site request and are rejected with 403.
    let method = request.method().clone();
    if matches!(method, Method::POST | Method::PUT | Method::DELETE | Method::PATCH)
        && let Some(origin) = request.headers().get("origin")
    {
        let origin_str = origin.to_str().unwrap_or("");
        let host = request
            .headers()
            .get("host")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");

        if !origin_matches_host(origin_str, host) {
            tracing::warn!(
                origin = %origin_str,
                host = %host,
                method = %method,
                path = %request.uri().path(),
                "CSRF: rejected cross-origin state-changing request"
            );
            return Err(StatusCode::FORBIDDEN);
        }
    }

    let is_api = request.uri().path().starts_with("/api/");

    let mut response = next.run(request).await;
    let headers = response.headers_mut();

    headers.insert(
        "X-Content-Type-Options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        "X-Frame-Options",
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        "Referrer-Policy",
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    // Only allow wss: when TLS is active; plain ws: only in unencrypted dev mode.
    let tls_active = state.config.tls_cert.is_some() && state.config.tls_key.is_some();
    let csp = if tls_active {
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
         img-src 'self' data:; connect-src 'self' wss:; font-src 'self'; \
         frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    } else {
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
         img-src 'self' data:; connect-src 'self' ws:; font-src 'self'; \
         frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    };
    headers.insert(
        "Content-Security-Policy",
        HeaderValue::from_str(csp).unwrap_or_else(|_| HeaderValue::from_static("default-src 'self'")),
    );
    headers.insert(
        "Permissions-Policy",
        HeaderValue::from_static(
            "camera=(), microphone=(), geolocation=(), payment=()"
        ),
    );
    if tls_active {
        headers.insert(
            "Strict-Transport-Security",
            HeaderValue::from_static("max-age=63072000; includeSubDomains"),
        );
    }
    if is_api {
        headers.insert(
            "Cache-Control",
            HeaderValue::from_static("no-store"),
        );
    }

    Ok(response)
}

/// Check whether an Origin header value matches the request Host.
///
/// Origin format: `https://example.com:9090` or `http://localhost:3000`
/// Host format:   `example.com:9090` or `localhost:3000`
pub fn origin_matches_host(origin: &str, host: &str) -> bool {
    let origin_host = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
        .unwrap_or(origin);

    let origin_host = origin_host.split('/').next().unwrap_or(origin_host);

    origin_host.eq_ignore_ascii_case(host)
}
