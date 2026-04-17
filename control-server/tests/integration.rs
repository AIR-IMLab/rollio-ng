//! Integration smoke tests for the control server config and protocol.

use rollio_control_server::{ControlServerConfig, ControlServerRole};

#[test]
fn config_round_trips_through_toml_for_setup_role() {
    let toml = "port = 4242\nrole = \"setup\"\n";
    let parsed: ControlServerConfig = toml::from_str(toml).expect("setup config parses");
    assert_eq!(parsed.port, 4242);
    assert!(matches!(parsed.role, ControlServerRole::Setup));
}

#[test]
fn config_round_trips_through_toml_for_collect_role() {
    let toml = "port = 4243\nrole = \"collect\"\n";
    let parsed: ControlServerConfig = toml::from_str(toml).expect("collect config parses");
    assert_eq!(parsed.port, 4243);
    assert!(matches!(parsed.role, ControlServerRole::Collect));
}
