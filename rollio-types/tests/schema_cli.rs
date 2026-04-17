use rollio_types::schema::build_config_schema;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace root should resolve")
        .to_path_buf()
}

fn unique_temp_dir(prefix: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("{prefix}-{suffix}"));
    fs::create_dir_all(&path).expect("temp dir should be created");
    path
}

#[test]
fn schema_export_includes_nested_device_sections() {
    let schema = serde_json::to_value(build_config_schema()).expect("schema should serialize");
    let sections = schema["sections"]
        .as_array()
        .expect("schema sections should be an array");
    let section_names: Vec<_> = sections
        .iter()
        .filter_map(|section| section["name"].as_str())
        .collect();

    for required in [
        "root",
        "episode",
        "devices",
        "devices.channels",
        "pairings",
        "visualizer",
        "encoder",
        "storage",
        "ui",
    ] {
        assert!(
            section_names.contains(&required),
            "missing required section {required}: {section_names:?}"
        );
    }

    let devices = sections
        .iter()
        .find(|section| section["name"].as_str() == Some("devices"))
        .expect("devices section should exist");
    assert_eq!(devices["kind"], "array-of-tables");
    assert_eq!(devices["allows_extra_fields"], true);

    let channels = sections
        .iter()
        .find(|section| section["name"].as_str() == Some("devices.channels"))
        .expect("devices.channels section should exist");
    assert_eq!(channels["kind"], "array-of-tables");
}

#[test]
fn rollio_config_schema_command_outputs_valid_json() {
    let output = Command::new(env!("CARGO_BIN_EXE_rollio-config"))
        .arg("schema")
        .output()
        .expect("schema command should run");
    assert!(
        output.status.success(),
        "schema command should succeed, stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );

    let payload: Value =
        serde_json::from_slice(&output.stdout).expect("schema stdout should be valid JSON");
    assert_eq!(payload["format"], "rollio-config-schema");
    assert_eq!(payload["version"], 2);
}

#[test]
fn rollio_config_validate_accepts_example_config() {
    let example_config = workspace_root().join("config/config.example.toml");
    let output = Command::new(env!("CARGO_BIN_EXE_rollio-config"))
        .arg("validate")
        .arg("--config")
        .arg(&example_config)
        .output()
        .expect("validate command should run");
    assert!(
        output.status.success(),
        "validate should succeed, stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("config is valid"),
        "stdout should confirm success: {}",
        String::from_utf8_lossy(&output.stdout)
    );
}

#[test]
fn rollio_config_validate_reports_parse_errors() {
    let fixture_dir = unique_temp_dir("rollio-config-validate");
    let invalid_path = fixture_dir.join("invalid.toml");
    fs::write(&invalid_path, "[episode\nfps = 30\n").expect("invalid config should be written");

    let output = Command::new(env!("CARGO_BIN_EXE_rollio-config"))
        .arg("validate")
        .arg("--config")
        .arg(&invalid_path)
        .output()
        .expect("validate command should run");
    assert!(
        !output.status.success(),
        "validate should fail for invalid TOML"
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("TOML parse error"),
        "stderr should mention the parse error: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
