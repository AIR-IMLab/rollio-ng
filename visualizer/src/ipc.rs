/// iceoryx2 subscriber management for the Visualizer.
///
/// `IpcPoller` creates subscribers for camera frame and robot state topics,
/// then polls them in a non-blocking loop. Camera frame data is copied out
/// of shared memory once (unavoidable since we release the sample), while
/// robot state is a small fixed-size Copy type.
use iceoryx2::prelude::*;
use rollio_bus::{
    EPISODE_COMMAND_SERVICE, EPISODE_STATUS_SERVICE, SETUP_COMMAND_SERVICE, SETUP_STATE_SERVICE,
};
use rollio_types::config::{
    RobotStateKind, VisualizerCameraSourceConfig, VisualizerRobotSourceConfig,
};
use rollio_types::messages::{
    CameraFrameHeader, EpisodeCommand, EpisodeStatus, JointVector15, ParallelVector2, Pose7,
    SetupCommandMessage, SetupStateMessage,
};

/// A message received from iceoryx2.
pub enum IpcMessage {
    CameraFrame {
        name: String,
        header: CameraFrameHeader,
        data: Vec<u8>,
    },
    RobotStateMsg {
        name: String,
        state_kind: RobotStateKind,
        timestamp_ms: u64,
        values: Vec<f64>,
    },
    EpisodeStatusMsg {
        status: Box<EpisodeStatus>,
    },
    SetupStateMsg {
        payload_json: String,
    },
}

/// Manages iceoryx2 subscribers for camera and robot topics.
pub struct IpcPoller {
    node: Node<ipc::Service>,
    camera_subs: Vec<CameraSubscriber>,
    robot_subs: Vec<RobotSubscriber>,
    episode_status_subscriber:
        iceoryx2::port::subscriber::Subscriber<ipc::Service, EpisodeStatus, ()>,
    episode_command_publisher:
        iceoryx2::port::publisher::Publisher<ipc::Service, EpisodeCommand, ()>,
    setup_state_subscriber:
        iceoryx2::port::subscriber::Subscriber<ipc::Service, SetupStateMessage, ()>,
    setup_command_publisher:
        iceoryx2::port::publisher::Publisher<ipc::Service, SetupCommandMessage, ()>,
}

struct CameraSubscriber {
    name: String,
    subscriber: iceoryx2::port::subscriber::Subscriber<ipc::Service, [u8], CameraFrameHeader>,
}

struct RobotSubscriber {
    name: String,
    state_kind: RobotStateKind,
    subscriber: RobotStateSubscriber,
}

enum RobotStateSubscriber {
    JointVector15(
        iceoryx2::port::subscriber::Subscriber<ipc::Service, JointVector15, ()>,
    ),
    ParallelVector2(
        iceoryx2::port::subscriber::Subscriber<ipc::Service, ParallelVector2, ()>,
    ),
    Pose7(iceoryx2::port::subscriber::Subscriber<ipc::Service, Pose7, ()>),
}

