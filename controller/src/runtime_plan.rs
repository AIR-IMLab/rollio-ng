use crate::process::{ChildSpec, ResolvedCommand};
use crate::runtime_paths::{
    default_device_executable_name, resolve_program, resolve_registered_program,
};
use rollio_types::config::{
    AssemblerRuntimeConfigV2, BinaryDeviceConfig, CollectionMode, EncoderRuntimeConfigV2,
    ProjectConfig, StorageRuntimeConfig, TeleopRuntimeConfigV2,
};
use std::error::Error;
use std::ffi::OsString;
use std::path::Path;

pub(crate) fn build_collect_specs(
    config: &ProjectConfig,
    workspace_root: &Path,
    current_exe_dir: &Path,
) -> Result<Vec<ChildSpec>, Box<dyn Error>> {
    let mut specs = build_preview_specs(config, workspace_root, current_exe_dir)?;

    for encoder_config in config.encoder_runtime_configs_v2() {
        specs.push(build_encoder_spec(
            &encoder_config,
            workspace_root,
            current_exe_dir,
        )?);
    }

    let embedded_config_toml = toml::to_string(config)?;
    let assembler_config = config.assembler_runtime_config_v2(embedded_config_toml);
    specs.push(build_assembler_spec(
        &assembler_config,
        workspace_root,
        current_exe_dir,
    )?);

    let storage_config = config.storage_runtime_config();
    specs.push(build_storage_spec(
        &storage_config,
        workspace_root,
        current_exe_dir,
    )?);

    let ui_runtime_config = config.ui_runtime_config();
    let web_bundle_dir = workspace_root.join("ui/web/dist");
    let web_index = web_bundle_dir.join("index.html");
    if !web_index.exists() {
        return Err(format!(
            "Web UI bundle not found at {}. Run `cd ui/web && npm run build` first.",
            web_index.display()
        )
        .into());
    }

    ui_runtime_config
        .websocket_url
        .as_ref()
        .ok_or("ui runtime config did not produce an upstream websocket url")?;
    eprintln!(
        "rollio: web ui available at {}",
        ui_browser_url(&ui_runtime_config.http_host, ui_runtime_config.http_port)
    );
    specs.push(ChildSpec {
        id: "ui".into(),
        command: ResolvedCommand {
            program: resolve_program(current_exe_dir.join("rollio-ui-server"), "rollio-ui-server"),
            args: vec![
                OsString::from("--config-inline"),
                OsString::from(toml::to_string(&ui_runtime_config)?),
                OsString::from("--asset-dir"),
                web_bundle_dir.into_os_string(),
            ],
        },
        working_directory: workspace_root.to_path_buf(),
        inherit_stdio: false,
    });

    Ok(specs)
}

pub(crate) fn build_preview_specs(
    config: &ProjectConfig,
    workspace_root: &Path,
    current_exe_dir: &Path,
) -> Result<Vec<ChildSpec>, Box<dyn Error>> {
    let mut specs = Vec::new();

    specs.push(build_visualizer_spec(
        config,
        workspace_root,
        current_exe_dir,
    )?);

    for device in &config.devices {
        specs.push(build_device_spec(device, workspace_root, current_exe_dir)?);
    }

    if config.mode == CollectionMode::Teleop {
        for teleop_config in config.teleop_runtime_configs_v2() {
            specs.push(build_teleop_spec(
                &teleop_config,
                workspace_root,
                current_exe_dir,
            )?);
        }
    }

    Ok(specs)
}

pub(crate) fn build_visualizer_spec(
    config: &ProjectConfig,
    workspace_root: &Path,
    current_exe_dir: &Path,
) -> Result<ChildSpec, Box<dyn Error>> {
    let visualizer_config = toml::to_string(&config.visualizer_runtime_config_v2())?;
    Ok(ChildSpec {
        id: "visualizer".into(),
        command: ResolvedCommand {
            program: resolve_program(
                current_exe_dir.join("rollio-visualizer"),
                "rollio-visualizer",
            ),
            args: vec![
                OsString::from("--config-inline"),
                OsString::from(visualizer_config),
            ],
        },
        working_directory: workspace_root.to_path_buf(),
        inherit_stdio: false,
    })
}

