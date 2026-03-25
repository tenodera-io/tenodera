use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

/// Sliding-window rate limiter for login attempts.
///
/// Tracks failed attempts per IP address within a configurable window.
/// Successful logins do not consume rate limit budget.
#[derive(Clone)]
pub struct LoginRateLimiter {
    /// IP -> list of failed attempt timestamps within the window.
    attempts: Arc<Mutex<HashMap<IpAddr, Vec<Instant>>>>,
    /// Maximum failed attempts allowed within the window.
    max_attempts: usize,
    /// Sliding window duration.
    window: Duration,
}

impl LoginRateLimiter {
    pub fn new(max_attempts: usize, window_secs: u64) -> Self {
        Self {
            attempts: Arc::new(Mutex::new(HashMap::new())),
            max_attempts,
            window: Duration::from_secs(window_secs),
        }
    }

    /// Check whether the given IP is currently rate-limited.
    /// Returns `true` if the request should be **rejected**.
    pub async fn is_limited(&self, ip: IpAddr) -> bool {
        let mut map = self.attempts.lock().await;
        let now = Instant::now();

        if let Some(times) = map.get_mut(&ip) {
            times.retain(|t| now.duration_since(*t) < self.window);
            times.len() >= self.max_attempts
        } else {
            false
        }
    }

    /// Record a failed login attempt for the given IP.
    pub async fn record_failure(&self, ip: IpAddr) {
        let mut map = self.attempts.lock().await;
        let now = Instant::now();
        let times = map.entry(ip).or_default();
        times.retain(|t| now.duration_since(*t) < self.window);
        times.push(now);
    }

    /// Remove all tracked attempts for an IP (e.g. after successful login).
    pub async fn clear(&self, ip: IpAddr) {
        let mut map = self.attempts.lock().await;
        map.remove(&ip);
    }

    /// Periodic cleanup of stale entries. Call from a background task.
    pub async fn cleanup(&self) {
        let mut map = self.attempts.lock().await;
        let now = Instant::now();
        map.retain(|_ip, times| {
            times.retain(|t| now.duration_since(*t) < self.window);
            !times.is_empty()
        });
    }
}
