//! Lambda micro-VM lifecycle hooks.
//!
//! Lambda POSTs to these paths on the application port at each lifecycle
//! event. Every hook must answer quickly: a request held past its timeout
//! fails the image build or terminates the micro-VM.
//!
//! The hooks share the traffic port, so a client holding a valid endpoint
//! token could reach them. Set `HOOKS_LOOPBACK_ONLY=1` once it is confirmed
//! that the Lambda agent calls from the loopback interface.

// axum handlers must take extractors by value and must be `async fn`.
#![allow(clippy::needless_pass_by_value, clippy::unused_async)]

use std::{net::SocketAddr, time::Duration};

use axum::{
    Router,
    extract::{ConnectInfo, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Deserialize;
use tracing::{info, warn};

use crate::state::{Lifecycle, Microvm, SharedState};

/// Path prefix Lambda uses for all hooks.
pub const PREFIX: &str = "/aws/lambda-microvms/runtime/v1";

/// How long suspend and terminate wait for connections to close before
/// answering. Must stay well inside the hook timeouts configured in
/// deploy/microvm/hooks.json.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunRequest {
    #[serde(default)]
    microvm_id: String,
    #[serde(default)]
    run_hook_payload: String,
}

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/ready", post(ready))
        .route("/validate", post(validate))
        .route("/run", post(run))
        .route("/resume", post(resume))
        .route("/suspend", post(suspend))
        .route("/terminate", post(terminate))
        .layer(middleware::from_fn(loopback_only))
}

fn loopback_required() -> bool {
    matches!(
        std::env::var("HOOKS_LOOPBACK_ONLY").as_deref(),
        Ok("1" | "true")
    )
}

async fn loopback_only(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Response {
    if loopback_required() && !peer.ip().is_loopback() {
        warn!(%peer, "hook rejected: not from loopback");
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(request).await
}

/// Image build: the process is listening, safe to snapshot.
async fn ready() -> StatusCode {
    info!("hook: ready");
    StatusCode::OK
}

/// Image build: a micro-VM restored from the fresh snapshot works.
async fn validate() -> StatusCode {
    info!("hook: validate");
    StatusCode::OK
}

/// A new micro-VM was restored from the image snapshot. Everything unique to
/// this micro-VM must be generated here, never before the snapshot.
async fn run(State(state): State<SharedState>, body: String) -> StatusCode {
    let request: RunRequest = match serde_json::from_str(&body) {
        Ok(request) => request,
        Err(error) if body.trim().is_empty() => {
            warn!(%error, "hook: run with empty body");
            RunRequest::default()
        }
        Err(error) => {
            warn!(%error, "hook: run body is not valid JSON");
            RunRequest::default()
        }
    };
    info!(microvm_id = %request.microvm_id, "hook: run");
    *state.microvm.write().await = Some(Microvm {
        microvm_id: request.microvm_id,
        run_hook_payload: request.run_hook_payload,
    });
    state.accept_connections();
    StatusCode::OK
}

/// Resumed from a suspend checkpoint. Traffic starts after this returns.
async fn resume(State(state): State<SharedState>) -> StatusCode {
    let (microvm_id, payload_bytes) = state
        .microvm
        .read()
        .await
        .as_ref()
        .map(|microvm| (microvm.microvm_id.clone(), microvm.run_hook_payload.len()))
        .unzip();
    info!(?microvm_id, ?payload_bytes, "hook: resume");
    state.accept_connections();
    StatusCode::OK
}

/// About to be checkpointed. Close client connections so they reconnect
/// cleanly instead of timing out against a frozen socket, and only answer
/// once they are gone so the close frames are on the wire before the freeze.
async fn suspend(State(state): State<SharedState>) -> StatusCode {
    let open = state.open_connections();
    let remaining = state
        .drain_connections(Lifecycle::Suspend, DRAIN_TIMEOUT)
        .await;
    info!(open, remaining, "hook: suspend");
    StatusCode::OK
}

/// About to be destroyed. Flush anything that must outlive the micro-VM.
async fn terminate(State(state): State<SharedState>) -> StatusCode {
    let open = state.open_connections();
    let remaining = state
        .drain_connections(Lifecycle::Terminate, DRAIN_TIMEOUT)
        .await;
    info!(open, remaining, "hook: terminate");
    StatusCode::OK
}
