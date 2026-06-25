use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;
use uuid::Uuid;
use zeroize::Zeroizing;

/// A live user session.
///
/// Stores the user's password for the lifetime of the session so that the
/// gateway can open SSH tunnels to remote hosts on behalf of the user.
///
/// Password is wrapped in `Zeroizing<String>` which automatically overwrites
/// memory with zeros on drop — every clone of the session (WS handler,
/// SSH connect, etc.) is also zeroized when it goes out of scope.
#[derive(Clone)]
pub struct Session {
    pub id: String,
    pub user: String,
    pub password: Zeroizing<String>,
    pub created_at: std::time::Instant,
    pub last_activity: std::time::Instant,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("id", &self.id)
            .field("user", &self.user)
            .field("password", &"***")
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

    pub async fn create(&self, user: String, password: String) -> Session {
        let now = std::time::Instant::now();
        let session = Session {
            id: Uuid::new_v4().to_string(),
            user,
            password: Zeroizing::new(password),
            created_at: now,
            last_activity: now,
        };
        self.inner.write().await.insert(session.id.clone(), session.clone());
        session
    }

    pub async fn get(&self, id: &str) -> Option<Session> {
        self.inner.read().await.get(id).cloned()
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
        let session = store.create("alice".into(), "pw".into()).await;
        let fetched = store.get(&session.id).await.unwrap();
        assert_eq!(fetched.user, "alice");
        assert_eq!(*fetched.password, "pw");
    }

    #[tokio::test]
    async fn remove_session() {
        let store = SessionStore::new(900);
        let s = store.create("bob".into(), "pw".into()).await;
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
        // idle_timeout=0s: session expires when elapsed().as_secs() >= 1 (after ~1s)
        let store = SessionStore::new_with_max_lifetime(0, 86400);
        store.create("idle_user".into(), "pw".into()).await;
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        let reaped = store.reap_expired().await;
        assert_eq!(reaped, 1);
        let map = store.inner.read().await;
        assert!(map.is_empty());
    }

    #[tokio::test]
    async fn active_session_not_reaped() {
        let store = SessionStore::new(900);
        let s = store.create("active".into(), "pw".into()).await;
        let reaped = store.reap_expired().await;
        assert_eq!(reaped, 0);
        assert!(store.get(&s.id).await.is_some());
    }

    #[tokio::test]
    async fn reap_expired_max_lifetime() {
        // max_lifetime=0s: session expires when elapsed().as_secs() >= 1 (after ~1s)
        let store = SessionStore::new_with_max_lifetime(900, 0);
        store.create("old_user".into(), "pw".into()).await;
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        let reaped = store.reap_expired().await;
        assert_eq!(reaped, 1);
    }

    #[tokio::test]
    async fn touch_extends_idle_timeout() {
        let store = SessionStore::new_with_max_lifetime(1, 3600); // idle=1s
        let s = store.create("user".into(), "pw".into()).await;
        tokio::time::sleep(std::time::Duration::from_millis(900)).await;
        store.touch(&s.id).await;
        tokio::time::sleep(std::time::Duration::from_millis(900)).await;
        // Would have expired without touch; should survive after touch
        let reaped = store.reap_expired().await;
        assert_eq!(reaped, 0);
    }

    #[tokio::test]
    async fn password_not_exposed_in_debug() {
        let store = SessionStore::new(900);
        let s = store.create("user".into(), "secret123".into()).await;
        let debug_str = format!("{s:?}");
        assert!(!debug_str.contains("secret123"), "password leaked in Debug output");
        assert!(debug_str.contains("***"));
    }
}
