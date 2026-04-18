use clap::{Args, Parser, Subcommand};
use iceoryx2::node::NodeWaitFailure;
use iceoryx2::prelude::*;
use rollio_bus::CONTROL_EVENTS_SERVICE;
use rollio_types::config::{
    MappingStrategy, RobotCommandKind, RobotStateKind, TeleopRuntimeConfigV2,
    DEFAULT_TELEOP_SYNC_COMPLETE_THRESHOLD_RAD, DEFAULT_TELEOP_SYNC_MAX_STEP_RAD,
};
use rollio_types::messages::{
    ControlEvent, JointMitCommand15, JointVector15, ParallelMitCommand2, ParallelVector2, Pose7,
};
use std::error::Error;
use std::path::PathBuf;
use std::time::Duration;
use thiserror::Error;

type ControlSubscriber = iceoryx2::port::subscriber::Subscriber<ipc::Service, ControlEvent, ()>;

#[derive(Debug, Error)]
pub enum TeleopRouterError {
    #[error("leader state only exposes {available} values, required source index {requested}")]
    LeaderValueOutOfRange { requested: usize, available: usize },
    #[error("cartesian forwarding requires pose payloads on both sides")]
    InvalidCartesianRoute,
}

#[derive(Parser, Debug)]
#[command(name = "rollio-teleop-router")]
#[command(about = "Leader-to-follower teleop command forwarding")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    Run(RunArgs),
}

#[derive(Args, Debug)]
struct RunArgs {
    #[arg(long, value_name = "PATH", conflicts_with = "config_inline")]
    config: Option<PathBuf>,
    #[arg(long, value_name = "TOML", conflicts_with = "config")]
    config_inline: Option<String>,
}

enum LeaderStateSubscriber {
    JointVector15(
        iceoryx2::port::subscriber::Subscriber<ipc::Service, JointVector15, ()>,
    ),
    ParallelVector2(
        iceoryx2::port::subscriber::Subscriber<ipc::Service, ParallelVector2, ()>,
    ),
    Pose7(iceoryx2::port::subscriber::Subscriber<ipc::Service, Pose7, ()>),
}

enum FollowerCommandPublisher {
    JointVector15(
        iceoryx2::port::publisher::Publisher<ipc::Service, JointVector15, ()>,
    ),
    JointMitCommand15(
        iceoryx2::port::publisher::Publisher<ipc::Service, JointMitCommand15, ()>,
    ),
    ParallelVector2(
        iceoryx2::port::publisher::Publisher<ipc::Service, ParallelVector2, ()>,
    ),
    ParallelMitCommand2(
        iceoryx2::port::publisher::Publisher<ipc::Service, ParallelMitCommand2, ()>,
    ),
    Pose7(iceoryx2::port::publisher::Publisher<ipc::Service, Pose7, ()>),
}

enum LeaderState {
    Vector {
        timestamp_ms: u64,
        values: Vec<f64>,
    },
    Pose(Pose7),
}

/// Two-phase teleop ramp:
///
/// 1. **Initial syncing** — every published command is clamped to within
///    `max_step_rad` of the follower's current joint position so the arm
///    eases into the leader's pose without snapping. Active until the
///    follower lies within `complete_threshold_rad` of the leader on every
///    joint, at which point the router transitions to pass-through.
/// 2. **Pass-through** — the leader target is forwarded to the follower
///    untouched, including jumps larger than `complete_threshold_rad`. The
///    rationale (see user spec) is that smoothing big diffs at this stage
///    would inject lag that the operator can't predict, which is more
///    dangerous than letting the follower's lower-level controller decide
///    how to track the new target.
///
/// Sync is automatically disabled when the configured kind is not joint /
/// parallel position, or when no follower state subscription is available.
struct SyncState {
    synced: bool,
    enabled: bool,
    max_step: f64,
    complete_threshold: f64,
}

