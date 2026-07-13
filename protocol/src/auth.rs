/// Domain-separated payload for Ed25519 challenge signing.
///
/// Layout: `"tenodera-agent-auth-v1\0" || nonce(32B) || u16_be(len(hostname)) || hostname
///          || u16_be(len(gateway_id)) || gateway_id`
///
/// Gateway reconstructs this from its own state — the agent sends only the signature.
pub fn build_challenge_payload(
    nonce_bytes: &[u8; 32],
    hostname: &str,
    gateway_id: &str,
) -> Vec<u8> {
    let mut payload = Vec::with_capacity(23 + 32 + 2 + hostname.len() + 2 + gateway_id.len());
    payload.extend_from_slice(b"tenodera-agent-auth-v1\0");
    payload.extend_from_slice(nonce_bytes);
    let hn = hostname.as_bytes();
    payload.extend_from_slice(&(hn.len() as u16).to_be_bytes());
    payload.extend_from_slice(hn);
    let gid = gateway_id.as_bytes();
    payload.extend_from_slice(&(gid.len() as u16).to_be_bytes());
    payload.extend_from_slice(gid);
    payload
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_structure() {
        let nonce = [0xAAu8; 32];
        let payload = build_challenge_payload(&nonce, "srv01", "test-gid");
        // Domain prefix
        assert!(payload.starts_with(b"tenodera-agent-auth-v1\0"));
        // Nonce
        assert_eq!(&payload[23..55], &nonce);
        // Hostname length prefix (u16_be for "srv01" = 5)
        assert_eq!(payload[55], 0);
        assert_eq!(payload[56], 5);
        // Hostname
        assert_eq!(&payload[57..62], b"srv01");
    }
}
