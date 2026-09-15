use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use tokio::sync::{Notify, RwLock, broadcast};

/// Upper bound on simultaneous client connections per process. Beyond this,
/// upgrades are refused so one tenant cannot exhaust the micro-VM's memory.
pub const MAX_CONNECTIONS: usize = 64;

/// A drain that was never followed by `/run` or `/resume` stops refusing
/// upgrades after this long: by then the checkpoint either happened, in which
/// case the process is frozen anyway, or it was abandoned.
const DRAIN_EXPIRY: Duration = Duration::from_secs(30);

/// Lifecycle events broadcast to every open connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lifecycle {
    /// Lambda is about to suspend the micro-VM. Connections must be closed.
    Suspend,
    /// Lambda is about to terminate the micro-VM.
    Terminate,
}

/// Identity of the micro-VM this process runs in, delivered by the `/run` hook.
#[derive(Debug, Clone, Default)]
pub struct Microvm {
    pub microvm_id: String,
    pub run_hook_payload: String,
}

#[derive(Debug)]
pub struct AppState {
    pub microvm: RwLock<Option<Microvm>>,
    pub lifecycle: broadcast::Sender<Lifecycle>,
    open_connections: AtomicUsize,
    connections_drained: Notify,
    /// When suspend or terminate began; new upgrades are refused while set so
    /// they cannot be frozen mid-handshake. Expires on its own, see
    /// [`DRAIN_EXPIRY`].
    draining_since: Mutex<Option<Instant>>,
}

pub type SharedState = Arc<AppState>;

impl AppState {
    pub fn new() -> SharedState {
        let (lifecycle, _) = broadcast::channel(16);
        Arc::new(Self {
            microvm: RwLock::new(None),
            lifecycle,
            open_connections: AtomicUsize::new(0),
            connections_drained: Notify::new(),
            draining_since: Mutex::new(None),
        })
    }

    pub fn is_draining(&self) -> bool {
        self.draining_since
            .lock()
            .is_ok_and(|since| since.is_some_and(|started| started.elapsed() < DRAIN_EXPIRY))
    }

    fn set_draining(&self, draining: bool) {
        if let Ok(mut since) = self.draining_since.lock() {
            *since = draining.then(Instant::now);
        }
    }

    /// Called from `/run` and `/resume`: the micro-VM is live again.
    pub fn accept_connections(&self) {
        self.set_draining(false);
    }

    /// Registers a live connection, or returns `None` when the process is at
    /// [`MAX_CONNECTIONS`]. Dropping the guard unregisters it.
    pub fn track_connection(self: &Arc<Self>) -> Option<ConnectionGuard> {
        let previous = self.open_connections.fetch_add(1, Ordering::SeqCst);
        if previous >= MAX_CONNECTIONS {
            self.release_connection();
            return None;
        }
        Some(ConnectionGuard {
            state: Arc::clone(self),
        })
    }

    fn release_connection(&self) {
        if self.open_connections.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.connections_drained.notify_waiters();
        }
    }

    pub fn open_connections(&self) -> usize {
        self.open_connections.load(Ordering::SeqCst)
    }

    /// Broadcasts a lifecycle event and waits, up to `timeout`, for every
    /// connection to finish closing. Returns how many were still open.
    pub async fn drain_connections(&self, event: Lifecycle, timeout: Duration) -> usize {
        self.set_draining(true);
        let _ = self.lifecycle.send(event);
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            // Register the waiter before reading the count so a guard dropped
            // in between cannot notify into the void.
            let notified = self.connections_drained.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.open_connections() == 0 {
                return 0;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return self.open_connections();
            }
        }
    }
}

#[derive(Debug)]
pub struct ConnectionGuard {
    state: Arc<AppState>,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.state.release_connection();
    }
}
