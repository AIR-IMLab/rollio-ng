/// WebSocket server for the Visualizer.
///
/// Accepts WebSocket connections and broadcasts camera frames (binary) and
/// robot states (JSON text) to all connected clients. Uses `Arc` to share
/// message payloads across clients without copying.
///
/// Slow clients that fall behind on the broadcast channel simply skip frames
/// (lag) rather than causing backpressure.
use std::net::SocketAddr;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::protocol::Message;

use crate::protocol;

/// A message to broadcast to all WebSocket clients.
#[derive(Clone, Debug)]
pub enum BroadcastMessage {
    /// Binary message (camera frame encoded per the WS protocol).
    Binary(Arc<Vec<u8>>),
    /// Text/JSON message (robot state, status, etc.).
    Text(Arc<String>),
}

/// Run the WebSocket server, accepting connections and broadcasting messages.
///
/// This function runs forever (until the task is cancelled).
pub async fn run_server(
    addr: SocketAddr,
    broadcast_tx: broadcast::Sender<BroadcastMessage>,
) {
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => {
            log::info!("WebSocket server listening on {addr}");
            l
        }
        Err(e) => {
            log::error!("failed to bind WebSocket server on {addr}: {e}");
            return;
        }
    };

    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                log::info!("new WebSocket connection from {peer}");
                let rx = broadcast_tx.subscribe();
                tokio::spawn(handle_client(stream, peer, rx));
            }
            Err(e) => {
                log::warn!("accept error: {e}");
            }
        }
    }
}

/// Handle a single WebSocket client connection.
///
/// Reads from the broadcast channel and forwards to the WebSocket.
/// Also reads incoming messages from the client (commands).
async fn handle_client(
    stream: tokio::net::TcpStream,
    peer: SocketAddr,
    mut broadcast_rx: broadcast::Receiver<BroadcastMessage>,
) {
    let ws_stream = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            log::warn!("WebSocket handshake failed for {peer}: {e}");
            return;
        }
    };

    let (mut ws_sink, mut ws_source) = ws_stream.split();

    // Spawn a task to read incoming messages from the client
    let read_task = tokio::spawn(async move {
        while let Some(msg) = ws_source.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    if let Some(cmd) = protocol::decode_command(&text) {
                        log::info!("command from {peer}: {:?}", cmd);
                    }
                }
                Ok(Message::Close(_)) => {
                    log::info!("client {peer} sent close");
                    break;
                }
                Err(e) => {
                    log::debug!("read error from {peer}: {e}");
                    break;
                }
                _ => {}
            }
        }
    });

    // Forward broadcast messages to the WebSocket client
    loop {
        match broadcast_rx.recv().await {
            Ok(msg) => {
                let ws_msg = match msg {
                    BroadcastMessage::Binary(data) => Message::Binary((*data).clone().into()),
                    BroadcastMessage::Text(text) => Message::Text((*text).clone().into()),
                };
                if let Err(e) = ws_sink.send(ws_msg).await {
                    log::debug!("write error to {peer}: {e}");
                    break;
                }
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                log::debug!("client {peer} lagged, skipped {n} messages");
                // Continue — the client will get the next message
            }
            Err(broadcast::error::RecvError::Closed) => {
                log::info!("broadcast channel closed, disconnecting {peer}");
                break;
            }
        }
    }

    // Clean up: abort the read task
    read_task.abort();
    let _ = ws_sink.close().await;
    log::info!("client {peer} disconnected");
}
