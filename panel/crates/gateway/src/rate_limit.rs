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

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;

    fn ip(s: &str) -> IpAddr { s.parse().unwrap() }

    #[tokio::test]
    async fn not_limited_below_threshold() {
        let rl = LoginRateLimiter::new(3, 60);
        let addr = ip("1.2.3.4");
        assert!(!rl.check_and_record(addr).await);
        assert!(!rl.check_and_record(addr).await);
        assert!(!rl.is_limited(addr).await);
    }

    #[tokio::test]
    async fn limited_at_threshold() {
        let rl = LoginRateLimiter::new(3, 60);
        let addr = ip("1.2.3.5");
        rl.check_and_record(addr).await;
        rl.check_and_record(addr).await;
        rl.check_and_record(addr).await;
        assert!(rl.is_limited(addr).await);
    }

    #[tokio::test]
    async fn check_and_record_returns_true_when_limited() {
        let rl = LoginRateLimiter::new(2, 60);
        let addr = ip("1.2.3.6");
        assert!(!rl.check_and_record(addr).await);
        assert!(!rl.check_and_record(addr).await);
        // third call: already at limit, should return true without adding
        assert!(rl.check_and_record(addr).await);
    }

    #[tokio::test]
    async fn different_ips_independent() {
        let rl = LoginRateLimiter::new(2, 60);
        let a = ip("10.0.0.1");
        let b = ip("10.0.0.2");
        rl.check_and_record(a).await;
        rl.check_and_record(a).await;
        assert!(rl.is_limited(a).await);
        assert!(!rl.is_limited(b).await);
    }

    #[tokio::test]
    async fn entries_expire_after_window() {
        let rl = LoginRateLimiter::new(2, 1); // 1-second window
        let addr = ip("1.2.3.7");
        rl.check_and_record(addr).await;
        rl.check_and_record(addr).await;
        assert!(rl.is_limited(addr).await);
        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert!(!rl.is_limited(addr).await);
    }

    #[tokio::test]
    async fn cleanup_removes_stale_ips() {
        let rl = LoginRateLimiter::new(2, 1);
        let addr = ip("1.2.3.8");
        rl.check_and_record(addr).await;
        tokio::time::sleep(Duration::from_millis(1100)).await;
        rl.cleanup().await;
        let map = rl.attempts.lock().await;
        assert!(!map.contains_key(&addr), "stale entry not cleaned up");
    }
}
