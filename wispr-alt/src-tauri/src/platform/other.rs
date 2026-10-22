use super::{paste_with, PasteOutcome, SettingsPane, Sound};
use anyhow::Result;

pub fn accessibility_trusted(_prompt: bool) -> bool {
    true
}

/// Off macOS the text is left on the clipboard for you to paste.
pub fn paste_text(text: &str, _restore: bool) -> Result<PasteOutcome> {
    paste_with(text, false, false, || Ok(()))
}

pub fn open_settings(_pane: SettingsPane) {}

pub fn open_url(url: &str) {
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
}

pub fn play(_sound: Sound) {}