impl SyncState {
    fn new(config: &TeleopRuntimeConfigV2) -> Self {
        let kind = config.follower_state_kind;
        let supports_kind = matches!(
            kind,
            Some(RobotStateKind::JointPosition) | Some(RobotStateKind::ParallelPosition),
        );
        let has_topic = config.follower_state_topic.is_some();
        let supports_command = matches!(
            config.follower_command_kind,
            RobotCommandKind::JointPosition
                | RobotCommandKind::JointMit
                | RobotCommandKind::ParallelPosition
                | RobotCommandKind::ParallelMit,
        );
        let enabled = has_topic && supports_kind && supports_command;
        Self {
            synced: false,
            enabled,
            max_step: config
                .sync_max_step_rad
                .unwrap_or(DEFAULT_TELEOP_SYNC_MAX_STEP_RAD)
                .abs()
                .max(f64::EPSILON),
            complete_threshold: config
                .sync_complete_threshold_rad
                .unwrap_or(DEFAULT_TELEOP_SYNC_COMPLETE_THRESHOLD_RAD)
                .abs()
                .max(0.0),
        }
    }

    fn enabled(&self) -> bool {
        self.enabled && !self.synced
    }

    /// Mutate `command` in place so every joint is at most `max_step` away
    /// from the corresponding follower joint, then mark the router as synced
    /// once every joint difference is below `complete_threshold`.
    fn apply(
        &mut self,
        command: &mut ForwardedCommand,
        follower: Option<&LeaderState>,
        _config: &TeleopRuntimeConfigV2,
    ) {
        let Some(follower_values) = follower_position_slice(follower) else {
            // No follower feedback yet — fall back to pass-through this cycle
            // and try again next time. We don't switch to "synced" because
            // we still haven't proven the follower is close enough.
            return;
        };
        let target = command_target_slice_mut(command);
        let len = target.len().min(follower_values.len());
        let mut max_diff = 0.0f64;
        for i in 0..len {
            let diff = target[i] - follower_values[i];
            max_diff = max_diff.max(diff.abs());
            let clamped = diff.clamp(-self.max_step, self.max_step);
            target[i] = follower_values[i] + clamped;
        }
        if max_diff <= self.complete_threshold {
            self.synced = true;
            eprintln!(
                "rollio-teleop-router: initial sync complete (max diff {:.4} rad <= threshold {:.4} rad)",
                max_diff, self.complete_threshold
            );
        }
    }
}

fn follower_position_slice(state: Option<&LeaderState>) -> Option<&[f64]> {
    match state? {
        LeaderState::Vector { values, .. } => Some(values.as_slice()),
        LeaderState::Pose(_) => None,
    }
}

/// Mutable view into the joint-target portion of a forwarded command. Pose
/// commands are not rate-limited because the syncing phase only applies to
/// joint-space mappings (see `SyncState::new`).
fn command_target_slice_mut(command: &mut ForwardedCommand) -> &mut [f64] {
    match command {
        ForwardedCommand::JointPosition(payload) => {
            let len = payload.len as usize;
            &mut payload.values[..len]
        }
        ForwardedCommand::JointMit(payload) => {
            let len = payload.len as usize;
            &mut payload.position[..len]
        }
        ForwardedCommand::ParallelPosition(payload) => {
            let len = payload.len as usize;
            &mut payload.values[..len]
        }
        ForwardedCommand::ParallelMit(payload) => {
            let len = payload.len as usize;
            &mut payload.position[..len]
        }
        ForwardedCommand::EndPose(_) => &mut [],
    }
}

pub fn run_cli() -> Result<(), Box<dyn Error>> {
    let cli = Cli::parse();
    match cli.command {
        Command::Run(args) => {
            let config = load_runtime_config(&args)?;
            run_router(config)
        }
    }
}

fn load_runtime_config(args: &RunArgs) -> Result<TeleopRuntimeConfigV2, Box<dyn Error>> {
    match (&args.config, &args.config_inline) {
        (Some(path), None) => Ok(TeleopRuntimeConfigV2::from_file(path)?),
        (None, Some(inline)) => Ok(inline.parse::<TeleopRuntimeConfigV2>()?),
        (None, None) => Err("teleop router requires --config or --config-inline".into()),
        (Some(_), Some(_)) => Err("teleop router config flags are mutually exclusive".into()),
    }
}

