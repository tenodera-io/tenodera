use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{mpsc, watch};

use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

use crate::handler::ChannelHandler;
use crate::handlers::{containers, disk_usage, file_list, hardware_info, hosts, journal_query, kdump, log_files, metrics_snapshot, metrics_stream, network_stats, networking, networking_snapshot, packages, storage, storage_snapshot, superuser_verify, system_info, systemd_units, terminal_pty, top_processes, users};

/// Active streaming channel state.
struct ActiveChannel {
    shutdown_tx: watch::Sender<bool>,
    handler: Arc<dyn ChannelHandler>,
}

/// Routes incoming messages to the correct ChannelHandler based on payload type.
pub struct Router {
    handlers: HashMap<String, Arc<dyn ChannelHandler>>,
    active_channels: HashMap<String, ActiveChannel>,
    /// Maps channel id → handler (for non-streaming channels that received Open).
    channel_handlers: HashMap<String, Arc<dyn ChannelHandler>>,
    /// Maps channel id → open options (for injecting context into Data messages).
    channel_options: HashMap<String, ChannelOpenOptions>,
    /// Sender for outgoing messages (bridge → gateway).
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
                        if let (Some(user_val), Some(obj)) =
                            (opts.extra.get("_user"), data.as_object())
                        {
                            let mut obj = obj.clone();
                            obj.insert("_user".into(), user_val.clone());
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
                tracing::debug!(?msg, "unhandled message in bridge");
                vec![]
            }
        }
    }
}
