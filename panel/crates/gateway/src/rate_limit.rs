use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

/// Sliding-window rate limiter for login attempts.
///
/// Tracks failed attempts per IP address within a configurable window.
/// Failed attempts accumulate and expire naturally after the window duration.
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

    /// Atomically check rate limit and record a failure in one lock acquisition.
    /// Returns `true` if the IP is rate-limited (request should be rejected).
    /// If not limited, records the failure timestamp before releasing the lock,
    /// eliminating the TOCTOU race between is_limited() and record_failure().
    pub async fn check_and_record(&self, ip: IpAddr) -> bool {
        let mut map = self.attempts.lock().await;
        let now = Instant::now();
        let times = map.entry(ip).or_default();
        times.retain(|t| now.duration_since(*t) < self.window);

        if times.len() >= self.max_attempts {
            return true; // already limited
        }

        times.push(now); // record failure atomically
        false
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
