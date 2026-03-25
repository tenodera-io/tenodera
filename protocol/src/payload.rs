/// Known payload types that bridge handlers can register for.
///
/// Each variant maps to a channel handler in the bridge.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Payload {
    SystemInfo,
    SystemdUnits,
    SystemdUnitAction,
    JournalQuery,
    JournalFollow,
    FileRead,
    FileWrite,
    FileList,
    ProcessExec,
    ProcessStream,
    TerminalPty,
    NetworkInterfaces,
    FirewallRules,
    MetricsStream,
    SshRemote,
    PackageUpdates,
    ContainerList,
    KdumpInfo,
    LogFiles,
    /// Escape hatch for unknown / future / plugin payloads.
    Custom(String),
}

impl Payload {
    pub fn from_str(s: &str) -> Self {
        match s {
            "system.info" => Self::SystemInfo,
            "systemd.units" => Self::SystemdUnits,
            "systemd.unit.action" => Self::SystemdUnitAction,
            "journal.query" => Self::JournalQuery,
            "journal.follow" => Self::JournalFollow,
            "file.read" => Self::FileRead,
            "file.write" => Self::FileWrite,
            "file.list" => Self::FileList,
            "process.exec" => Self::ProcessExec,
            "process.stream" => Self::ProcessStream,
            "terminal.pty" => Self::TerminalPty,
            "network.interfaces" => Self::NetworkInterfaces,
            "firewall.rules" => Self::FirewallRules,
            "metrics.stream" => Self::MetricsStream,
            "ssh.remote" => Self::SshRemote,
            "package.updates" => Self::PackageUpdates,
            "container.list" => Self::ContainerList,
            "kdump.info" => Self::KdumpInfo,
            "log.files" => Self::LogFiles,
            other => Self::Custom(other.to_string()),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::SystemInfo => "system.info",
            Self::SystemdUnits => "systemd.units",
            Self::SystemdUnitAction => "systemd.unit.action",
            Self::JournalQuery => "journal.query",
            Self::JournalFollow => "journal.follow",
            Self::FileRead => "file.read",
            Self::FileWrite => "file.write",
            Self::FileList => "file.list",
            Self::ProcessExec => "process.exec",
            Self::ProcessStream => "process.stream",
            Self::TerminalPty => "terminal.pty",
            Self::NetworkInterfaces => "network.interfaces",
            Self::FirewallRules => "firewall.rules",
            Self::MetricsStream => "metrics.stream",
            Self::SshRemote => "ssh.remote",
            Self::PackageUpdates => "package.updates",
            Self::ContainerList => "container.list",
            Self::KdumpInfo => "kdump.info",
            Self::LogFiles => "log.files",
            Self::Custom(s) => s.as_str(),
        }
    }
}

impl std::fmt::Display for Payload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}
