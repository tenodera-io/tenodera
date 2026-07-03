use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use rand_core::RngCore as _;
use sha2::{Digest, Sha256};
use tokio::sync::{RwLock, oneshot};

use tenodera_protocol::auth::build_challenge_payload;

use crate::hosts_config::HostEntry;

// ── Constants ────────────────────────────────────────────────────────────────

pub const CHALLENGE_DEADLINE: Duration = Duration::from_secs(10);
pub const PENDING_TIMEOUT: Duration = Duration::from_secs(86_400);
pub const MAX_PENDING: usize = 100;

// ── AuthenticatedAgent newtype ────────────────────────────────────────────────

/// Compile-time proof that a host passed the Ed25519 challenge-response handshake.
/// `agent_registry::register()` requires this — pending hosts cannot be accidentally
/// routed without triggering a build error.
pub struct AuthenticatedAgent {
    pub host: HostEntry,
    pub remote_ip: String,
}

// ── Signature verification ────────────────────────────────────────────────────

/// Verify an Ed25519 ChallengeResponse signature.
///
/// `pubkey_b64`  — base64(32B VerifyingKey) from Hello.public_key
/// `sig_b64`     — base64(64B signature) from ChallengeResponse.signature
/// `nonce_bytes` — raw 32-byte nonce (already decoded from base64)
pub fn verify_signature(
    pubkey_b64: &str,
    sig_b64: &str,
    nonce_bytes: &[u8; 32],
    hostname: &str,
    gateway_id: &str,
) -> bool {
    let pubkey_bytes = match base64::engine::general_purpose::STANDARD.decode(pubkey_b64) {
        Ok(b) if b.len() == 32 => b,
        _ => return false,
    };
    let pubkey_arr: [u8; 32] = pubkey_bytes.try_into().unwrap();
    let verifying_key = match VerifyingKey::from_bytes(&pubkey_arr) {
        Ok(k) => k,
        Err(_) => return false,
    };

    let sig_bytes = match base64::engine::general_purpose::STANDARD.decode(sig_b64) {
        Ok(b) if b.len() == 64 => b,
        _ => return false,
    };
    let sig_arr: [u8; 64] = sig_bytes.try_into().unwrap();
    let signature = Signature::from_bytes(&sig_arr);

    let payload = build_challenge_payload(nonce_bytes, hostname, gateway_id);
    verifying_key.verify_strict(&payload, &signature).is_ok()
}

/// Generate a fresh 32-byte nonce and return both raw bytes and base64 encoding.
pub fn generate_nonce() -> ([u8; 32], String) {
    let mut nonce = [0u8; 32];
    rand_core::OsRng.fill_bytes(&mut nonce);
    let b64 = base64::engine::general_purpose::STANDARD.encode(nonce);
    (nonce, b64)
}

/// Compute SHA-256 fingerprint of a public key (hex, 64 chars).
/// Used as a URL-safe key for the pending registry REST API.
pub fn pubkey_fingerprint_hex(pubkey_b64: &str) -> String {
    match base64::engine::general_purpose::STANDARD.decode(pubkey_b64) {
        Ok(bytes) => {
            let hash = Sha256::digest(&bytes);
            bytes_to_hex(&hash)
        }
        Err(_) => String::new(),
    }
}

