//! Tenodera v2 wire protocol (ADR-0005).
//!
//! The single, typed contract between the server, the bridge, and the op-helper —
//! so operation validation and grant checking exist **once**, not re-derived from
//! `serde_json::Value` in three places. Every operation is a typed [`Operation`];
//! every privileged operation carries a signed [`ExecutionGrant`] that binds it to
//! a job, actor, host, argument hash, and deadline, so the helper can refuse
//! anything the control plane did not authorize.

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Bump on any breaking change to the wire structs.
pub const PROTOCOL_VERSION: u16 = 1;
/// Hard cap on a single frame read from a peer (defence against unbounded input).
pub const MAX_FRAME_BYTES: usize = 64 * 1024;

// ─────────────────────────── errors ───────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    InvalidArgument(&'static str),
    Malformed(String),
    TooLarge,
    UnsupportedVersion,
    BadSignature,
    Expired,
    GrantMismatch(&'static str),
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProtocolError::InvalidArgument(m) => write!(f, "invalid argument: {m}"),
            ProtocolError::Malformed(m) => write!(f, "malformed: {m}"),
            ProtocolError::TooLarge => write!(f, "frame too large"),
            ProtocolError::UnsupportedVersion => write!(f, "unsupported protocol version"),
            ProtocolError::BadSignature => write!(f, "bad grant signature"),
            ProtocolError::Expired => write!(f, "grant expired"),
            ProtocolError::GrantMismatch(m) => {
                write!(f, "grant does not authorize this request: {m}")
            }
        }
    }
}
impl std::error::Error for ProtocolError {}

// ─────────────────────────── operations ───────────────────────────

/// A systemd unit argument. Validation lives here so bridge and op-helper agree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceUnit {
    pub unit: String,
}

impl ServiceUnit {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        let u = &self.unit;
        let ok = !u.is_empty()
            && u.len() <= 256
            && u.bytes().all(|b| {
                b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'@' | b':' | b'-')
            });
        ok.then_some(())
            .ok_or(ProtocolError::InvalidArgument("invalid unit name"))
    }
}

/// The closed set of operations. Adding a variant is the ONLY way to widen what
/// the system can do — there is no free-form command path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "arguments")]
pub enum Operation {
    #[serde(rename = "service.status")]
    ServiceStatus(ServiceUnit),
    #[serde(rename = "service.start")]
    ServiceStart(ServiceUnit),
    #[serde(rename = "service.stop")]
    ServiceStop(ServiceUnit),
    #[serde(rename = "service.restart")]
    ServiceRestart(ServiceUnit),
}

impl Operation {
    pub fn key(&self) -> &'static str {
        match self {
            Operation::ServiceStatus(_) => "service.status",
            Operation::ServiceStart(_) => "service.start",
            Operation::ServiceStop(_) => "service.stop",
            Operation::ServiceRestart(_) => "service.restart",
        }
    }

    /// The RBAC permission required to request this operation.
    pub fn required_permission(&self) -> &'static str {
        match self {
            Operation::ServiceStatus(_) => "service.view",
            _ => "service.manage",
        }
    }

    /// A read runs as the operator; a mutation must go through the root op-helper.
    pub fn is_mutating(&self) -> bool {
        !matches!(self, Operation::ServiceStatus(_))
    }

    /// Disruptive operations demand fresh step-up re-auth (ADR-0004 Mode B).
    pub fn requires_step_up(&self) -> bool {
        matches!(
            self,
            Operation::ServiceStop(_) | Operation::ServiceRestart(_)
        )
    }

    pub fn validate(&self) -> Result<(), ProtocolError> {
        match self {
            Operation::ServiceStatus(u)
            | Operation::ServiceStart(u)
            | Operation::ServiceStop(u)
            | Operation::ServiceRestart(u) => u.validate(),
        }
    }

    /// Deterministic hash binding the exact operation + arguments — the value a
    /// grant commits to, so tampered arguments fail verification.
    pub fn hash(&self) -> [u8; 32] {
        let canon = serde_json::to_vec(self).expect("operation serializes");
        Sha256::digest(&canon).into()
    }
}

// ─────────────────────────── request / response ───────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationRequest {
    pub version: u16,
    pub request_id: Uuid,
    pub job_id: Uuid,
    /// Unix principal the bridge runs as / the op is attributed to.
    pub actor: String,
    /// Absolute deadline (unix seconds) after which the peer must not execute.
    pub deadline: i64,
    pub operation: Operation,
    /// Present for privileged operations; the op-helper requires it.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub grant: Option<ExecutionGrant>,
}