pub fn run_router(config: TeleopRuntimeConfigV2) -> Result<(), Box<dyn Error>> {
    let node = NodeBuilder::new()
        .signal_handling_mode(SignalHandlingMode::Disabled)
        .create::<ipc::Service>()?;

    let leader_state_subscriber =
        create_state_subscriber(&node, &config.leader_state_topic, config.leader_state_kind)?;
    let follower_state_subscriber = match (
        config.follower_state_kind,
        config.follower_state_topic.as_deref(),
    ) {
        (Some(kind), Some(topic)) => Some(create_state_subscriber(&node, topic, kind)?),
        _ => None,
    };
    let follower_command_publisher = create_command_publisher(
        &node,
        &config.follower_command_topic,
        config.follower_command_kind,
    )?;
    let control_subscriber = create_control_subscriber(&node)?;
    let mut last_forwarded_timestamp_ms = None;
    let mut sync_state = SyncState::new(&config);
    let mut follower_state: Option<LeaderState> = None;

    eprintln!(
        "rollio-teleop-router: {} forwarding {} -> {} with {:?} (sync mode: {})",
        config.process_id,
        config.leader_channel_id,
        config.follower_channel_id,
        config.mapping,
        if sync_state.enabled() {
            "initial-ramp"
        } else {
            "pass-through"
        }
    );

    loop {
        if drain_control_events(&control_subscriber)? {
            break;
        }
        // Always drain the follower state subscriber so the syncing phase
        // sees the freshest position. If the follower hasn't booted yet the
        // drain is a no-op and `follower_state` simply stays at `None`.
        if let Some(subscriber) = follower_state_subscriber.as_ref() {
            if let Some(state) = drain_latest_state(subscriber)? {
                follower_state = Some(state);
            }
        }
        if let Some(state) = drain_latest_state(&leader_state_subscriber)? {
            let timestamp_ms = state_timestamp_ms(&state);
            if last_forwarded_timestamp_ms == Some(timestamp_ms) {
                continue;
            }
            let mapped = map_leader_state(&config, &state)?;
            if let Some(mut forwarded) = mapped {
                if sync_state.enabled() {
                    sync_state.apply(&mut forwarded, follower_state.as_ref(), &config);
                }
                publish_command(&follower_command_publisher, forwarded)?;
                last_forwarded_timestamp_ms = Some(timestamp_ms);
                continue;
            }
        }

        match node.wait(Duration::from_millis(1)) {
            Ok(()) => {}
            Err(NodeWaitFailure::Interrupt | NodeWaitFailure::TerminationRequest) => break,
        }
    }

    eprintln!(
        "rollio-teleop-router: {} shutdown complete",
        config.process_id
    );
    Ok(())
}

fn create_state_subscriber(
    node: &Node<ipc::Service>,
    topic: &str,
    kind: RobotStateKind,
) -> Result<LeaderStateSubscriber, Box<dyn Error>> {
    let service_name: ServiceName = topic.try_into()?;
    Ok(match kind {
        RobotStateKind::EndEffectorPose => {
            let service = node
                .service_builder(&service_name)
                .publish_subscribe::<Pose7>()
                .open_or_create()?;
            LeaderStateSubscriber::Pose7(service.subscriber_builder().create()?)
        }
        RobotStateKind::ParallelPosition
        | RobotStateKind::ParallelVelocity
        | RobotStateKind::ParallelEffort => {
            let service = node
                .service_builder(&service_name)
                .publish_subscribe::<ParallelVector2>()
                .open_or_create()?;
            LeaderStateSubscriber::ParallelVector2(service.subscriber_builder().create()?)
        }
        _ => {
            let service = node
                .service_builder(&service_name)
                .publish_subscribe::<JointVector15>()
                .open_or_create()?;
            LeaderStateSubscriber::JointVector15(service.subscriber_builder().create()?)
        }
    })
}

