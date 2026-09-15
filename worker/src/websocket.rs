//! WebSocket endpoint speaking the binary `worker.v1` protocol.

// axum handlers must take extractors by value.
#![allow(clippy::needless_pass_by_value)]

use std::net::SocketAddr;

use axum::{
    extract::{
        ConnectInfo, State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use tokio::sync::broadcast::error::RecvError;
use tracing::{info, warn};

use crate::{
    proto::{self, Envelope, envelope::Payload},
    state::{Lifecycle, SharedState},
};

/// RFC 6455 close code sent when the server is going away.
const GOING_AWAY: u16 = 1001;
/// RFC 6455 close code for a frame type this endpoint does not accept.
const UNSUPPORTED_DATA: u16 = 1003;
/// RFC 6455 close code asking the client to try again later.
const TRY_AGAIN_LATER: u16 = 1013;
const MAX_MESSAGE_SIZE: usize = 64 * 1024 * 1024;

pub async fn handler(
    upgrade: WebSocketUpgrade,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<SharedState>,
) -> Response {
    if state.is_draining() {
        warn!(%peer, "upgrade refused: draining for suspend or terminate");
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    upgrade
        .max_message_size(MAX_MESSAGE_SIZE)
        .on_upgrade(move |socket| handle_socket(socket, peer, state))
        .into_response()
}

enum Action {
    Reply(Envelope),
    Ignore,
    Close,
    /// Close with a protocol error code; the peer sent something we never accept.
    Reject(u16, &'static str),
}

async fn handle_socket(mut socket: WebSocket, peer: SocketAddr, state: SharedState) {
    let Some(_guard) = state.track_connection() else {
        warn!(%peer, "connection refused: at capacity");
        let frame = CloseFrame {
            code: TRY_AGAIN_LATER,
            reason: "at capacity".into(),
        };
        let _ = socket.send(Message::Close(Some(frame))).await;
        return;
    };
    info!(%peer, "client connected");
    let (mut sink, mut stream) = socket.split();
    let mut lifecycle = state.lifecycle.subscribe();

    loop {
        let action = tokio::select! {
            message = stream.next() => match message {
                None => Action::Close,
                Some(Ok(message)) => classify(message, peer),
                Some(Err(error)) => {
                    warn!(%peer, %error, "read error");
                    Action::Close
                }
            },
            event = lifecycle.recv() => match event {
                Ok(Lifecycle::Suspend | Lifecycle::Terminate) => {
                    info!(%peer, "closing for lifecycle event");
                    let frame = CloseFrame { code: GOING_AWAY, reason: "going away".into() };
                    let _ = sink.send(Message::Close(Some(frame))).await;
                    break;
                }
                Err(RecvError::Lagged(_)) => Action::Ignore,
                Err(RecvError::Closed) => Action::Close,
            },
        };

        match action {
            Action::Reply(envelope) => {
                if let Err(error) = sink
                    .send(Message::Binary(envelope.encode_to_vec().into()))
                    .await
                {
                    warn!(%peer, %error, "write error");
                    break;
                }
            }
            Action::Ignore => {}
            Action::Close => {
                let _ = sink.close().await;
                break;
            }
            Action::Reject(code, reason) => {
                let frame = CloseFrame {
                    code,
                    reason: reason.into(),
                };
                let _ = sink.send(Message::Close(Some(frame))).await;
                break;
            }
        }
    }

    info!(%peer, "client disconnected");
}

fn classify(message: Message, peer: SocketAddr) -> Action {
    match message {
        Message::Binary(bytes) => match Envelope::decode(bytes) {
            Ok(envelope) => handle(envelope).map_or(Action::Ignore, Action::Reply),
            Err(error) => {
                warn!(%peer, %error, "undecodable frame");
                Action::Ignore
            }
        },
        Message::Text(_) => {
            warn!(%peer, "text frame rejected");
            Action::Reject(UNSUPPORTED_DATA, "binary frames only")
        }
        Message::Close(_) => {
            info!(%peer, "client requested close");
            Action::Close
        }
        Message::Ping(_) | Message::Pong(_) => Action::Ignore,
    }
}

fn handle(envelope: Envelope) -> Option<Envelope> {
    match envelope.payload? {
        Payload::Exec(request) => Some(Envelope {
            message_id: envelope.message_id,
            payload: Some(Payload::Result(proto::ExecResult {
                exit_code: 0,
                stdout: request.command.into_bytes(),
                stderr: Vec::new(),
            })),
        }),
        Payload::Heartbeat(heartbeat) => Some(Envelope {
            message_id: envelope.message_id,
            payload: Some(Payload::Heartbeat(heartbeat)),
        }),
        Payload::Result(_) => None,
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    fn exec(message_id: u64, command: &str) -> Envelope {
        Envelope {
            message_id,
            payload: Some(Payload::Exec(proto::ExecRequest {
                command: command.to_string(),
                stdin: Vec::new(),
            })),
        }
    }

    #[test]
    fn exec_is_answered_with_a_result_carrying_the_same_id() {
        let reply = handle(exec(42, "echo hi")).expect("exec produces a reply");
        assert_eq!(reply.message_id, 42);
        match reply.payload {
            Some(Payload::Result(result)) => {
                assert_eq!(result.exit_code, 0);
                assert_eq!(result.stdout, b"echo hi");
            }
            other => panic!("unexpected payload: {other:?}"),
        }
    }

    #[test]
    fn heartbeat_is_echoed() {
        let envelope = Envelope {
            message_id: 7,
            payload: Some(Payload::Heartbeat(proto::Heartbeat { ts_ms: 1234 })),
        };
        let reply = handle(envelope).expect("heartbeat produces a reply");
        assert!(matches!(
            reply.payload,
            Some(Payload::Heartbeat(proto::Heartbeat { ts_ms: 1234 }))
        ));
    }

    #[test]
    fn results_and_empty_envelopes_are_ignored() {
        let result = Envelope {
            message_id: 1,
            payload: Some(Payload::Result(proto::ExecResult::default())),
        };
        assert!(handle(result).is_none());
        assert!(handle(Envelope::default()).is_none());
    }

    #[test]
    fn frames_are_classified() {
        let peer: SocketAddr = "127.0.0.1:1".parse().expect("valid address");
        let binary = Message::Binary(exec(1, "x").encode_to_vec().into());
        assert!(matches!(classify(binary, peer), Action::Reply(_)));
        assert!(matches!(
            classify(Message::Binary(vec![0xff, 0xff].into()), peer),
            Action::Ignore
        ));
        assert!(matches!(
            classify(Message::Text("hello".into()), peer),
            Action::Reject(UNSUPPORTED_DATA, _)
        ));
        assert!(matches!(
            classify(Message::Close(None), peer),
            Action::Close
        ));
    }
}