/// SSH-style display fingerprint, e.g. `SHA256:abc123...`
pub fn pubkey_fingerprint_display(pubkey_b64: &str) -> String {
    match base64::engine::general_purpose::STANDARD.decode(pubkey_b64) {
        Ok(bytes) => {
            let hash = Sha256::digest(&bytes);
            let b64 = base64::engine::general_purpose::STANDARD_NO_PAD.encode(hash);
            format!("SHA256:{b64}")
        }
        Err(_) => "SHA256:invalid".to_string(),
    }
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Constant-time byte comparison — prevents timing attacks on token comparison.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ── Bootstrap token registry ──────────────────────────────────────────────────

pub struct BootstrapToken {
    pub id: String,
    /// Secret value agents present in Hello.bootstrap_token.
    pub value: String,
    pub single_use: bool,
    pub use_count: u32,
    pub max_uses: Option<u32>,
    pub expires_at: Instant,
    /// If Some, only agents with this exact hostname can use the token.
    pub bound_hostname: Option<String>,
    /// If true, replaces the public key of an already-enrolled host.
    pub re_enroll: bool,
}

impl BootstrapToken {
    pub fn is_expired(&self) -> bool {
        Instant::now() > self.expires_at
    }

    pub fn is_exhausted(&self) -> bool {
        if self.single_use && self.use_count > 0 {
            return true;
        }
        if let Some(max) = self.max_uses {
            if self.use_count >= max {
                return true;
            }
        }
        false
    }

    pub fn is_valid_for(&self, hostname: &str) -> bool {
        if self.is_expired() || self.is_exhausted() {
            return false;
        }
        if let Some(ref bound) = self.bound_hostname {
            if bound != hostname {
                return false;
            }
        }
        true
    }
}

#[derive(Clone)]
pub struct BootstrapRegistry {
    inner: Arc<RwLock<HashMap<String, BootstrapToken>>>,
}

impl BootstrapRegistry {
    pub fn new() -> Self {
        Self { inner: Arc::new(RwLock::new(HashMap::new())) }
    }

    /// Generate and store a new bootstrap token; return its ID and value.
    pub async fn create(
        &self,
        ttl: Duration,
        single_use: bool,
        max_uses: Option<u32>,
        bound_hostname: Option<String>,
        re_enroll: bool,
    ) -> (String, String) {
        let id = uuid::Uuid::new_v4().to_string();
        let mut value_bytes = [0u8; 32];
        rand_core::OsRng.fill_bytes(&mut value_bytes);
        let value = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value_bytes);

        let token = BootstrapToken {
            id: id.clone(),
            value: value.clone(),
            single_use,
            use_count: 0,
            max_uses,
            expires_at: Instant::now() + ttl,
            bound_hostname,
            re_enroll,
        };

        self.inner.write().await.insert(id.clone(), token);
        (id, value)
    }

    /// Check if a token value is valid for the given hostname; consume it if single-use.
    /// Returns the token's `re_enroll` flag if valid.
    pub async fn validate_and_consume(
        &self,
        token_value: &str,
        hostname: &str,
    ) -> Option<bool> {
        let mut guard = self.inner.write().await;
        let entry = guard.values_mut().find(|t| {
            constant_time_eq(t.value.as_bytes(), token_value.as_bytes())
        })?;

        if !entry.is_valid_for(hostname) {
            return None;
        }

        let re_enroll = entry.re_enroll;
        entry.use_count += 1;

        // Remove exhausted tokens
        if entry.is_exhausted() {
            let id = entry.id.clone();
            guard.remove(&id);
        }

        Some(re_enroll)
    }

    pub async fn list(&self) -> Vec<serde_json::Value> {
        let guard = self.inner.read().await;
        let now = Instant::now();
        guard
            .values()
            .map(|t| {
                let remaining_secs = t.expires_at.saturating_duration_since(now).as_secs();
                serde_json::json!({
                    "id": t.id,
                    "single_use": t.single_use,
                    "use_count": t.use_count,
                    "max_uses": t.max_uses,
                    "expires_in_secs": remaining_secs,
                    "bound_hostname": t.bound_hostname,
                    "re_enroll": t.re_enroll,
                    "expired": t.is_expired(),
                    "exhausted": t.is_exhausted(),
                })
            })
            .collect()
    }

    pub async fn revoke(&self, id: &str) -> bool {
        self.inner.write().await.remove(id).is_some()
    }

    /// Remove expired tokens — call periodically.
    pub async fn cleanup(&self) {
        let mut guard = self.inner.write().await;
        guard.retain(|_, t| !t.is_expired());
    }
}