pub(crate) fn build_device_spec(
    device: &BinaryDeviceConfig,
    workspace_root: &Path,
    current_exe_dir: &Path,
) -> Result<ChildSpec, Box<dyn Error>> {
    let inline_config = toml::to_string(device)?;
    let executable_name = device
        .executable
        .clone()
        .unwrap_or_else(|| default_device_executable_name(&device.driver));
    let program = resolve_registered_program(&executable_name, workspace_root, current_exe_dir);
    let common_args = vec![
        OsString::from("run"),
        OsString::from("--config-inline"),
        OsString::from(inline_config),
    ];

    Ok(ChildSpec {
        id: format!("device-{}", device.name),
        command: ResolvedCommand {
            program,
            args: common_args,
        },
        working_directory: workspace_root.to_path_buf(),
        inherit_stdio: false,
    })
}

pub(crate) fn build_teleop_spec(
    config: &TeleopRuntimeConfigV2,
    workspace_root: &Path,
    current_exe_dir: &Path,
) -> Result<ChildSpec, Box<dyn Error>> {
    let inline_config = toml::to_string(config)?;

    Ok(ChildSpec {
        id: format!("teleop-{}", config.process_id),
        command: ResolvedCommand {
            program: resolve_program(
                current_exe_dir.join("rollio-teleop-router"),
                "rollio-teleop-router",
            ),
            args: vec![
                OsString::from("run"),
                OsString::from("--config-inline"),
                OsString::from(inline_config),
            ],
        },
        working_directory: workspace_root.to_path_buf(),
        inherit_stdio: false,
    })
}

pub(crate) fn build_encoder_spec(
    config: &EncoderRuntimeConfigV2,
    workspace_root: &Path,
    current_exe_dir: &Path,
) -> Result<ChildSpec, Box<dyn Error>> {
    let inline_config = toml::to_string(config)?;
    Ok(ChildSpec {
        id: format!("encoder-{}", config.channel_id.replace('/', "-")),
        command: ResolvedCommand {
            program: resolve_program(current_exe_dir.join("rollio-encoder"), "rollio-encoder"),
            args: vec![
                OsString::from("run"),
                OsString::from("--config-inline"),
                OsString::from(inline_config),
            ],
        },
        working_directory: workspace_root.to_path_buf(),
        inherit_stdio: false,
    })
}

pub(crate) fn build_assembler_spec(
    config: &AssemblerRuntimeConfigV2,
    workspace_root: &Path,
    current_exe_dir: &Path,
) -> Result<ChildSpec, Box<dyn Error>> {
    let inline_config = toml::to_string(config)?;
    Ok(ChildSpec {
        id: "assembler".into(),
        command: ResolvedCommand {
            program: resolve_program(
                current_exe_dir.join("rollio-episode-assembler"),
                "rollio-episode-assembler",
            ),
            args: vec![
                OsString::from("run"),
                OsString::from("--config-inline"),
                OsString::from(inline_config),
            ],
        },
        working_directory: workspace_root.to_path_buf(),
        inherit_stdio: false,
    })
}

pub(crate) fn build_storage_spec(
    config: &StorageRuntimeConfig,
    workspace_root: &Path,
    current_exe_dir: &Path,
) -> Result<ChildSpec, Box<dyn Error>> {
    let inline_config = toml::to_string(config)?;
    Ok(ChildSpec {
        id: "storage".into(),
        command: ResolvedCommand {
            program: resolve_program(current_exe_dir.join("rollio-storage"), "rollio-storage"),
            args: vec![
                OsString::from("run"),
                OsString::from("--config-inline"),
                OsString::from(inline_config),
            ],
        },
        working_directory: workspace_root.to_path_buf(),
        inherit_stdio: false,
    })
}

pub(crate) fn ui_browser_url(host: &str, port: u16) -> String {
    let display_host = match host {
        "0.0.0.0" | "::" => "127.0.0.1",
        _ => host,
    };
    format!("http://{display_host}:{port}")
}
