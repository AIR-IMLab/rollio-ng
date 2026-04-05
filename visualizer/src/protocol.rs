/// WebSocket binary/JSON protocol encoding and decoding.
///
/// Binary messages (Visualizer → UI) — camera frames:
///   Byte 0:      frame encoding type (0x01 = JPEG)
///   Bytes 1-2:   camera name length (u16 LE)
///   Bytes 3..N:  camera name (UTF-8)
///   Bytes N+1..N+4: original width (u32 LE)
///   Bytes N+5..N+8: original height (u32 LE)
///   Remaining:   encoded frame data (JPEG payload)
///
/// Text/JSON messages (both directions):
///   Visualizer → UI: {"type":"robot_state","name":"...","timestamp_ns":...,...}
///   UI → Visualizer:  {"type":"command","action":"..."}
use rollio_types::messages::RobotState;
use serde::{Deserialize, Serialize};

/// Frame encoding type tags.
pub const FRAME_TYPE_JPEG: u8 = 0x01;

/// Encode a camera frame into the binary WebSocket protocol.
///
/// Pre-allocates the exact output capacity to avoid reallocation.
pub fn encode_camera_frame(name: &str, width: u32, height: u32, jpeg_data: &[u8]) -> Vec<u8> {
    let name_bytes = name.as_bytes();
    let name_len = name_bytes.len();
    // 1 (type) + 2 (name len) + name + 4 (width) + 4 (height) + jpeg payload
    let total = 1 + 2 + name_len + 4 + 4 + jpeg_data.len();
    let mut buf = Vec::with_capacity(total);

    buf.push(FRAME_TYPE_JPEG);
    buf.extend_from_slice(&(name_len as u16).to_le_bytes());
    buf.extend_from_slice(name_bytes);
    buf.extend_from_slice(&width.to_le_bytes());
    buf.extend_from_slice(&height.to_le_bytes());
    buf.extend_from_slice(jpeg_data);

    buf
}

/// JSON message for robot state sent to the UI.
#[derive(Serialize)]
struct RobotStateJson<'a> {
    #[serde(rename = "type")]
    msg_type: &'static str,
    name: &'a str,
    timestamp_ns: u64,
    num_joints: u32,
    positions: &'a [f64],
    velocities: &'a [f64],
    efforts: &'a [f64],
}

/// Encode a robot state into a JSON string for WebSocket text message.
///
/// Only serializes `num_joints` values from each array, not the full 16.
pub fn encode_robot_state(name: &str, state: &RobotState) -> String {
    let n = state.num_joints as usize;
    let msg = RobotStateJson {
        msg_type: "robot_state",
        name,
        timestamp_ns: state.timestamp_ns,
        num_joints: state.num_joints,
        positions: &state.positions[..n],
        velocities: &state.velocities[..n],
        efforts: &state.efforts[..n],
    };
    // serde_json::to_string is infallible for this struct
    serde_json::to_string(&msg).unwrap_or_default()
}

/// A command received from the UI via WebSocket.
/// Fields will be used when command handling is implemented in Sprint 3.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct Command {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub action: Option<String>,
}

/// Attempt to parse a JSON text message as a command from the UI.
pub fn decode_command(text: &str) -> Option<Command> {
    serde_json::from_str(text).ok()
}
