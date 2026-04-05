/// Color bar frame generator for test publisher.
///
/// Generates SMPTE-style color bar patterns.
/// Writes directly into a caller-provided buffer to avoid per-frame allocation.
///
/// Standard 8-bar color pattern: white, yellow, cyan, green, magenta, red, blue, black.
const BAR_COLORS: [(u8, u8, u8); 8] = [
    (255, 255, 255), // white
    (255, 255, 0),   // yellow
    (0, 255, 255),   // cyan
    (0, 255, 0),     // green
    (255, 0, 255),   // magenta
    (255, 0, 0),     // red
    (0, 0, 255),     // blue
    (0, 0, 0),       // black
];

/// Generate a color bar test pattern.
///
/// Writes RGB24 pixel data directly into `buf`.
/// `buf` must have length >= `width * height * 3`.
pub fn generate_color_bars(buf: &mut [u8], width: u32, height: u32) {
    let w = width as usize;
    let h = height as usize;
    debug_assert!(buf.len() >= w * h * 3);

    let bar_width = w / 8;

    for y in 0..h {
        let row_offset = y * w * 3;
        for x in 0..w {
            let bar_idx = if bar_width > 0 {
                (x / bar_width).min(7)
            } else {
                0
            };
            let (r, g, b) = BAR_COLORS[bar_idx];
            let px = row_offset + x * 3;
            buf[px] = r;
            buf[px + 1] = g;
            buf[px + 2] = b;
        }
    }
}