impl OperationRequest {
    pub fn check_version(&self) -> Result<(), ProtocolError> {
        (self.version == PROTOCOL_VERSION)
            .then_some(())
            .ok_or(ProtocolError::UnsupportedVersion)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Outcome {
    Succeeded { data: serde_json::Value },
    Failed { error_code: String, message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationResponse {
    pub version: u16,
    pub request_id: Uuid,
    pub job_id: Uuid,
    pub outcome: Outcome,
}

impl OperationResponse {
    pub fn succeeded(req: &OperationRequest, data: serde_json::Value) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            request_id: req.request_id,
            job_id: req.job_id,
            outcome: Outcome::Succeeded { data },
        }
    }
    pub fn failed(req: &OperationRequest, error_code: &str, message: &str) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            request_id: req.request_id,
            job_id: req.job_id,
            outcome: Outcome::Failed {
                error_code: error_code.to_string(),
                message: message.to_string(),
            },
        }
    }
}

// ─────────────────────────── execution grant ───────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthenticationLevel {
    Standard,
    StepUp,
}

/// A short-lived, control-plane-signed authorization for one privileged operation
/// on one host. The op-helper verifies this before doing anything, so possession
/// of the NOPASSWD sudoers rule is not by itself sufficient to act (ADR-0004/0005).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionGrant {
    pub version: u16,
    pub grant_id: Uuid,
    pub job_id: Uuid,
    pub actor: String,
    pub host_id: Uuid,
    /// Hex of `Operation::hash()` — binds the grant to exact arguments.
    pub operation_hash: String,
    pub issued_at: i64,
    pub expires_at: i64,
    pub nonce: String,
    pub authentication_level: AuthenticationLevel,
    /// Hex Ed25519 signature over [`ExecutionGrant::signing_bytes`].
    pub signature: String,
}

/// What the verifier must independently know to accept a grant (from the request
/// context), so a valid signature on the wrong job/host/args is still rejected.
pub struct GrantExpectation<'a> {
    pub job_id: Uuid,
    pub actor: &'a str,
    pub host_id: Uuid,
    pub operation_hash: [u8; 32],
}

impl ExecutionGrant {
    /// Canonical bytes covered by the signature — every field except the signature.
    fn signing_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!([
            self.version,
            self.grant_id,
            self.job_id,
            self.actor,
            self.host_id,
            self.operation_hash,
            self.issued_at,
            self.expires_at,
            self.nonce,
            self.authentication_level,
        ]))
        .expect("grant serializes")
    }

    /// Issue and sign a grant for `operation` on `host_id`, valid for `ttl_secs`.
    #[allow(clippy::too_many_arguments)]
    pub fn issue(
        signing_key: &SigningKey,
        job_id: Uuid,
        actor: &str,
        host_id: Uuid,
        operation: &Operation,
        level: AuthenticationLevel,
        now: i64,
        ttl_secs: i64,
    ) -> Self {
        let mut nonce = [0u8; 32];
        getrandom::fill(&mut nonce).expect("OS RNG");
        let mut g = ExecutionGrant {
            version: PROTOCOL_VERSION,
            grant_id: Uuid::new_v4(),
            job_id,
            actor: actor.to_string(),
            host_id,
            operation_hash: to_hex(&operation.hash()),
            issued_at: now,
            expires_at: now + ttl_secs,
            nonce: to_hex(&nonce),
            authentication_level: level,
            signature: String::new(),
        };
        let sig = signing_key.sign(&g.signing_bytes());
        g.signature = to_hex(&sig.to_bytes());
        g
    }

    /// Verify signature, version, expiry, and that the grant authorizes exactly
    /// this request. Replay defence (single-use `grant_id`) is the caller's job —
    /// it needs shared state this stateless check cannot hold.
    pub fn verify(
        &self,
        verifying_key: &VerifyingKey,
        now: i64,
        expect: &GrantExpectation,
    ) -> Result<(), ProtocolError> {
        if self.version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedVersion);
        }
        let sig_bytes: [u8; 64] = from_hex(&self.signature)?
            .try_into()
            .map_err(|_| ProtocolError::BadSignature)?;
        let signature = Signature::from_bytes(&sig_bytes);
        verifying_key
            .verify(&self.signing_bytes(), &signature)
            .map_err(|_| ProtocolError::BadSignature)?;

        if now > self.expires_at || self.issued_at > now + CLOCK_SKEW_SECS {
            return Err(ProtocolError::Expired);
        }
        if self.job_id != expect.job_id {
            return Err(ProtocolError::GrantMismatch("job_id"));
        }
        if self.actor != expect.actor {
            return Err(ProtocolError::GrantMismatch("actor"));
        }
        if self.host_id != expect.host_id {
            return Err(ProtocolError::GrantMismatch("host_id"));
        }
        if from_hex(&self.operation_hash)? != expect.operation_hash {
            return Err(ProtocolError::GrantMismatch("operation_hash"));
        }
        Ok(())
    }
}