impl IpcPoller {
    /// Create a new IpcPoller that subscribes to the given camera and robot topics.
    ///
    /// Uses `open_or_create` so the visualizer starts even if publishers don't exist yet.
    pub fn new(
        camera_sources: &[VisualizerCameraSourceConfig],
        robot_sources: &[VisualizerRobotSourceConfig],
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let node = NodeBuilder::new()
            .signal_handling_mode(SignalHandlingMode::Disabled)
            .create::<ipc::Service>()?;

        let mut camera_subs = Vec::with_capacity(camera_sources.len());
        for source in camera_sources {
            let service_name_str = source.frame_topic.clone();
            let service_name: ServiceName = service_name_str.as_str().try_into()?;

            let service = node
                .service_builder(&service_name)
                .publish_subscribe::<[u8]>()
                .user_header::<CameraFrameHeader>()
                .open_or_create()?;

            let subscriber = service.subscriber_builder().create()?;

            log::info!("subscribed to camera: {service_name_str}");
            camera_subs.push(CameraSubscriber {
                name: source.channel_id.clone(),
                subscriber,
            });
        }

        let mut robot_subs = Vec::with_capacity(robot_sources.len());
        for source in robot_sources {
            let service_name_str = source.state_topic.clone();
            let service_name: ServiceName = service_name_str.as_str().try_into()?;

            let subscriber = if source.state_kind.uses_pose_payload() {
                let service = node
                    .service_builder(&service_name)
                    .publish_subscribe::<Pose7>()
                    .open_or_create()?;
                RobotStateSubscriber::Pose7(service.subscriber_builder().create()?)
            } else if matches!(
                source.state_kind,
                RobotStateKind::ParallelPosition
                    | RobotStateKind::ParallelVelocity
                    | RobotStateKind::ParallelEffort
            ) {
                let service = node
                    .service_builder(&service_name)
                    .publish_subscribe::<ParallelVector2>()
                    .open_or_create()?;
                RobotStateSubscriber::ParallelVector2(service.subscriber_builder().create()?)
            } else {
                let service = node
                    .service_builder(&service_name)
                    .publish_subscribe::<JointVector15>()
                    .open_or_create()?;
                RobotStateSubscriber::JointVector15(service.subscriber_builder().create()?)
            };

            log::info!("subscribed to robot: {service_name_str}");
            robot_subs.push(RobotSubscriber {
                name: robot_source_name(source),
                state_kind: source.state_kind,
                subscriber,
            });
        }

        let episode_status_service_name: ServiceName = EPISODE_STATUS_SERVICE.try_into()?;
        let episode_status_service = node
            .service_builder(&episode_status_service_name)
            .publish_subscribe::<EpisodeStatus>()
            .open_or_create()?;
        let episode_status_subscriber = episode_status_service.subscriber_builder().create()?;

        let episode_command_service_name: ServiceName = EPISODE_COMMAND_SERVICE.try_into()?;
        let episode_command_service = node
            .service_builder(&episode_command_service_name)
            .publish_subscribe::<EpisodeCommand>()
            .open_or_create()?;
        let episode_command_publisher = episode_command_service.publisher_builder().create()?;

        let setup_state_service_name: ServiceName = SETUP_STATE_SERVICE.try_into()?;
        let setup_state_service = node
            .service_builder(&setup_state_service_name)
            .publish_subscribe::<SetupStateMessage>()
            .open_or_create()?;
        let setup_state_subscriber = setup_state_service.subscriber_builder().create()?;

        let setup_command_service_name: ServiceName = SETUP_COMMAND_SERVICE.try_into()?;
        let setup_command_service = node
            .service_builder(&setup_command_service_name)
            .publish_subscribe::<SetupCommandMessage>()
            .open_or_create()?;
        let setup_command_publisher = setup_command_service.publisher_builder().create()?;

        Ok(Self {
            node,
            camera_subs,
            robot_subs,
            episode_status_subscriber,
            episode_command_publisher,
            setup_state_subscriber,
            setup_command_publisher,
        })
    }

