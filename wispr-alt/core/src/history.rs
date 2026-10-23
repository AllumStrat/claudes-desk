//! A short list of recent dictations, kept as JSON next to the settings.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Entry {
    /// Unix time in seconds.
    pub at: u64,
    /// What was pasted.
    pub text: String,
    /// What Whisper heard, before any cleanup.
    pub raw: String,
    pub audio_ms: u64,
    pub took_ms: u64,
    /// Set when the AI cleanup was skipped or failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct History {
    /// Newest first.
    pub entries: VecDeque<Entry>,
}

impl History {
    pub fn load(path: &Path) -> History {
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
        std::fs::write(&tmp, serde_json::to_string(self)?)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    pub fn push(&mut self, entry: Entry, limit: usize) {
        self.entries.push_front(entry);
        self.entries.truncate(limit);
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(text: &str) -> Entry {
        Entry { at: 1, text: text.into(), raw: text.into(), audio_ms: 1000, took_ms: 300, note: None }
    }

    #[test]
    fn newest_first_and_capped() {
        let mut h = History::default();
        for i in 0..5 {
            h.push(entry(&i.to_string()), 3);
        }
        let texts: Vec<_> = h.entries.iter().map(|e| e.text.as_str()).collect();
        assert_eq!(texts, ["4", "3", "2"]);
    }

    #[test]
    fn save_and_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");
        let mut h = History::default();
        h.push(entry("hello"), 10);
        h.save(&path).unwrap();
        assert_eq!(History::load(&path).entries, h.entries);
        assert!(History::load(&dir.path().join("missing.json")).entries.is_empty());
    }
}