fn create_command_publisher(
    node: &Node<ipc::Service>,
    topic: &str,
    kind: RobotCommandKind,
) -> Result<FollowerCommandPublisher, Box<dyn Error>> {
    let service_name: ServiceName = topic.try_into()?;
    Ok(match kind {
        RobotCommandKind::JointPosition => {
            let service = node
                .service_builder(&service_name)
                .publish_subscribe::<JointVector15>()
                .open_or_create()?;
            FollowerCommandPublisher::JointVector15(service.publisher_builder().create()?)
        }
        RobotCommandKind::JointMit => {
            let service = node
                .service_builder(&service_name)
                .publish_subscribe::<JointMitCommand15>()
                .open_or_create()?;
            FollowerCommandPublisher::JointMitCommand15(service.publisher_builder().create()?)
        }
        RobotCommandKind::ParallelPosition => {
            let service = node
                .service_builder(&service_name)
                .publish_subscribe::<ParallelVector2>()
                .open_or_create()?;
            FollowerCommandPublisher::ParallelVector2(service.publisher_builder().create()?)
        }
        RobotCommandKind::ParallelMit => {
            let service = node
                .service_builder(&service_name)
                .publish_subscribe::<ParallelMitCommand2>()
                .open_or_create()?;
            FollowerCommandPublisher::ParallelMitCommand2(service.publisher_builder().create()?)
        }
        RobotCommandKind::EndPose => {
            let service = node
                .service_builder(&service_name)
                .publish_subscribe::<Pose7>()
                .open_or_create()?;
            FollowerCommandPublisher::Pose7(service.publisher_builder().create()?)
        }
    })
}

fn create_control_subscriber(
    node: &Node<ipc::Service>,
) -> Result<ControlSubscriber, Box<dyn Error>> {
    let service_name: ServiceName = CONTROL_EVENTS_SERVICE.try_into()?;
    let service = node
        .service_builder(&service_name)
        .publish_subscribe::<ControlEvent>()
        .open_or_create()?;
    Ok(service.subscriber_builder().create()?)
}

fn drain_control_events(subscriber: &ControlSubscriber) -> Result<bool, Box<dyn Error>> {
    loop {
        match subscriber.receive()? {
            Some(sample) => {
                if matches!(*sample.payload(), ControlEvent::Shutdown) {
                    return Ok(true);
                }
            }
            None => return Ok(false),
        }
    }
}

fn drain_latest_state(
    subscriber: &LeaderStateSubscriber,
) -> Result<Option<LeaderState>, Box<dyn Error>> {
    let mut latest = None;
    match subscriber {
        LeaderStateSubscriber::JointVector15(subscriber) => loop {
            let Some(sample) = subscriber.receive()? else {
                return Ok(latest);
            };
            let payload = *sample.payload();
            latest = Some(LeaderState::Vector {
                timestamp_ms: payload.timestamp_ms,
                values: payload.values[..payload.len as usize].to_vec(),
            });
        },
        LeaderStateSubscriber::ParallelVector2(subscriber) => loop {
            let Some(sample) = subscriber.receive()? else {
                return Ok(latest);
            };
            let payload = *sample.payload();
            latest = Some(LeaderState::Vector {
                timestamp_ms: payload.timestamp_ms,
                values: payload.values[..payload.len as usize].to_vec(),
            });
        },
        LeaderStateSubscriber::Pose7(subscriber) => loop {
            let Some(sample) = subscriber.receive()? else {
                return Ok(latest);
            };
            latest = Some(LeaderState::Pose(*sample.payload()));
        },
    }
}

fn state_timestamp_ms(state: &LeaderState) -> u64 {
    match state {
        LeaderState::Vector { timestamp_ms, .. } => *timestamp_ms,
        LeaderState::Pose(payload) => payload.timestamp_ms,
    }
}

enum ForwardedCommand {
    JointPosition(JointVector15),
    JointMit(JointMitCommand15),
    ParallelPosition(ParallelVector2),
    ParallelMit(ParallelMitCommand2),
    EndPose(Pose7),
}

fn map_leader_state(
    config: &TeleopRuntimeConfigV2,
    state: &LeaderState,
) -> Result<Option<ForwardedCommand>, TeleopRouterError> {
    match config.mapping {
        MappingStrategy::Cartesian => match (state, config.follower_command_kind) {
            (LeaderState::Pose(pose), RobotCommandKind::EndPose) => {
                Ok(Some(ForwardedCommand::EndPose(*pose)))
            }
            _ => Err(TeleopRouterError::InvalidCartesianRoute),
        },
        MappingStrategy::DirectJoint => {
            let LeaderState::Vector {
                timestamp_ms,
                values,
            } = state
            else {
                return Err(TeleopRouterError::InvalidCartesianRoute);
            };
            let mapped = apply_joint_mapping(values, &config.joint_index_map, &config.joint_scales)?;
            Ok(Some(match config.follower_command_kind {
                RobotCommandKind::JointPosition => {
                    ForwardedCommand::JointPosition(JointVector15::from_slice(*timestamp_ms, &mapped))
                }
                RobotCommandKind::JointMit => ForwardedCommand::JointMit(joint_mit_command(
                    *timestamp_ms,
                    &mapped,
                    &config.command_defaults.joint_mit_kp,
                    &config.command_defaults.joint_mit_kd,
                )),
                RobotCommandKind::ParallelPosition => ForwardedCommand::ParallelPosition(
                    ParallelVector2::from_slice(*timestamp_ms, &mapped),
                ),
                RobotCommandKind::ParallelMit => ForwardedCommand::ParallelMit(parallel_mit_command(
                    *timestamp_ms,
                    &mapped,
                    &config.command_defaults.parallel_mit_kp,
                    &config.command_defaults.parallel_mit_kd,
                )),
                RobotCommandKind::EndPose => return Err(TeleopRouterError::InvalidCartesianRoute),
            }))
        }
    }
}

