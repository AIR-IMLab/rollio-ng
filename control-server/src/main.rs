use std::error::Error;
use std::path::PathBuf;

use clap::Parser;
use rollio_control_server::{run, ControlServerConfig};

#[derive(Parser, Debug)]
#[command(name = "rollio-control-server")]
#[command(about = "WebSocket bridge for setup and collect control plane")]
struct Args {
    /// TOML file containing ControlServerConfig
    #[arg(long, value_name = "PATH", conflicts_with = "config_inline")]
    config: Option<PathBuf>,

    /// Inline TOML containing ControlServerConfig
    #[arg(long, value_name = "TOML", conflicts_with = "config")]
    config_inline: Option<String>,
}

fn load_config(args: &Args) -> Result<ControlServerConfig, Box<dyn Error>> {
    let raw = if let Some(path) = &args.config {
        std::fs::read_to_string(path)?
    } else if let Some(inline) = &args.config_inline {
        inline.clone()
    } else {
        return Err("control server requires --config or --config-inline".into());
    };
    Ok(toml::from_str(&raw)?)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args = Args::parse();
    let config = load_config(&args)?;
    log::info!(
        "control server starting on port {} as {:?}",
        config.port,
        config.role
    );
    run(config).await
}
