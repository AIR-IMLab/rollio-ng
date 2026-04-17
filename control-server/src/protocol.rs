//! WebSocket protocol for the control plane.
//!
//! The control server exchanges only JSON text messages with the UI:
//! - Inbound (UI → server): `{"type":"command","action":"...", ...}`
//!   - `setup_*` actions are forwarded verbatim onto the iceoryx2
//!     `SetupCommandMessage` service.
//!   - `episode_*` actions are translated into [`EpisodeCommand`].
//! - Outbound (server → UI): forwarded JSON state snapshots that originate on
//!   iceoryx2 (`setup_state`, `episode_status`, `backpressure`).

use rollio_types::messages::{BackpressureEvent, EpisodeCommand, EpisodeStatus};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct Command {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub action: String,
}

pub fn decode_command(text: &str) -> Option<Command> {
    let cmd: Command = serde_json::from_str(text).ok()?;
    if cmd.msg_type == "command" {
        Some(cmd)
    } else {
        None
    }
}

pub fn decode_episode_command(action: &str) -> Option<EpisodeCommand> {
    match action {
        "episode_start" => Some(EpisodeCommand::Start),
        "episode_stop" => Some(EpisodeCommand::Stop),
        "episode_keep" => Some(EpisodeCommand::Keep),
        "episode_discard" => Some(EpisodeCommand::Discard),
        _ => None,
    }
}

#[derive(Serialize)]
struct EpisodeStatusJson {
    #[serde(rename = "type")]
    msg_type: &'static str,
    state: &'static str,
    episode_count: u32,
    elapsed_ms: u64,
}

pub fn encode_episode_status(status: &EpisodeStatus) -> String {
    serde_json::to_string(&EpisodeStatusJson {
        msg_type: "episode_status",
        state: status.state.as_str(),
        episode_count: status.episode_count,
        elapsed_ms: status.elapsed_ms,
    })
    .unwrap_or_default()
}

#[derive(Serialize)]
struct BackpressureJson<'a> {
    #[serde(rename = "type")]
    msg_type: &'static str,
    process_id: &'a str,
    queue_name: &'a str,
}

pub fn encode_backpressure(event: &BackpressureEvent) -> String {
    serde_json::to_string(&BackpressureJson {
        msg_type: "backpressure",
        process_id: event.process_id.as_str(),
        queue_name: event.queue_name.as_str(),
    })
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rollio_types::messages::{EpisodeState, FixedString64};

    #[test]
    fn decode_setup_command_passes_through() {
        let cmd = decode_command(
            r#"{"type":"command","action":"setup_toggle_identify","name":"camera_top"}"#,
        )
        .expect("setup command should decode");
        assert_eq!(cmd.action, "setup_toggle_identify");
    }

    #[test]
    fn decode_episode_command_recognizes_start_stop_keep_discard() {
        assert_eq!(
            decode_episode_command("episode_start"),
            Some(EpisodeCommand::Start)
        );
        assert_eq!(
            decode_episode_command("episode_stop"),
            Some(EpisodeCommand::Stop)
        );
        assert_eq!(
            decode_episode_command("episode_keep"),
            Some(EpisodeCommand::Keep)
        );
        assert_eq!(
            decode_episode_command("episode_discard"),
            Some(EpisodeCommand::Discard)
        );
        assert_eq!(decode_episode_command("setup_next_step"), None);
    }

    #[test]
    fn encode_episode_status_uses_expected_json_shape() {
        let json = encode_episode_status(&EpisodeStatus {
            state: EpisodeState::Recording,
            episode_count: 3,
            elapsed_ms: 1_234,
        });
        let value: serde_json::Value =
            serde_json::from_str(&json).expect("episode status should be valid JSON");
        assert_eq!(value["type"], "episode_status");
        assert_eq!(value["state"], "recording");
        assert_eq!(value["episode_count"], 3);
        assert_eq!(value["elapsed_ms"], 1_234);
    }

    #[test]
    fn encode_backpressure_uses_expected_json_shape() {
        let event = BackpressureEvent {
            process_id: FixedString64::new("encoder.camera_top.color"),
            queue_name: FixedString64::new("frame_queue"),
        };
        let json = encode_backpressure(&event);
        let value: serde_json::Value =
            serde_json::from_str(&json).expect("backpressure should be valid JSON");
        assert_eq!(value["type"], "backpressure");
        assert_eq!(value["process_id"], "encoder.camera_top.color");
        assert_eq!(value["queue_name"], "frame_queue");
    }
}