    /// Non-blocking poll of all subscribers. Returns all available messages.
    ///
    /// Drains each subscriber's queue completely before moving to the next.
    /// For camera frames, only the latest frame per camera is kept (skip older ones).
    pub fn poll(&self) -> Vec<IpcMessage> {
        let mut messages = Vec::new();

        // For cameras, we only want the latest frame (skip older ones to reduce latency)
        for cam in &self.camera_subs {
            let mut latest: Option<IpcMessage> = None;
            loop {
                match cam.subscriber.receive() {
                    Ok(Some(sample)) => {
                        let header = *sample.user_header();
                        let data = sample.payload().to_vec();
                        latest = Some(IpcMessage::CameraFrame {
                            name: cam.name.clone(),
                            header,
                            data,
                        });
                    }
                    Ok(None) => break,
                    Err(e) => {
                        log::warn!("camera {} receive error: {e}", cam.name);
                        break;
                    }
                }
            }
            if let Some(msg) = latest {
                messages.push(msg);
            }
        }

        // For robots, drain all messages (they're small and we want every state update)
        for robot in &self.robot_subs {
            let mut latest: Option<IpcMessage> = None;
            loop {
                match &robot.subscriber {
                    RobotStateSubscriber::JointVector15(subscriber) => match subscriber.receive() {
                        Ok(Some(sample)) => {
                            let payload = *sample.payload();
                            latest = Some(IpcMessage::RobotStateMsg {
                                name: robot.name.clone(),
                                state_kind: robot.state_kind,
                                timestamp_ms: payload.timestamp_ms,
                                values: payload.values[..payload.len as usize].to_vec(),
                            });
                        }
                        Ok(None) => break,
                        Err(e) => {
                            log::warn!("robot {} receive error: {e}", robot.name);
                            break;
                        }
                    },
                    RobotStateSubscriber::ParallelVector2(subscriber) => match subscriber.receive() {
                        Ok(Some(sample)) => {
                            let payload = *sample.payload();
                            latest = Some(IpcMessage::RobotStateMsg {
                                name: robot.name.clone(),
                                state_kind: robot.state_kind,
                                timestamp_ms: payload.timestamp_ms,
                                values: payload.values[..payload.len as usize].to_vec(),
                            });
                        }
                        Ok(None) => break,
                        Err(e) => {
                            log::warn!("robot {} receive error: {e}", robot.name);
                            break;
                        }
                    },
                    RobotStateSubscriber::Pose7(subscriber) => match subscriber.receive() {
                        Ok(Some(sample)) => {
                            let payload = *sample.payload();
                            latest = Some(IpcMessage::RobotStateMsg {
                                name: robot.name.clone(),
                                state_kind: robot.state_kind,
                                timestamp_ms: payload.timestamp_ms,
                                values: payload.values.to_vec(),
                            });
                        }
                        Ok(None) => break,
                        Err(e) => {
                            log::warn!("robot {} receive error: {e}", robot.name);
                            break;
                        }
                    },
                }
            }
            if let Some(msg) = latest {
                messages.push(msg);
            }
        }

        let mut latest_episode_status: Option<IpcMessage> = None;
        loop {
            match self.episode_status_subscriber.receive() {
                Ok(Some(sample)) => {
                    latest_episode_status = Some(IpcMessage::EpisodeStatusMsg {
                        status: Box::new(*sample.payload()),
                    });
                }
                Ok(None) => break,
                Err(e) => {
                    log::warn!("episode status receive error: {e}");
                    break;
                }
            }
        }
        if let Some(msg) = latest_episode_status {
            messages.push(msg);
        }

        let mut latest_setup_state: Option<IpcMessage> = None;
        loop {
            match self.setup_state_subscriber.receive() {
                Ok(Some(sample)) => {
                    latest_setup_state = Some(IpcMessage::SetupStateMsg {
                        payload_json: sample.payload().as_str().to_owned(),
                    });
                }
                Ok(None) => break,
                Err(e) => {
                    log::warn!("setup state receive error: {e}");
                    break;
                }
            }
        }
        if let Some(msg) = latest_setup_state {
            messages.push(msg);
        }

        messages
    }

    pub fn publish_episode_command(
        &self,
        command: EpisodeCommand,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.episode_command_publisher.send_copy(command)?;
        Ok(())
    }

    pub fn publish_setup_command(
        &self,
        command: SetupCommandMessage,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.setup_command_publisher.send_copy(command)?;
        Ok(())
    }

    /// Access the iceoryx2 node (for `node.wait()` in the poll loop).
    pub fn node(&self) -> &Node<ipc::Service> {
        &self.node
    }
}

fn robot_source_name(source: &VisualizerRobotSourceConfig) -> String {
    match source.state_kind {
        RobotStateKind::JointPosition => source.channel_id.clone(),
        other => format!("{}/{}", source.channel_id, other.topic_suffix()),
    }
}
