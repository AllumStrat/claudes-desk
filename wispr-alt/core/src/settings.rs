//! User settings, stored as JSON in the app's config folder.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RecordMode {
    /// Hold the hotkey while talking, release to transcribe.
    Hold,
    /// Press once to start, press again to stop.
    Toggle,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CleanupProvider {
    Off,
    Groq,
    Gemini,
}

impl CleanupProvider {
    /// Name used for the keychain entry.
    pub fn key_name(self) -> Option<&'static str> {
        match self {
            CleanupProvider::Off => None,
            CleanupProvider::Groq => Some("groq"),
            CleanupProvider::Gemini => Some("gemini"),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct Settings {
    /// Global shortcut, in Tauri's format, e.g. "Alt+Space" (Option+Space on a Mac).
    pub hotkey: String,
    pub mode: RecordMode,
    /// Id from [`crate::models::CATALOG`].
    pub model: String,
    /// Whisper language code ("en", "es", ...) or "auto".
    pub language: String,
    /// Strip um/uh locally, no network needed.
    pub remove_fillers: bool,
    /// Optional AI cleanup pass. Off until a key is added.
    pub cleanup: CleanupProvider,
    pub groq_model: String,
    pub gemini_model: String,
    /// One entry per line. "Floorjack" teaches a spelling; "floor jack -> Floorjack"
    /// also rewrites what Whisper heard.
    pub words: Vec<String>,
    /// Put the old clipboard back after pasting.
    pub restore_clipboard: bool,
    /// Play a short sound when recording starts and stops.
    pub sounds: bool,
    pub history_limit: usize,
    /// Input device name; None means the system default.
    pub microphone: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            hotkey: "Alt+Space".into(),
            mode: RecordMode::Hold,
            model: crate::models::DEFAULT_MODEL.into(),
            language: "en".into(),
            remove_fillers: true,
            cleanup: CleanupProvider::Off,
            groq_model: "llama-3.3-70b-versatile".into(),
            gemini_model: "gemini-2.5-flash-lite".into(),
            words: vec!["Allum Strategies".into(), "Floorjack".into()],
            restore_clipboard: true,
            sounds: true,
            history_limit: 50,
            microphone: None,
        }
    }
}

impl Settings {
    /// Loads settings, falling back to defaults when the file is missing or
    /// unreadable (a broken file should never stop dictation from working).
    pub fn load(path: &Path) -> Settings {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    /// Whisper language parameter: None lets Whisper detect it.
    pub fn whisper_language(&self) -> Option<&str> {
        match self.language.trim() {
            "" | "auto" => None,
            l => Some(l),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_broken_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert_eq!(Settings::load(&path), Settings::default());
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(Settings::load(&path), Settings::default());
    }

    #[test]
    fn roundtrip_and_partial_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/settings.json");
        let mut s = Settings::default();
        s.mode = RecordMode::Toggle;
        s.cleanup = CleanupProvider::Groq;
        s.save(&path).unwrap();
        assert_eq!(Settings::load(&path), s);

        // Older files missing newer fields still load.
        std::fs::write(&path, r#"{"hotkey":"F5","mode":"toggle"}"#).unwrap();
        let s = Settings::load(&path);
        assert_eq!(s.hotkey, "F5");
        assert_eq!(s.mode, RecordMode::Toggle);
        assert_eq!(s.model, crate::models::DEFAULT_MODEL);
    }

    #[test]
    fn auto_language() {
        let mut s = Settings::default();
        assert_eq!(s.whisper_language(), Some("en"));
        s.language = "auto".into();
        assert_eq!(s.whisper_language(), None);
    }
}