fn apply_joint_mapping(
    values: &[f64],
    joint_index_map: &[u32],
    joint_scales: &[f64],
) -> Result<Vec<f64>, TeleopRouterError> {
    let output_len = if !joint_index_map.is_empty() {
        joint_index_map.len()
    } else if !joint_scales.is_empty() {
        joint_scales.len()
    } else {
        values.len()
    };
    let mut mapped = Vec::with_capacity(output_len);
    for output_index in 0..output_len {
        let source_index = joint_index_map
            .get(output_index)
            .copied()
            .unwrap_or(output_index as u32) as usize;
        let Some(value) = values.get(source_index).copied() else {
            return Err(TeleopRouterError::LeaderValueOutOfRange {
                requested: source_index,
                available: values.len(),
            });
        };
        let scale = joint_scales.get(output_index).copied().unwrap_or(1.0);
        mapped.push(value * scale);
    }
    Ok(mapped)
}

fn joint_mit_command(
    timestamp_ms: u64,
    values: &[f64],
    kp: &[f64],
    kd: &[f64],
) -> JointMitCommand15 {
    let len = values.len().min(rollio_types::messages::MAX_DOF);
    let mut command = JointMitCommand15 {
        timestamp_ms,
        len: len as u32,
        ..JointMitCommand15::default()
    };
    command.position[..len].copy_from_slice(&values[..len]);
    for index in 0..len {
        command.kp[index] = kp.get(index).copied().unwrap_or(0.0);
        command.kd[index] = kd.get(index).copied().unwrap_or(0.0);
    }
    command
}

fn parallel_mit_command(
    timestamp_ms: u64,
    values: &[f64],
    kp: &[f64],
    kd: &[f64],
) -> ParallelMitCommand2 {
    let len = values.len().min(rollio_types::messages::MAX_PARALLEL);
    let mut command = ParallelMitCommand2 {
        timestamp_ms,
        len: len as u32,
        ..ParallelMitCommand2::default()
    };
    command.position[..len].copy_from_slice(&values[..len]);
    for index in 0..len {
        command.kp[index] = kp.get(index).copied().unwrap_or(0.0);
        command.kd[index] = kd.get(index).copied().unwrap_or(0.0);
    }
    command
}

