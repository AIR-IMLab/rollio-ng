use rollio_types::config::*;
use rollio_types::messages::PixelFormat;
use std::str::FromStr;

#[test]
fn parse_d435i_v4l2_airbot_play_eef_sprint5_config() {
    let toml_text = include_str!("../../config/config.d435i-v4l2-airbot-play-eef.sprint5.toml");
    let config =
        Config::from_str(toml_text).expect("mixed d435i + v4l2 sprint5 config should parse");

    assert_eq!(config.devices.len(), 6);
    assert_eq!(config.pairing.len(), 2);

    let realsense = config.device_named("camera_front_color").unwrap();
    assert_eq!(realsense.driver, "realsense");
    assert_eq!(realsense.stream.as_deref(), Some("color"));
    assert_eq!(realsense.pixel_format, Some(PixelFormat::Rgb24));

    let webcam = config.device_named("camera_webcam_front").unwrap();
    assert_eq!(webcam.driver, "v4l2");
    assert_eq!(webcam.id, "/dev/video0");
    assert_eq!(webcam.stream.as_deref(), None);
    assert_eq!(webcam.pixel_format, Some(PixelFormat::Rgb24));
    assert_eq!(webcam.transport.as_deref(), Some("usb"));

    assert_eq!(
        config.storage.output_path.as_deref(),
        Some("./output/d435i-v4l2-airbot-play-eef-sprint5")
    );

    let assembler_runtime = config.assembler_runtime_config(toml_text.to_string());
    assert_eq!(assembler_runtime.cameras.len(), 2);
}