// ── Pending agent registry ────────────────────────────────────────────────────

/// An agent that is connected but waiting for admin approval.
pub struct PendingEntry {
    pub hostname: String,
    pub pubkey_b64: String,
    pub fingerprint_hex: String,
    pub fingerprint_display: String,
    pub remote_ip: String,
    pub connected_at: Instant,
    pub os_id: Option<String>,
    pub(crate) approve_tx: Option<oneshot::Sender<HostEntry>>,
}

#[derive(Clone)]
pub struct PendingRegistry {
    inner: Arc<RwLock<HashMap<String, PendingEntry>>>,
}

impl PendingRegistry {
    pub fn new() -> Self {
        Self { inner: Arc::new(RwLock::new(HashMap::new())) }
    }

    /// Insert a pending agent. Returns false if the pending list is full (DoS prevention).
    pub async fn insert(
        &self,
        pubkey_b64: String,
        hostname: String,
        remote_ip: String,
        os_id: Option<String>,
        approve_tx: oneshot::Sender<HostEntry>,
    ) -> bool {
        let mut guard = self.inner.write().await;
        if guard.len() >= MAX_PENDING && !guard.contains_key(&pubkey_b64) {
            return false;
        }
        let fingerprint_hex = pubkey_fingerprint_hex(&pubkey_b64);
        let fingerprint_display = pubkey_fingerprint_display(&pubkey_b64);
        guard.insert(
            pubkey_b64.clone(),
            PendingEntry {
                hostname,
                pubkey_b64,
                fingerprint_hex,
                fingerprint_display,
                remote_ip,
                connected_at: Instant::now(),
                os_id,
                approve_tx: Some(approve_tx),
            },
        );
        true
    }

    pub async fn remove(&self, pubkey_b64: &str) {
        self.inner.write().await.remove(pubkey_b64);
    }

    /// Approve a pending agent by its fingerprint hex.
    /// Sends the completed HostEntry through the waiting WS handler's channel.
    pub async fn approve(&self, fingerprint_hex: &str, host: HostEntry) -> bool {
        let mut guard = self.inner.write().await;
        let pubkey = guard
            .values()
            .find(|e| e.fingerprint_hex == fingerprint_hex)
            .map(|e| e.pubkey_b64.clone());

        if let Some(key) = pubkey {
            if let Some(entry) = guard.remove(&key) {
                if let Some(tx) = entry.approve_tx {
                    return tx.send(host).is_ok();
                }
            }
        }
        false
    }

    pub async fn list(&self) -> Vec<serde_json::Value> {
        let guard = self.inner.read().await;
        guard
            .values()
            .map(|e| {
                serde_json::json!({
                    "hostname": e.hostname,
                    "fingerprint": e.fingerprint_display,
                    "fingerprint_hex": e.fingerprint_hex,
                    "remote_ip": e.remote_ip,
                    "waiting_secs": e.connected_at.elapsed().as_secs(),
                })
            })
            .collect()
    }

    /// Look up a pending entry's hostname by fingerprint hex.
    pub async fn hostname_for_fingerprint(&self, fingerprint_hex: &str) -> Option<String> {
        let guard = self.inner.read().await;
        guard
            .values()
            .find(|e| e.fingerprint_hex == fingerprint_hex)
            .map(|e| e.hostname.clone())
    }

    /// Look up a pending entry's raw public key (base64) by fingerprint hex.
    pub async fn pubkey_for_fingerprint(&self, fingerprint_hex: &str) -> Option<String> {
        let guard = self.inner.read().await;
        guard
            .values()
            .find(|e| e.fingerprint_hex == fingerprint_hex)
            .map(|e| e.pubkey_b64.clone())
    }

