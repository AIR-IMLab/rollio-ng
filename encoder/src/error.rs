use ffmpeg_next as ffmpeg;
use rollio_types::config::ConfigError;
use std::fmt::Display;
use thiserror::Error;

pub type Result<T> = std::result::Result<T, EncoderError>;

#[derive(Debug, Error)]
pub enum EncoderError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Ffmpeg(#[from] ffmpeg::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Rvl(#[from] rvl::CodecError),
    #[error("{0}")]
    Message(String),
}

impl EncoderError {
    pub fn message(message: impl Into<String>) -> Self {
        Self::Message(message.into())
    }
}

pub fn map_iceoryx_error<E: Display>(error: E) -> EncoderError {
    EncoderError::message(format!("iceoryx2 error: {error}"))
}
