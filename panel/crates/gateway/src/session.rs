use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use uuid::Uuid;

/// User role — determines what operations are permitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// Full access including write/administrative operations.
    Admin,
    /// Read-only access — write operations are rejected by agent handlers.
    Readonly,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Admin => "admin",
            Role::Readonly => "readonly",
        }
    }
}

/// A live user session.
///
/// SSH connections to managed hosts use the gateway's Ed25519 key
/// (/etc/tenodera/id_ed25519), so the user password is no longer stored
/// in the session. Sudo password is provided per-operation by the UI.
#[derive(Clone)]
pub struct Session {
    pub id: String,
    pub user: String,
    pub role: Role,
    pub created_at: std::time::Instant,
    pub last_activity: std::time::Instant,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The id is a bearer token — never render it, even in Debug/logs.
        f.debug_struct("Session")
            .field("id", &"[REDACTED]")
            .field("user", &self.user)
            .field("role", &self.role)
            .field("created_at", &self.created_at)
            .field("last_activity", &self.last_activity)
            .finish()
    }
}

/// Thread-safe in-memory session store.
#[derive(Debug, Clone)]
pub struct SessionStore {
    inner: Arc<RwLock<HashMap<String, Session>>>,
    idle_timeout_secs: u64,
    /// Hard upper bound on session age regardless of activity (seconds).
    max_lifetime_secs: u64,
}

/// Maximum absolute session lifetime: 4 hours.
const DEFAULT_MAX_LIFETIME_SECS: u64 = 4 * 3600;

impl SessionStore {
    pub fn new(idle_timeout_secs: u64) -> Self {
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
            idle_timeout_secs,
            max_lifetime_secs: DEFAULT_MAX_LIFETIME_SECS,
        }
    }

    pub async fn create(&self, user: String, role: Role) -> Session {
        let now = std::time::Instant::now();
        let session = Session {
            id: Uuid::new_v4().to_string(),
            user,
            role,
            created_at: now,
            last_activity: now,
        };
        self.inner
            .write()
            .await
            .insert(session.id.clone(), session.clone());
        session
    }

    pub async fn get(&self, id: &str) -> Option<Session> {
        self.inner.read().await.get(id).cloned()
    }

    /// Fetch a session **only if it is still valid**, refreshing its activity.
    ///
    /// Unlike [`get`], expiry (idle timeout **and** absolute lifetime) is checked
    /// inline and an expired session is removed and rejected — so a session is
    /// never accepted in the window between its expiry and the next reaper pass.
    /// All authorization paths must use this, not `get`.
    pub async fn get_valid(&self, id: &str) -> Option<Session> {
        let mut map = self.inner.write().await;
        let session = map.get_mut(id)?;
        let idle_ok = session.last_activity.elapsed().as_secs() <= self.idle_timeout_secs;
        let age_ok = session.created_at.elapsed().as_secs() <= self.max_lifetime_secs;
        if !(idle_ok && age_ok) {
            map.remove(id);
            return None;
        }
        session.last_activity = std::time::Instant::now();
        Some(session.clone())
    }

    /// Update last_activity timestamp for the given session.
    pub async fn touch(&self, id: &str) {
        if let Some(session) = self.inner.write().await.get_mut(id) {
            session.last_activity = std::time::Instant::now();
        }
    }

    pub async fn remove(&self, id: &str) {
        self.inner.write().await.remove(id);
    }

    pub async fn count(&self) -> usize {
        self.inner.read().await.len()
    }

    /// Remove sessions that have been idle too long **or** exceeded the
    /// absolute lifetime cap.  Dropped sessions have their passwords
    /// zeroized via `Drop`.
    pub async fn reap_expired(&self) -> usize {
        let mut map = self.inner.write().await;
        let before = map.len();
        map.retain(|_id, session| {
            let idle_ok = session.last_activity.elapsed().as_secs() <= self.idle_timeout_secs;
            let age_ok = session.created_at.elapsed().as_secs() <= self.max_lifetime_secs;
            idle_ok && age_ok
        });
        before - map.len()
    }

    /// Spawn a background task that periodically reaps expired sessions.
    pub fn spawn_reaper(self) -> tokio::task::JoinHandle<()> {
        let interval = std::time::Duration::from_secs(60);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(interval);
            loop {
                tick.tick().await;
                let reaped = self.reap_expired().await;
                if reaped > 0 {
                    tracing::info!(reaped, "expired sessions cleaned up");
                }
            }
        })
    }

    #[cfg(test)]
    pub fn new_with_max_lifetime(idle_timeout_secs: u64, max_lifetime_secs: u64) -> Self {
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
            idle_timeout_secs,
            max_lifetime_secs,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn create_and_get() {
        let store = SessionStore::new(900);
        let session = store.create("alice".into(), Role::Admin).await;
        let fetched = store.get(&session.id).await.unwrap();
        assert_eq!(fetched.user, "alice");
    }

    #[tokio::test]
    async fn remove_session() {
        let store = SessionStore::new(900);
        let s = store.create("bob".into(), Role::Admin).await;
        store.remove(&s.id).await;
        assert!(store.get(&s.id).await.is_none());
    }

    #[tokio::test]
    async fn get_missing_returns_none() {
        let store = SessionStore::new(900);
        assert!(store.get("nonexistent").await.is_none());
    }

    #[tokio::test]
    async fn reap_expired_idle() {
        let store = SessionStore::new_with_max_lifetime(0, 86400);
        store.create("idle_user".into(), Role::Readonly).await;
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        let reaped = store.reap_expired().await;
        assert_eq!(reaped, 1);
        let map = store.inner.read().await;
        assert!(map.is_empty());
    }

    #[tokio::test]
    async fn active_session_not_reaped() {
        let store = SessionStore::new(900);
        let s = store.create("active".into(), Role::Admin).await;
        let reaped = store.reap_expired().await;
        assert_eq!(reaped, 0);
        assert!(store.get(&s.id).await.is_some());
    }

    #[tokio::test]
    async fn reap_expired_max_lifetime() {
        let store = SessionStore::new_with_max_lifetime(900, 0);
        store.create("old_user".into(), Role::Admin).await;
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        let reaped = store.reap_expired().await;
        assert_eq!(reaped, 1);
    }

    #[tokio::test]
    async fn count_reflects_active_sessions() {
        let store = SessionStore::new(900);
        assert_eq!(store.count().await, 0);
        store.create("u1".into(), Role::Admin).await;
        store.create("u2".into(), Role::Readonly).await;
        assert_eq!(store.count().await, 2);
    }

    #[test]
    fn role_serializes_to_lowercase() {
        assert_eq!(serde_json::to_string(&Role::Admin).unwrap(), r#""admin""#);
        assert_eq!(
            serde_json::to_string(&Role::Readonly).unwrap(),
            r#""readonly""#
        );
    }

    #[test]
    fn role_deserializes_from_lowercase() {
        let admin: Role = serde_json::from_str(r#""admin""#).unwrap();
        assert_eq!(admin, Role::Admin);
        let ro: Role = serde_json::from_str(r#""readonly""#).unwrap();
        assert_eq!(ro, Role::Readonly);
    }

    #[tokio::test]
    async fn touch_extends_idle_timeout() {
        let store = SessionStore::new_with_max_lifetime(1, 3600);
        let s = store.create("user".into(), Role::Admin).await;
        tokio::time::sleep(std::time::Duration::from_millis(900)).await;
        store.touch(&s.id).await;
        tokio::time::sleep(std::time::Duration::from_millis(900)).await;
        let reaped = store.reap_expired().await;
        assert_eq!(reaped, 0);
    }
}