/// Tolerated clock skew between control plane and host for grant timing.
const CLOCK_SKEW_SECS: i64 = 30;

// ─────────────────────────── hex helpers (no dep) ───────────────────────────

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(s: &str) -> Result<Vec<u8>, ProtocolError> {
    if !s.len().is_multiple_of(2) {
        return Err(ProtocolError::Malformed("odd-length hex".into()));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&s[i..i + 2], 16)
                .map_err(|_| ProtocolError::Malformed("bad hex".into()))
        })
        .collect()
}

// ─────────────────────────── tests ───────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> SigningKey {
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).unwrap();
        SigningKey::from_bytes(&seed)
    }

    fn op() -> Operation {
        Operation::ServiceRestart(ServiceUnit {
            unit: "nginx.service".into(),
        })
    }

    #[test]
    fn request_roundtrips() {
        let req = OperationRequest {
            version: PROTOCOL_VERSION,
            request_id: Uuid::new_v4(),
            job_id: Uuid::new_v4(),
            actor: "tnd-op".into(),
            deadline: 1_000,
            operation: op(),
            grant: None,
        };
        let s = serde_json::to_string(&req).unwrap();
        let back: OperationRequest = serde_json::from_str(&s).unwrap();
        assert_eq!(back.operation, req.operation);
        assert!(s.contains("service.restart"));
    }

    #[test]
    fn unit_validation_rejects_metachars() {
        assert!(ServiceUnit {
            unit: "sshd.service".into()
        }
        .validate()
        .is_ok());
        assert!(ServiceUnit {
            unit: "x; reboot".into()
        }
        .validate()
        .is_err());
        assert!(ServiceUnit {
            unit: String::new()
        }
        .validate()
        .is_err());
    }

    #[test]
    fn operation_hash_is_stable_and_arg_sensitive() {
        assert_eq!(op().hash(), op().hash());
        let other = Operation::ServiceRestart(ServiceUnit {
            unit: "apache.service".into(),
        });
        assert_ne!(op().hash(), other.hash());
        // same args, different verb must differ too
        let started = Operation::ServiceStart(ServiceUnit {
            unit: "nginx.service".into(),
        });
        assert_ne!(op().hash(), started.hash());
    }

    fn expectation(job: Uuid, host: Uuid, o: &Operation) -> GrantExpectation<'static> {
        GrantExpectation {
            job_id: job,
            actor: "tnd-op",
            host_id: host,
            operation_hash: o.hash(),
        }
    }

    #[test]
    fn grant_signs_and_verifies() {
        let sk = key();
        let (job, host) = (Uuid::new_v4(), Uuid::new_v4());
        let g = ExecutionGrant::issue(
            &sk,
            job,
            "tnd-op",
            host,
            &op(),
            AuthenticationLevel::StepUp,
            100,
            120,
        );
        assert!(g
            .verify(&sk.verifying_key(), 150, &expectation(job, host, &op()))
            .is_ok());
    }

    #[test]
    fn grant_rejects_wrong_key_expiry_and_tamper() {
        let sk = key();
        let vk = sk.verifying_key();
        let (job, host) = (Uuid::new_v4(), Uuid::new_v4());
        let g = ExecutionGrant::issue(
            &sk,
            job,
            "tnd-op",
            host,
            &op(),
            AuthenticationLevel::StepUp,
            100,
            120,
        );

        // wrong signer
        assert_eq!(
            g.verify(&key().verifying_key(), 150, &expectation(job, host, &op())),
            Err(ProtocolError::BadSignature)
        );
        // past deadline
        assert_eq!(
            g.verify(&vk, 999, &expectation(job, host, &op())),
            Err(ProtocolError::Expired)
        );
        // signature valid but authorizes different arguments
        let other = Operation::ServiceRestart(ServiceUnit {
            unit: "apache.service".into(),
        });
        assert_eq!(
            g.verify(&vk, 150, &expectation(job, host, &other)),
            Err(ProtocolError::GrantMismatch("operation_hash"))
        );
        // wrong host
        assert_eq!(
            g.verify(&vk, 150, &expectation(job, Uuid::new_v4(), &op())),
            Err(ProtocolError::GrantMismatch("host_id"))
        );
        // flipped signature byte
        let mut bad = g.clone();
        bad.signature.replace_range(
            0..2,
            if &bad.signature[0..2] == "00" {
                "01"
            } else {
                "00"
            },
        );
        assert_eq!(
            bad.verify(&vk, 150, &expectation(job, host, &op())),
            Err(ProtocolError::BadSignature)
        );
    }
}
