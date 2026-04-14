use std::error::Error;
use std::path::{Path, PathBuf};

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use clap::Parser;
use rollio_types::config::UiRuntimeConfig;
use serde::Serialize;
use tower_http::services::{ServeDir, ServeFile};

#[derive(Parser, Debug)]
#[command(name = "rollio-ui-server")]
#[command(about = "Serve the Rollio browser UI and runtime config")]
struct Args {
    /// TOML file containing UiRuntimeConfig
    #[arg(long, value_name = "PATH", conflicts_with = "config_inline")]
    config: Option<PathBuf>,

    /// Inline TOML containing UiRuntimeConfig
    #[arg(long, value_name = "TOML", conflicts_with = "config")]
    config_inline: Option<String>,

    /// Path to the built frontend assets
    #[arg(long, value_name = "PATH", default_value = "ui/web/dist")]
    asset_dir: PathBuf,
}

#[derive(Clone)]
struct AppState {
    runtime_config: BrowserRuntimeConfig,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct BrowserRuntimeConfig {
    websocket_url: String,
    episode_key_bindings: BrowserEpisodeKeyBindings,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct BrowserEpisodeKeyBindings {
    start_key: String,
    stop_key: String,
    keep_key: String,
    discard_key: String,
}

fn load_runtime_config(args: &Args) -> Result<UiRuntimeConfig, Box<dyn Error>> {
    let config = if let Some(config_path) = &args.config {
        std::fs::read_to_string(config_path)?.parse::<UiRuntimeConfig>()?
    } else if let Some(config_inline) = &args.config_inline {
        config_inline.parse::<UiRuntimeConfig>()?
    } else {
        UiRuntimeConfig::default()
    };

    Ok(config)
}

fn resolve_asset_dir(asset_dir: &Path) -> Result<PathBuf, Box<dyn Error>> {
    let resolved = if asset_dir.is_absolute() {
        asset_dir.to_path_buf()
    } else {
        std::env::current_dir()?.join(asset_dir)
    };

    if !resolved.exists() {
        return Err(format!(
            "web ui bundle not found at {}. Run `cd ui/web && npm run build` first.",
            resolved.display()
        )
        .into());
    }

    Ok(resolved)
}

fn browser_runtime_config(
    config: &UiRuntimeConfig,
) -> Result<BrowserRuntimeConfig, Box<dyn Error>> {
    let websocket_url = config
        .websocket_url
        .clone()
        .ok_or("ui runtime config did not produce a websocket url")?;

    Ok(BrowserRuntimeConfig {
        websocket_url,
        episode_key_bindings: BrowserEpisodeKeyBindings {
            start_key: config.start_key.clone(),
            stop_key: config.stop_key.clone(),
            keep_key: config.keep_key.clone(),
            discard_key: config.discard_key.clone(),
        },
    })
}

fn display_host(host: &str) -> &str {
    match host {
        "0.0.0.0" | "::" => "127.0.0.1",
        _ => host,
    }
}

async fn runtime_config_handler(State(state): State<AppState>) -> Json<BrowserRuntimeConfig> {
    Json(state.runtime_config)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let args = Args::parse();
    let runtime_config = load_runtime_config(&args)?;
    let asset_dir = resolve_asset_dir(&args.asset_dir)?;
    let index_file = asset_dir.join("index.html");
    if !index_file.exists() {
        return Err(format!(
            "web ui entrypoint not found at {}. Run `cd ui/web && npm run build` first.",
            index_file.display()
        )
        .into());
    }

    let state = AppState {
        runtime_config: browser_runtime_config(&runtime_config)?,
    };
    let app = Router::new()
        .route("/api/runtime-config", get(runtime_config_handler))
        .fallback_service(ServeDir::new(asset_dir).not_found_service(ServeFile::new(index_file)))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind((
        runtime_config.http_host.as_str(),
        runtime_config.http_port,
    ))
    .await?;
    eprintln!(
        "rollio: web ui available at http://{}:{}",
        display_host(&runtime_config.http_host),
        runtime_config.http_port
    );
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_args() -> Args {
        Args {
            config: None,
            config_inline: None,
            asset_dir: PathBuf::from("ui/web/dist"),
        }
    }

    #[test]
    fn default_runtime_config_loads() {
        let config = load_runtime_config(&empty_args()).expect("default config should load");
        assert_eq!(config.http_host, "127.0.0.1");
        assert_eq!(config.http_port, 3000);
    }

    #[test]
    fn browser_runtime_config_uses_existing_key_bindings() {
        let runtime_config = r#"
websocket_url = "ws://127.0.0.1:9090"
start_key = "s"
stop_key = "e"
keep_key = "k"
discard_key = "x"
http_host = "127.0.0.1"
http_port = 3000
"#
        .parse::<UiRuntimeConfig>()
        .expect("inline config should parse");

        let browser_config =
            browser_runtime_config(&runtime_config).expect("browser config should be built");

        assert_eq!(browser_config.websocket_url, "ws://127.0.0.1:9090");
        assert_eq!(browser_config.episode_key_bindings.start_key, "s");
        assert_eq!(browser_config.episode_key_bindings.discard_key, "x");
    }
}
