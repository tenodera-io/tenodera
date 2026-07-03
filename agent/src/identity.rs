use std::io::Write as _;
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};

use anyhow::Context as _;
use base64::Engine as _;
use ed25519_dalek::{Signer as _, SigningKey};
use rand_core::OsRng;
use sha2::{Digest, Sha256};

const KEY_PATH: &str = "/var/lib/tenodera/agent.key";
const GATEWAY_ID_PATH: &str = "/var/lib/tenodera/gateway-id";
const DATA_DIR: &str = "/var/lib/tenodera";

pub struct AgentIdentity {
    signing_key: SigningKey,
}

impl AgentIdentity {
    pub fn load_or_create() -> anyhow::Result<Self> {
        if let Ok(bytes) = std::fs::read(KEY_PATH) {
            if bytes.len() == 32 {
                let arr: [u8; 32] = bytes.try_into().unwrap();
                let id = Self { signing_key: SigningKey::from_bytes(&arr) };
                tracing::info!(fingerprint = %id.fingerprint(), "loaded existing agent identity");
                return Ok(id);
            }
            anyhow::bail!(
                "agent key at {KEY_PATH} is corrupt (expected 32 bytes, got {})",
                bytes.len()
            );
        }

        // Generate new keypair
        let signing_key = SigningKey::generate(&mut OsRng);

        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(DATA_DIR)
            .with_context(|| format!("create {DATA_DIR}"))?;

        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(KEY_PATH)
            .with_context(|| format!("create {KEY_PATH}"))?;
        file.write_all(&signing_key.to_bytes())
            .with_context(|| format!("write {KEY_PATH}"))?;
        file.sync_all()?;

        let id = Self { signing_key };
        tracing::info!(fingerprint = %id.fingerprint(), "generated new agent identity");
        Ok(id)
    }

    pub fn public_key_b64(&self) -> String {
        base64::engine::general_purpose::STANDARD
            .encode(self.signing_key.verifying_key().as_bytes())
    }

    /// SSH-style SHA256 fingerprint, e.g. `SHA256:abc123...`
    pub fn fingerprint(&self) -> String {
        let hash = Sha256::digest(self.signing_key.verifying_key().as_bytes());
        let b64 = base64::engine::general_purpose::STANDARD_NO_PAD.encode(hash);
        format!("SHA256:{b64}")
    }

    pub fn sign(&self, payload: &[u8]) -> Vec<u8> {
        self.signing_key.sign(payload).to_bytes().to_vec()
    }

    /// Load the pinned gateway_id from disk (None if not yet enrolled).
    pub fn load_gateway_id(&self) -> anyhow::Result<Option<String>> {
        match std::fs::read_to_string(GATEWAY_ID_PATH) {
            Ok(s) => {
                let s = s.trim().to_string();
                if s.is_empty() { Ok(None) } else { Ok(Some(s)) }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Persist the gateway_id pin (called on first enrollment).
    pub fn save_gateway_id(&self, gateway_id: &str) -> anyhow::Result<()> {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(DATA_DIR)?;
        std::fs::write(GATEWAY_ID_PATH, gateway_id.as_bytes())?;
        Ok(())
    }
}
