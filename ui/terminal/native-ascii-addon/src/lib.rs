use std::time::Instant;

use ascii_video_renderer::ascii::AsciiGrid;
use ascii_video_renderer::engine::{
    AsciiEngine, RenderAlgorithm, RenderRasterDimensions, RenderPixelFormat,
};
use napi::bindgen_prelude::{Buffer, Error, Result};
use napi_derive::napi;

fn to_napi_error(error: impl std::fmt::Display) -> Error {
    Error::from_reason(error.to_string())
}

fn saturating_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn parse_algorithm(algorithm_id: &str) -> Result<RenderAlgorithm> {
    RenderAlgorithm::from_id(algorithm_id)
        .ok_or_else(|| to_napi_error(format!("unknown render algorithm id: {algorithm_id}")))
}

#[napi(object)]
pub struct NativeAsciiRenderStats {
    pub total_ms: f64,
    pub sample_ms: Option<f64>,
    pub lookup_ms: Option<f64>,
    pub sample_count: u32,
    pub lookup_count: u32,
    pub cache_hits: u32,
    pub cache_misses: u32,
    pub cell_count: u32,
    pub output_bytes: u32,
    pub sgr_change_count: Option<u32>,
    pub assemble_ms: Option<f64>,
}

#[napi(object)]
pub struct NativeAsciiRenderResult {
    pub lines: Vec<String>,
    pub stats: NativeAsciiRenderStats,
}

#[napi(object)]
pub struct NativeAsciiRasterDimensions {
    pub width: u32,
    pub height: u32,
}

#[napi(object)]
pub struct NativeAsciiRenderLayout {
    pub columns: u32,
    pub rows: u32,
}

fn raster_to_napi(raster: RenderRasterDimensions) -> NativeAsciiRasterDimensions {
    NativeAsciiRasterDimensions {
        width: saturating_u32(raster.width),
        height: saturating_u32(raster.height),
    }
}

#[napi(js_name = "pixelFormatForAlgorithm")]
pub fn pixel_format_for_algorithm(algorithm_id: String) -> Result<String> {
    let algorithm = parse_algorithm(&algorithm_id)?;
    Ok(match algorithm.pixel_format() {
        RenderPixelFormat::Luma8 => "luma8",
        RenderPixelFormat::Rgb24 => "rgb24",
    }
    .to_string())
}

#[napi(js_name = "describeRasterForAlgorithm")]
pub fn describe_raster_for_algorithm(
    algorithm_id: String,
    cell_aspect: f64,
    columns: u32,
    rows: u32,
) -> Result<NativeAsciiRasterDimensions> {
    let algorithm = parse_algorithm(&algorithm_id)?;
    Ok(raster_to_napi(algorithm.describe_raster(
        AsciiGrid {
            columns: columns as usize,
            rows: rows as usize,
        },
        cell_aspect as f32,
    )))
}

#[napi(js_name = "layoutForRasterForAlgorithm")]
pub fn layout_for_raster_for_algorithm(
    algorithm_id: String,
    cell_aspect: f64,
    width: u32,
    height: u32,
) -> Result<NativeAsciiRenderLayout> {
    let algorithm = parse_algorithm(&algorithm_id)?;
    let layout = algorithm.layout_for_raster(
        RenderRasterDimensions {
            width: width as usize,
            height: height as usize,
        },
        cell_aspect as f32,
    );
    Ok(NativeAsciiRenderLayout {
        columns: saturating_u32(layout.columns),
        rows: saturating_u32(layout.rows),
    })
}

#[napi]
pub struct NativeAsciiRenderer {
    engine: AsciiEngine,
}

#[napi]
impl NativeAsciiRenderer {
    #[napi(constructor)]
    pub fn new(algorithm_id: String, cell_aspect: f64) -> Result<Self> {
        let algorithm = parse_algorithm(&algorithm_id)?;
        let engine = AsciiEngine::new(algorithm, cell_aspect as f32).map_err(to_napi_error)?;
        Ok(Self { engine })
    }

    #[napi]
    pub fn render(
        &mut self,
        pixels: Buffer,
        width: u32,
        height: u32,
        columns: u32,
        rows: u32,
    ) -> Result<NativeAsciiRenderResult> {
        let started_at = Instant::now();
        let grid = AsciiGrid {
            columns: columns as usize,
            rows: rows as usize,
        };
        let frame = if self.engine.algorithm().needs_rgb_frames() {
            self.engine
                .render_rgb_ansi(pixels.as_ref(), width as usize, height as usize, grid)
        } else {
            self.engine
                .render_grayscale_ansi(pixels.as_ref(), width as usize, height as usize, grid)
        }
        .map_err(to_napi_error)?;

        Ok(NativeAsciiRenderResult {
            stats: NativeAsciiRenderStats {
                total_ms: frame
                    .stats
                    .timings
                    .total_ms
                    .max(started_at.elapsed().as_secs_f64() * 1_000.0),
                sample_ms: frame.stats.timings.sample_ms,
                lookup_ms: frame.stats.timings.lookup_ms,
                sample_count: saturating_u32(frame.stats.sample_count),
                lookup_count: saturating_u32(frame.stats.lookup_count),
                cache_hits: saturating_u32(frame.stats.cache_hits),
                cache_misses: saturating_u32(frame.stats.cache_misses),
                cell_count: saturating_u32(frame.stats.cell_count),
                output_bytes: saturating_u32(frame.stats.output_bytes),
                sgr_change_count: frame.stats.sgr_change_count.map(saturating_u32),
                assemble_ms: frame.stats.timings.assemble_ms,
            },
            lines: frame.rows,
        })
    }
}
