//! Linux unread indicators: a raster tray badge and Unity LauncherEntry count.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum UnreadBucket {
    #[default]
    None,
    Count(u8),
    NinePlus,
}

impl UnreadBucket {
    pub(crate) fn from_count(count: i64) -> Self {
        match count {
            ..=0 => Self::None,
            1..=9 => Self::Count(count as u8),
            _ => Self::NinePlus,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::None => "",
            Self::Count(1) => "1",
            Self::Count(2) => "2",
            Self::Count(3) => "3",
            Self::Count(4) => "4",
            Self::Count(5) => "5",
            Self::Count(6) => "6",
            Self::Count(7) => "7",
            Self::Count(8) => "8",
            Self::Count(9) => "9",
            Self::Count(_) => "9+",
            Self::NinePlus => "9+",
        }
    }
}

const BADGE_RED: [u8; 4] = [228, 30, 63, 255];
const WHITE: [u8; 4] = [255, 255, 255, 255];

// Three columns by five rows, most-significant row first. This deliberately
// tiny font stays legible when a desktop panel scales the 128 px source down.
fn glyph(character: char) -> [u8; 5] {
    match character {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b010, 0b010, 0b010],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        '+' => [0b000, 0b010, 0b111, 0b010, 0b000],
        _ => [0; 5],
    }
}

fn blend_pixel(pixel: &mut [u8], foreground: [u8; 4], coverage: u8) {
    let source_alpha = u32::from(foreground[3]) * u32::from(coverage) / 255;
    let destination_alpha = u32::from(pixel[3]);
    let output_alpha = source_alpha + destination_alpha * (255 - source_alpha) / 255;
    if output_alpha == 0 {
        pixel.fill(0);
        return;
    }
    for channel in 0..3 {
        let source = u32::from(foreground[channel]) * source_alpha;
        let destination =
            u32::from(pixel[channel]) * destination_alpha * (255 - source_alpha) / 255;
        pixel[channel] = ((source + destination) / output_alpha) as u8;
    }
    pixel[3] = output_alpha as u8;
}

/// Draw a red unread badge into an RGBA icon. The circle edge is sampled on a
/// 4×4 grid so it remains smooth after a panel downsizes the source pixmap.
pub(crate) fn draw_unread_badge(
    base_rgba: &[u8],
    width: u32,
    height: u32,
    bucket: UnreadBucket,
) -> Vec<u8> {
    assert_eq!(base_rgba.len(), width as usize * height as usize * 4);
    let mut pixels = base_rgba.to_vec();
    if bucket == UnreadBucket::None || width < 8 || height < 8 {
        return pixels;
    }

    let side = width.min(height) as f32;
    let diameter = side * 0.48;
    let radius = diameter / 2.0;
    let margin = (side * 0.015).max(1.0);
    let center_x = width as f32 - margin - radius;
    let center_y = height as f32 - margin - radius;
    let min_x = (center_x - radius - 1.0).max(0.0) as u32;
    let max_x = (center_x + radius + 1.0).min(width as f32 - 1.0) as u32;
    let min_y = (center_y - radius - 1.0).max(0.0) as u32;
    let max_y = (center_y + radius + 1.0).min(height as f32 - 1.0) as u32;

    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let mut inside = 0_u8;
            for sample_y in 0..4 {
                for sample_x in 0..4 {
                    let dx = x as f32 + (sample_x as f32 + 0.5) / 4.0 - center_x;
                    let dy = y as f32 + (sample_y as f32 + 0.5) / 4.0 - center_y;
                    if dx * dx + dy * dy <= radius * radius {
                        inside += 1;
                    }
                }
            }
            if inside > 0 {
                let offset = (y as usize * width as usize + x as usize) * 4;
                blend_pixel(
                    &mut pixels[offset..offset + 4],
                    BADGE_RED,
                    inside.saturating_mul(255) / 16,
                );
            }
        }
    }

    let label = bucket.label();
    let glyph_count = label.chars().count() as u32;
    let glyph_width = glyph_count * 3 + glyph_count.saturating_sub(1);
    let scale = ((diameter as u32 * 7 / 10) / glyph_width)
        .min((diameter as u32 * 3 / 5) / 5)
        .max(1);
    let text_width = glyph_width * scale;
    let text_height = 5 * scale;
    let start_x = (center_x - text_width as f32 / 2.0).round().max(0.0) as u32;
    let start_y = (center_y - text_height as f32 / 2.0).round().max(0.0) as u32;

    for (index, character) in label.chars().enumerate() {
        for (row, bits) in glyph(character).into_iter().enumerate() {
            for column in 0..3_u32 {
                if bits & (1 << (2 - column)) == 0 {
                    continue;
                }
                let glyph_x = (index as u32 * 4 + column) * scale;
                for offset_y in 0..scale {
                    for offset_x in 0..scale {
                        let x = start_x + glyph_x + offset_x;
                        let y = start_y + row as u32 * scale + offset_y;
                        if x < width && y < height {
                            let offset = (y as usize * width as usize + x as usize) * 4;
                            pixels[offset..offset + 4].copy_from_slice(&WHITE);
                        }
                    }
                }
            }
        }
    }

    pixels
}

pub(crate) fn unity_app_uri(flatpak_id: Option<&str>) -> String {
    let desktop_file = flatpak_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(|id| {
            if id.ends_with(".desktop") {
                id.to_string()
            } else {
                format!("{id}.desktop")
            }
        })
        .unwrap_or_else(|| "Carrier.desktop".to_string());
    format!("application://{desktop_file}")
}

