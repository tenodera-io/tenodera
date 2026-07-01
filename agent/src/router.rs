use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{mpsc, watch};

use tenodera_protocol::channel::{ChannelId, ChannelOpenOptions};
use tenodera_protocol::message::Message;

use crate::handler::ChannelHandler;
use crate::handlers::{certs, containers, cron, disk_usage, dns, file_list, hardware_info, host_config, hosts, journal_query, kdump, log_files, metrics_snapshot, metrics_stream, network_stats, networking, networking_snapshot, packages, storage, storage_snapshot, superuser_verify, system_info, system_pubkey, systemd_timers, systemd_units, terminal_pty, top_processes, users};

/// Active streaming channel state.
struct ActiveChannel {
    shutdown_tx: watch::Sender<bool>,
    handler: Arc<dyn ChannelHandler>,
}

/// Routes incoming messages to the correct ChannelHandler based on payload type.
pub struct Router {
    handlers: HashMap<String, Arc<dyn ChannelHandler>>,
    active_channels: HashMap<ChannelId, ActiveChannel>,
    /// Maps channel id → handler (for non-streaming channels that received Open).
    channel_handlers: HashMap<ChannelId, Arc<dyn ChannelHandler>>,
    /// Maps channel id → open options (for injecting context into Data messages).
    channel_options: HashMap<ChannelId, ChannelOpenOptions>,
    /// Sender for outgoing messages (agent → gateway).
    out_tx: mpsc::Sender<Message>,
}

impl Router {
    pub fn new(out_tx: mpsc::Sender<Message>) -> Self {
        Self {
            handlers: HashMap::new(),
            active_channels: HashMap::new(),
            channel_handlers: HashMap::new(),
            channel_options: HashMap::new(),
            out_tx,
        }
    }

    pub fn register(&mut self, handler: Arc<dyn ChannelHandler>) {
        self.handlers.insert(handler.payload_type().to_string(), handler);
    }

    /// Register built-in handlers for MVP payloads.
    pub fn register_defaults(&mut self) {
        self.register(Arc::new(system_info::SystemInfoHandler));
        self.register(Arc::new(system_pubkey::SystemPubkeyHandler));
        self.register(Arc::new(host_config::HostConfigHandler));
        self.register(Arc::new(host_config::HostActionHandler));
        self.register(Arc::new(systemd_units::SystemdUnitsHandler));
        self.register(Arc::new(systemd_units::SystemdManageHandler));
        self.register(Arc::new(file_list::FileListHandler));
        self.register(Arc::new(journal_query::JournalQueryHandler));
        self.register(Arc::new(terminal_pty::TerminalPtyHandler::new()));
        self.register(Arc::new(metrics_stream::MetricsStreamHandler));
        self.register(Arc::new(disk_usage::DiskUsageHandler));
        self.register(Arc::new(network_stats::NetworkStatsHandler));
        self.register(Arc::new(containers::ContainersHandler));
        self.register(Arc::new(storage::StorageStreamHandler));
        self.register(Arc::new(superuser_verify::SuperuserVerifyHandler));
        self.register(Arc::new(networking::NetworkStreamHandler));
        self.register(Arc::new(networking::NetworkManageHandler));
        self.register(Arc::new(packages::PackagesHandler));
        self.register(Arc::new(hardware_info::HardwareInfoHandler));
        self.register(Arc::new(top_processes::TopProcessesHandler));
        self.register(Arc::new(hosts::HostsManageHandler));
        self.register(Arc::new(kdump::KdumpInfoHandler));
        self.register(Arc::new(log_files::LogFilesHandler));
        self.register(Arc::new(users::UsersManageHandler));
        self.register(Arc::new(metrics_snapshot::MetricsSnapshotHandler));
        self.register(Arc::new(networking_snapshot::NetworkingSnapshotHandler));
        self.register(Arc::new(storage_snapshot::StorageSnapshotHandler));
        self.register(Arc::new(cron::CronListHandler));
        self.register(Arc::new(cron::CronManageHandler));
        self.register(Arc::new(systemd_timers::SystemdTimersHandler));
        self.register(Arc::new(dns::DnsInfoHandler));
        self.register(Arc::new(dns::DnsManageHandler));
        self.register(Arc::new(dns::DnsLookupHandler));
        self.register(Arc::new(dns::DnsResolvedInfoHandler));
        self.register(Arc::new(dns::DnsResolvedManageHandler));
        self.register(Arc::new(certs::CertsListHandler));
        self.register(Arc::new(certs::CertsManageHandler));
        self.register(Arc::new(certs::CertsSelfSignedHandler));
        self.register(Arc::new(certs::CertsLetsEncryptHandler));
    }