    /// Return (pubkey_b64, hostname, remote_ip, os_id) for a pending entry by fingerprint hex.
    pub async fn entry_for_fingerprint(
        &self,
        fingerprint_hex: &str,
    ) -> Option<(String, String, String, Option<String>)> {
        let guard = self.inner.read().await;
        guard
            .values()
            .find(|e| e.fingerprint_hex == fingerprint_hex)
            .map(|e| (e.pubkey_b64.clone(), e.hostname.clone(), e.remote_ip.clone(), e.os_id.clone()))
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{SigningKey, Signer};
    use rand_core::OsRng;
    use tenodera_protocol::auth::build_challenge_payload;

    fn make_key() -> SigningKey {
        SigningKey::generate(&mut OsRng)
    }

    fn sign_challenge(key: &SigningKey, nonce: &[u8; 32], hostname: &str, gw_id: &str) -> String {
        let payload = build_challenge_payload(nonce, hostname, gw_id);
        let sig = key.sign(&payload);
        base64::engine::general_purpose::STANDARD.encode(sig.to_bytes())
    }

    fn pubkey_b64(key: &SigningKey) -> String {
        base64::engine::general_purpose::STANDARD.encode(key.verifying_key().as_bytes())
    }

    // ── Test 1: correct signature verifies ───────────────────────────────────

    #[test]
    fn valid_signature_accepted() {
        let key = make_key();
        let (nonce, _) = generate_nonce();
        let sig_b64 = sign_challenge(&key, &nonce, "host1", "gw-uuid");
        assert!(verify_signature(&pubkey_b64(&key), &sig_b64, &nonce, "host1", "gw-uuid"));
    }

    // ── Test 2: nonce replay — same sig with different nonce is rejected ──────

    #[test]
    fn nonce_replay_rejected() {
        let key = make_key();
        let (nonce_a, _) = generate_nonce();
        let (nonce_b, _) = generate_nonce();
        // Sign with nonce_a, verify with nonce_b → must fail
        let sig = sign_challenge(&key, &nonce_a, "host1", "gw-uuid");
        assert!(!verify_signature(&pubkey_b64(&key), &sig, &nonce_b, "host1", "gw-uuid"));
    }

    // ── Test 3: known hostname + wrong pubkey is rejected ────────────────────
    // (This mirrors the Path 2 / ALERT path — the signature itself is valid
    //  for the new key, but the stored key is different → mismatch)

    #[test]
    fn wrong_pubkey_rejected() {
        let key_registered = make_key();
        let key_attacker = make_key();
        let (nonce, _) = generate_nonce();
        // Attacker signs correctly with their own key
        let sig = sign_challenge(&key_attacker, &nonce, "host1", "gw-uuid");
        // Verification must use the *registered* key — should fail
        assert!(!verify_signature(
            &pubkey_b64(&key_registered),
            &sig,
            &nonce,
            "host1",
            "gw-uuid"
        ));
    }

    // ── Test 4: bootstrap token single-use consumption ───────────────────────

    #[tokio::test]
    async fn single_use_token_consumed_on_first_use() {
        let reg = BootstrapRegistry::new();
        let (_id, value) = reg
            .create(Duration::from_secs(3600), true, None, None, false)
            .await;

        // First use → valid
        assert!(reg.validate_and_consume(&value, "any-host").await.is_some());
        // Second use → token removed, must fail
        assert!(reg.validate_and_consume(&value, "any-host").await.is_none());
    }

    // ── Test 5: re_enroll token is hostname-bound ─────────────────────────────

    #[tokio::test]
    async fn reenroll_token_rejected_for_wrong_hostname() {
        let reg = BootstrapRegistry::new();
        let (_id, value) = reg
            .create(
                Duration::from_secs(3600),
                false,
                None,
                Some("allowed-host".to_string()),
                true,
            )
            .await;

        // Correct hostname → accepted
        assert!(reg.validate_and_consume(&value, "allowed-host").await.is_some());
        // Wrong hostname → rejected
        assert!(reg.validate_and_consume(&value, "other-host").await.is_none());
    }
}