#[cfg(target_os = "linux")]
enum LauncherUpdate {
    Set(i64),
    Clear(std::sync::mpsc::SyncSender<()>),
}

#[cfg(target_os = "linux")]
fn launcher_sender() -> &'static std::sync::mpsc::Sender<LauncherUpdate> {
    static SENDER: std::sync::OnceLock<std::sync::mpsc::Sender<LauncherUpdate>> =
        std::sync::OnceLock::new();
    SENDER.get_or_init(|| {
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("carrier-unity-badge".into())
            .spawn(move || launcher_worker(receiver))
            .expect("Unity badge worker starts");
        sender
    })
}

#[cfg(target_os = "linux")]
fn launcher_worker(receiver: std::sync::mpsc::Receiver<LauncherUpdate>) {
    let mut connection = None;
    let mut error_logged = false;
    while let Ok(update) = receiver.recv() {
        let (count, acknowledgement) = match update {
            LauncherUpdate::Set(count) => (count, None),
            LauncherUpdate::Clear(sender) => (0, Some(sender)),
        };
        if let Err(error) = emit_launcher_update(&mut connection, count) {
            if !error_logged {
                log::warn!("failed to update Linux launcher badge: {error}");
                error_logged = true;
            }
        } else {
            error_logged = false;
        }
        if let Some(sender) = acknowledgement {
            let _ = sender.send(());
        }
    }
}

#[cfg(target_os = "linux")]
fn emit_launcher_update(
    connection: &mut Option<zbus::blocking::Connection>,
    count: i64,
) -> Result<(), zbus::Error> {
    if connection.is_none() {
        *connection = Some(zbus::blocking::Connection::session()?);
    }
    let mut properties = std::collections::HashMap::new();
    properties.insert("count", zbus::zvariant::Value::from(count.max(0)));
    properties.insert("count-visible", zbus::zvariant::Value::from(count > 0));
    let app_uri = unity_app_uri(std::env::var("FLATPAK_ID").ok().as_deref());
    let result = connection.as_ref().unwrap().emit_signal(
        None::<&str>,
        "/com/canonical/Unity/LauncherEntry",
        "com.canonical.Unity.LauncherEntry",
        "Update",
        &(app_uri, properties),
    );
    if result.is_err() {
        *connection = None;
    }
    result
}

#[cfg(target_os = "linux")]
pub(crate) fn update_unity_launcher_count(count: i64) {
    let _ = launcher_sender().send(LauncherUpdate::Set(count.max(0)));
}

#[cfg(target_os = "linux")]
pub(crate) fn clear_unity_launcher_count() {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    if launcher_sender()
        .send(LauncherUpdate::Clear(sender))
        .is_ok()
    {
        let _ = receiver.recv_timeout(std::time::Duration::from_secs(1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transparent_icon(side: u32) -> Vec<u8> {
        vec![0; side as usize * side as usize * 4]
    }

    fn white_pixels(pixels: &[u8]) -> usize {
        pixels
            .chunks_exact(4)
            .filter(|pixel| *pixel == WHITE)
            .count()
    }

    #[test]
    fn unread_counts_are_bucketed_for_pixmap_caching() {
        assert_eq!(UnreadBucket::from_count(-1), UnreadBucket::None);
        assert_eq!(UnreadBucket::from_count(0), UnreadBucket::None);
        assert_eq!(UnreadBucket::from_count(1), UnreadBucket::Count(1));
        assert_eq!(UnreadBucket::from_count(9), UnreadBucket::Count(9));
        assert_eq!(UnreadBucket::from_count(10), UnreadBucket::NinePlus);
        assert_eq!(UnreadBucket::from_count(999), UnreadBucket::NinePlus);
    }

    #[test]
    fn zero_keeps_the_base_icon_untouched() {
        let base = vec![0x55; 32 * 32 * 4];
        assert_eq!(draw_unread_badge(&base, 32, 32, UnreadBucket::None), base);
    }

    #[test]
    fn circle_covers_the_expected_corner_area() {
        let pixels = draw_unread_badge(&transparent_icon(128), 128, 128, UnreadBucket::Count(1));
        let visible = pixels.chunks_exact(4).filter(|pixel| pixel[3] > 0).count();
        assert!((2_600..3_200).contains(&visible));
    }

    #[test]
    fn one_nine_and_nine_plus_render_distinct_digits() {
        let base = transparent_icon(128);
        let one = draw_unread_badge(&base, 128, 128, UnreadBucket::Count(1));
        let nine = draw_unread_badge(&base, 128, 128, UnreadBucket::Count(9));
        let nine_plus = draw_unread_badge(&base, 128, 128, UnreadBucket::NinePlus);
        assert!(white_pixels(&one) > 0);
        assert!(white_pixels(&nine) > white_pixels(&one));
        assert!(white_pixels(&nine_plus) > white_pixels(&nine));
        assert_ne!(one, nine);
        assert_ne!(nine, nine_plus);
    }

    #[test]
    fn launcher_uri_uses_the_flatpak_desktop_id_when_present() {
        assert_eq!(unity_app_uri(None), "application://Carrier.desktop");
        assert_eq!(
            unity_app_uri(Some("io.github.kristofferr.carrier")),
            "application://io.github.kristofferr.carrier.desktop"
        );
        assert_eq!(
            unity_app_uri(Some("io.github.kristofferr.carrier.desktop")),
            "application://io.github.kristofferr.carrier.desktop"
        );
    }
}