    /// Route a single message. Returns immediate responses and may spawn
    /// background tasks for streaming channels.
    pub async fn handle(&mut self, msg: Message) -> Vec<Message> {
        match msg {
            Message::Open { channel, options } => {
                if let Some(handler) = self.handlers.get(&options.payload).cloned() {
                    if handler.is_streaming() {
                        // Spawn streaming channel as background task
                        let (shutdown_tx, shutdown_rx) = watch::channel(false);
                        self.active_channels.insert(
                            channel.clone(),
                            ActiveChannel { shutdown_tx, handler: handler.clone() },
                        );

                        let out_tx = self.out_tx.clone();
                        let ch = channel.clone();
                        let opts = options.clone();
                        tokio::spawn(async move {
                            // Send Ready first
                            let _ = out_tx
                                .send(Message::Ready { channel: ch.clone() })
                                .await;
                            handler.stream(&ch, &opts, out_tx.clone(), shutdown_rx).await;
                        });
                        vec![]
                    } else {
                        // Track handler and options for this channel (for future data() calls)
                        self.channel_handlers.insert(channel.clone(), handler.clone());
                        self.channel_options.insert(channel.clone(), options.clone());
                        handler.open(&channel, &options).await
                    }
                } else {
                    tracing::warn!(payload = %options.payload, "no handler registered");
                    vec![Message::Close {
                        channel,
                        problem: Some(format!("unknown-payload: {}", options.payload)),
                    }]
                }
            }
            Message::Data { channel, data } => {
                // Look up handler: first in active streaming channels, then one-shot
                let handler = self
                    .active_channels
                    .get(&channel)
                    .map(|ac| ac.handler.clone())
                    .or_else(|| self.channel_handlers.get(&channel).cloned());

                if let Some(handler) = handler {
                    // Inject session context (_user) from stored channel options
                    let enriched = if let Some(opts) = self.channel_options.get(&channel) {
                        if let Some(obj) = data.as_object() {
                            let mut obj = obj.clone();
                            if let Some(user_val) = opts.extra.get("_user") {
                                obj.insert("_user".into(), user_val.clone());
                            }
                            if let Some(role_val) = opts.extra.get("_role") {
                                obj.insert("_role".into(), role_val.clone());
                            }
                            serde_json::Value::Object(obj)
                        } else {
                            data
                        }
                    } else {
                        data
                    };
                    handler.data(&channel, &enriched).await
                } else {
                    tracing::debug!(channel = %channel, "data on untracked channel");
                    vec![]
                }
            }
            Message::Close { channel, .. } => {
                // Shut down streaming channel if active
                if let Some(active) = self.active_channels.remove(&channel) {
                    let _ = active.shutdown_tx.send(true);
                    tracing::debug!(channel = %channel, "streaming channel stopped");
                }
                // Remove one-shot channel tracking
                self.channel_handlers.remove(&channel);
                self.channel_options.remove(&channel);
                vec![]
            }
            Message::Ping => vec![Message::Pong],
            _ => {
                tracing::debug!(?msg, "unhandled message in agent");
                vec![]
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tenodera_protocol::channel::{ChannelId, ChannelOpenOptions};
    use tenodera_protocol::message::Message;

    fn make_router() -> (Router, mpsc::Receiver<Message>) {
        let (tx, rx) = mpsc::channel(16);
        (Router::new(tx), rx)
    }

    fn open_options(payload: &str) -> ChannelOpenOptions {
        ChannelOpenOptions {
            payload: payload.to_string(),
            superuser: None,
            extra: Default::default(),
        }
    }

    #[tokio::test]
    async fn ping_returns_pong() {
        let (mut router, _rx) = make_router();
        let responses = router.handle(Message::Ping).await;
        assert_eq!(responses.len(), 1);
        assert!(matches!(responses[0], Message::Pong));
    }

    #[tokio::test]
    async fn unknown_payload_closes_with_problem() {
        let (mut router, _rx) = make_router();
        let channel: ChannelId = "ch1".into();
        let responses = router
            .handle(Message::Open { channel, options: open_options("no.such.handler") })
            .await;
        assert_eq!(responses.len(), 1);
        let Message::Close { problem, .. } = &responses[0] else {
            panic!("expected Close, got {:?}", responses[0]);
        };
        assert!(problem.as_deref().unwrap_or("").contains("unknown-payload"));
    }

    #[tokio::test]
    async fn close_on_unknown_channel_is_noop() {
        let (mut router, _rx) = make_router();
        let channel: ChannelId = "ch99".into();
        let responses = router.handle(Message::Close { channel, problem: None }).await;
        assert!(responses.is_empty());
    }

    #[tokio::test]
    async fn data_on_untracked_channel_is_noop() {
        let (mut router, _rx) = make_router();
        let channel: ChannelId = "ch2".into();
        let responses = router
            .handle(Message::Data { channel, data: serde_json::json!({"x": 1}) })
            .await;
        assert!(responses.is_empty());
    }

    #[tokio::test]
    async fn register_defaults_covers_expected_payloads() {
        let (tx, _rx) = mpsc::channel(16);
        let mut router = Router::new(tx);
        router.register_defaults();
        let must_have = [
            "system.info",
            "systemd.units",
            "metrics.stream",
            "terminal.pty",
            "packages.manage",
            "dns.info",
            "certs.list",
        ];
        for payload in must_have {
            assert!(
                router.handlers.contains_key(payload),
                "handler missing: {payload}"
            );
        }
    }
}
