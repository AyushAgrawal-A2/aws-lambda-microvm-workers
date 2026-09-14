use std::net::SocketAddr;

use axum::{
    Router,
    extract::{
        ConnectInfo, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::IntoResponse,
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use tracing::{info, warn};

pub mod pb {
    include!(concat!(env!("OUT_DIR"), "/worker.v1.rs"));
}
use pb::{Envelope, envelope::Payload};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let addr: SocketAddr = match std::env::var("PORT") {
        Ok(port) => format!("127.0.0.1:{port}").parse()?,
        Err(_) => std::env::var("WS_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:8080".to_string())
            .parse()?,
    };

    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!(%addr, "websocket server listening");

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/ws", get(ws_handler));

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
        info!("shutdown signal received");
    })
    .await?;

    Ok(())
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
) -> impl IntoResponse {
    ws.max_message_size(100 * 1024 * 1024)
        .on_upgrade(move |socket| handle_socket(socket, peer))
}

async fn handle_socket(socket: WebSocket, peer: SocketAddr) {
    info!(%peer, "client connected");
    let (mut tx, mut rx) = socket.split();

    while let Some(message) = rx.next().await {
        let message = match message {
            Ok(message) => message,
            Err(error) => {
                warn!(%peer, %error, "read error");
                break;
            }
        };

        let reply = match message {
            Message::Binary(bytes) => match Envelope::decode(bytes) {
                Ok(envelope) => handle(envelope),
                Err(error) => {
                    warn!(%peer, %error, "undecodable frame");
                    None
                }
            },
            Message::Text(_) => {
                warn!(%peer, "text frame rejected");
                None
            }
            Message::Close(_) => {
                info!(%peer, "client requested close");
                break;
            }
            _ => None,
        };

        if let Some(envelope) = reply
            && let Err(error) = tx
                .send(Message::Binary(envelope.encode_to_vec().into()))
                .await
        {
            warn!(%peer, %error, "write error");
            break;
        }
    }

    info!(%peer, "client disconnected");
}

fn handle(envelope: Envelope) -> Option<Envelope> {
    match envelope.payload? {
        Payload::Exec(request) => Some(Envelope {
            id: envelope.id,
            payload: Some(Payload::Result(pb::ExecResult {
                exit_code: 0,
                stdout: request.command.into_bytes(),
                stderr: Vec::new(),
            })),
        }),
        Payload::Heartbeat(heartbeat) => Some(Envelope {
            id: envelope.id,
            payload: Some(Payload::Heartbeat(heartbeat)),
        }),
        Payload::Result(_) => None,
    }
}