fn publish_command(
    publisher: &FollowerCommandPublisher,
    command: ForwardedCommand,
) -> Result<(), Box<dyn Error>> {
    match (publisher, command) {
        (FollowerCommandPublisher::JointVector15(publisher), ForwardedCommand::JointPosition(command)) => {
            publisher.send_copy(command)?;
        }
        (FollowerCommandPublisher::JointMitCommand15(publisher), ForwardedCommand::JointMit(command)) => {
            publisher.send_copy(command)?;
        }
        (FollowerCommandPublisher::ParallelVector2(publisher), ForwardedCommand::ParallelPosition(command)) => {
            publisher.send_copy(command)?;
        }
        (FollowerCommandPublisher::ParallelMitCommand2(publisher), ForwardedCommand::ParallelMit(command)) => {
            publisher.send_copy(command)?;
        }
        (FollowerCommandPublisher::Pose7(publisher), ForwardedCommand::EndPose(command)) => {
            publisher.send_copy(command)?;
        }
        _ => return Err("teleop router produced a command type that does not match the configured publisher".into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rollio_types::config::ChannelCommandDefaults;

    fn direct_config() -> TeleopRuntimeConfigV2 {
        TeleopRuntimeConfigV2 {
            process_id: "teleop.test".into(),
            leader_channel_id: "leader/arm".into(),
            follower_channel_id: "follower/arm".into(),
            leader_state_kind: RobotStateKind::JointPosition,
            leader_state_topic: "leader/arm/states/joint_position".into(),
            follower_command_kind: RobotCommandKind::JointPosition,
            follower_command_topic: "follower/arm/commands/joint_position".into(),
            follower_state_kind: None,
            follower_state_topic: None,
            sync_max_step_rad: None,
            sync_complete_threshold_rad: None,
            mapping: MappingStrategy::DirectJoint,
            joint_index_map: Vec::new(),
            joint_scales: Vec::new(),
            command_defaults: ChannelCommandDefaults::default(),
        }
    }

    #[test]
    fn direct_joint_identity_mapping_preserves_positions() {
        let config = direct_config();
        let state = LeaderState::Vector {
            timestamp_ms: 123,
            values: vec![0.1, 0.2, 0.3],
        };
        let command = map_leader_state(&config, &state).expect("mapping should work");
        let Some(ForwardedCommand::JointPosition(command)) = command else {
            panic!("expected joint-position command");
        };
        assert_eq!(&command.values[..3], &[0.1, 0.2, 0.3]);
    }

    #[test]
    fn direct_joint_remap_reorders_source_joints() {
        let mut config = direct_config();
        config.joint_index_map = vec![2, 1, 0];
        let state = LeaderState::Vector {
            timestamp_ms: 123,
            values: vec![0.1, 0.2, 0.3],
        };
        let command = map_leader_state(&config, &state).expect("mapping should work");
        let Some(ForwardedCommand::JointPosition(command)) = command else {
            panic!("expected joint-position command");
        };
        assert_eq!(&command.values[..3], &[0.3, 0.2, 0.1]);
    }

    #[test]
    fn direct_joint_scaling_is_applied_per_output_joint() {
        let mut config = direct_config();
        config.joint_scales = vec![2.0, 1.0, 0.5];
        let state = LeaderState::Vector {
            timestamp_ms: 123,
            values: vec![0.1, 0.2, 0.6],
        };
        let command = map_leader_state(&config, &state).expect("mapping should work");
        let Some(ForwardedCommand::JointPosition(command)) = command else {
            panic!("expected joint-position command");
        };
        assert_eq!(command.values[0], 0.2);
        assert_eq!(command.values[2], 0.3);
    }

    #[test]
    fn direct_joint_mit_uses_default_gains() {
        let mut config = direct_config();
        config.follower_command_kind = RobotCommandKind::JointMit;
        config.command_defaults = ChannelCommandDefaults {
            joint_mit_kp: vec![10.0, 20.0, 30.0],
            joint_mit_kd: vec![1.0, 2.0, 3.0],
            parallel_mit_kp: Vec::new(),
            parallel_mit_kd: Vec::new(),
        };
        let state = LeaderState::Vector {
            timestamp_ms: 123,
            values: vec![0.1, 0.2, 0.3],
        };
        let command = map_leader_state(&config, &state).expect("mapping should work");
        let Some(ForwardedCommand::JointMit(command)) = command else {
            panic!("expected joint-mit command");
        };
        assert_eq!(&command.position[..3], &[0.1, 0.2, 0.3]);
        assert_eq!(&command.kp[..3], &[10.0, 20.0, 30.0]);
        assert_eq!(&command.kd[..3], &[1.0, 2.0, 3.0]);
    }

    #[test]
    fn cartesian_mapping_forwards_pose() {
        let mut config = direct_config();
        config.mapping = MappingStrategy::Cartesian;
        config.leader_state_kind = RobotStateKind::EndEffectorPose;
        config.follower_command_kind = RobotCommandKind::EndPose;
        let pose = Pose7 {
            timestamp_ms: 123,
            values: [0.3, 0.0, 0.5, 0.0, 0.0, 0.0, 1.0],
        };
        let command = map_leader_state(&config, &LeaderState::Pose(pose)).expect("mapping should work");
        let Some(ForwardedCommand::EndPose(command)) = command else {
            panic!("expected pose command");
        };
        assert_eq!(command.values, pose.values);
    }

    fn sync_config() -> TeleopRuntimeConfigV2 {
        let mut config = direct_config();
        config.follower_state_kind = Some(RobotStateKind::JointPosition);
        config.follower_state_topic = Some("follower/arm/states/joint_position".into());
        config.sync_max_step_rad = Some(0.005);
        config.sync_complete_threshold_rad = Some(0.01);
        config
    }

    #[test]
    fn sync_disabled_when_no_follower_state_configured() {
        let config = direct_config();
        let sync_state = SyncState::new(&config);
        assert!(!sync_state.enabled());
    }

    #[test]
    fn sync_enabled_when_follower_state_configured() {
        let config = sync_config();
        let sync_state = SyncState::new(&config);
        assert!(sync_state.enabled());
    }

    #[test]
    fn sync_clamps_command_to_max_step_when_far_from_target() {
        let config = sync_config();
        let mut sync_state = SyncState::new(&config);
        let mut command = ForwardedCommand::JointPosition(JointVector15::from_slice(
            123,
            &[0.5, -0.4, 0.3, 0.2, 0.1, 0.0],
        ));
        let follower = LeaderState::Vector {
            timestamp_ms: 100,
            values: vec![0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        };
        sync_state.apply(&mut command, Some(&follower), &config);
        let ForwardedCommand::JointPosition(command) = command else {
            panic!("expected joint-position command");
        };
        // Each joint should be at most 0.005 away from the corresponding
        // follower position (i.e. clamped from the leader's larger delta).
        let positions = &command.values[..6];
        for (i, value) in positions.iter().enumerate() {
            assert!(
                value.abs() <= 0.005 + f64::EPSILON,
                "joint {} clamped to {}, expected within 0.005 of follower (0.0)",
                i,
                value,
            );
        }
        // Sync remains active because the leader is still well above the
        // 0.01 rad completion threshold.
        assert!(sync_state.enabled());
    }

    #[test]
    fn sync_completes_once_within_threshold() {
        let config = sync_config();
        let mut sync_state = SyncState::new(&config);
        let mut command = ForwardedCommand::JointPosition(JointVector15::from_slice(
            123,
            &[0.005, 0.005, 0.005, 0.005, 0.005, 0.005],
        ));
        let follower = LeaderState::Vector {
            timestamp_ms: 100,
            values: vec![0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        };
        sync_state.apply(&mut command, Some(&follower), &config);
        // Once the difference is <= the configured threshold the router
        // exits the syncing phase.
        assert!(!sync_state.enabled());
    }

    #[test]
    fn sync_passes_through_when_no_follower_feedback() {
        // Even with sync configured, if the follower never reports a state
        // we do *not* clamp (and we stay in syncing mode for next cycle).
        let config = sync_config();
        let mut sync_state = SyncState::new(&config);
        let mut command = ForwardedCommand::JointPosition(JointVector15::from_slice(
            123,
            &[0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
        ));
        sync_state.apply(&mut command, None, &config);
        let ForwardedCommand::JointPosition(command) = command else {
            panic!("expected joint-position command");
        };
        assert_eq!(&command.values[..6], &[0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
        assert!(sync_state.enabled());
    }

    #[test]
    fn sync_passes_through_after_completion_even_for_big_jumps() {
        // Reflects the user spec: once sync completes, large diffs are
        // forwarded as-is because rate-limiting at this stage would inject
        // dangerous lag.
        let config = sync_config();
        let mut sync_state = SyncState::new(&config);
        sync_state.synced = true;
        let mut command = ForwardedCommand::JointPosition(JointVector15::from_slice(
            123,
            &[0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
        ));
        let follower = LeaderState::Vector {
            timestamp_ms: 100,
            values: vec![0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        };
        // Even though `apply` is reachable when synced is true, the higher
        // level loop only calls it while `enabled()` is true, so this test
        // documents the invariant rather than executing the rate limiter.
        assert!(!sync_state.enabled());
        sync_state.apply(&mut command, Some(&follower), &config);
        // Calling apply manually still clamps the values; the actual
        // pass-through behaviour comes from `enabled()` gating.
        let ForwardedCommand::JointPosition(command) = command else {
            panic!("expected joint-position command");
        };
        assert!(command.values[0] <= 0.005 + f64::EPSILON);
    }
}
