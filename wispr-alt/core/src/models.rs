//! Whisper model catalog and first-run download.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

#[derive(Serialize, Clone, Copy, Debug)]
pub struct ModelInfo {
    pub id: &'static str,
    pub file: &'static str,
    pub label: &'static str,
    pub size_mb: u32,
    pub english_only: bool,
}

/// Large v3 Turbo (5-bit) is close to full Large v3 accuracy, and its small
/// decoder makes it fast on Apple Silicon with Metal.
pub const DEFAULT_MODEL: &str = "large-v3-turbo-q5_0";

pub const CATALOG: &[ModelInfo] = &[
    ModelInfo {
        id: "large-v3-turbo-q5_0",
        file: "ggml-large-v3-turbo-q5_0.bin",
        label: "Large v3 Turbo, compressed (best balance, recommended)",
        size_mb: 574,
        english_only: false,
    },
    ModelInfo {
        id: "large-v3-turbo",
        file: "ggml-large-v3-turbo.bin",
        label: "Large v3 Turbo, full (most accurate, biggest)",
        size_mb: 1620,
        english_only: false,
    },
    ModelInfo {
        id: "small.en",
        file: "ggml-small.en.bin",
        label: "Small, English only (good, lighter)",
        size_mb: 488,
        english_only: true,
    },
    ModelInfo {
        id: "base.en",
        file: "ggml-base.en.bin",
        label: "Base, English only (fastest, less accurate)",
        size_mb: 148,
        english_only: true,
    },
    ModelInfo {
        id: "small",
        file: "ggml-small.bin",
        label: "Small, multilingual",
        size_mb: 488,
        english_only: false,
    },
];

const BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

pub fn find(id: &str) -> Option<&'static ModelInfo> {
    CATALOG.iter().find(|m| m.id == id)
}

impl ModelInfo {
    pub fn url(&self) -> String {
        format!("{BASE_URL}/{}", self.file)
    }

    pub fn path_in(&self, dir: &Path) -> PathBuf {
        dir.join(self.file)
    }

    /// A file counts as downloaded once it's at least 90% of the expected size
    /// (a partial download is kept under a `.part` name, never this one).
    pub fn is_downloaded(&self, dir: &Path) -> bool {
        std::fs::metadata(self.path_in(dir))
            .map(|m| m.len() >= self.size_mb as u64 * 1_000_000 * 9 / 10)
            .unwrap_or(false)
    }
}

/// Downloads `model` into `dir`, calling `progress(downloaded, total)` as bytes
/// arrive. Writes to `<file>.part` and renames only when complete.
pub fn download(
    model: &ModelInfo,
    dir: &Path,
    cancel: &AtomicBool,
    progress: impl FnMut(u64, Option<u64>),
) -> Result<PathBuf> {
    download_from(&model.url(), &model.path_in(dir), cancel, progress)
}

pub fn download_from(
    url: &str,
    dest: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<PathBuf> {
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        // No overall timeout: big models take a while on slow connections.
        .timeout(None)
        .build()?;
    let mut resp = client
        .get(url)
        .send()
        .with_context(|| format!("couldn't reach {url}"))?;
    if !resp.status().is_success() {
        bail!("download failed: {} from {url}", resp.status());
    }
    let total = resp.content_length();
    let part = dest.with_extension("bin.part");
    let mut file = std::fs::File::create(&part)?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut done: u64 = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            drop(file);
            let _ = std::fs::remove_file(&part);
            bail!("download cancelled");
        }
        let n = resp.read(&mut buf)?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])?;
        done += n as u64;
        progress(done, total);
    }
    file.flush()?;
    drop(file);
    if let Some(t) = total {
        if done != t {
            let _ = std::fs::remove_file(&part);
            bail!("download ended early ({done} of {t} bytes)");
        }
    }
    std::fs::rename(&part, dest)?;
    Ok(dest.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::serve_once;

    #[test]
    fn catalog_is_consistent() {
        assert!(find(DEFAULT_MODEL).is_some());
        for m in CATALOG {
            assert!(m.file.starts_with("ggml-") && m.file.ends_with(".bin"));
            assert!(m.url().starts_with("https://huggingface.co/"));
        }
    }

    #[test]
    fn downloads_to_part_then_renames() {
        let body = vec![7u8; 600_000];
        let url = serve_once(200, "application/octet-stream", body.clone());
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("ggml-test.bin");
        let mut last = (0, None);
        let path = download_from(&url, &dest, &AtomicBool::new(false), |d, t| last = (d, t)).unwrap();
        assert_eq!(std::fs::read(path).unwrap(), body);
        assert_eq!(last, (600_000, Some(600_000)));
        assert!(!dest.with_extension("bin.part").exists());
    }

    #[test]
    fn http_errors_leave_nothing_behind() {
        let url = serve_once(404, "text/plain", b"nope".to_vec());
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("ggml-test.bin");
        assert!(download_from(&url, &dest, &AtomicBool::new(false), |_, _| {}).is_err());
        assert!(!dest.exists());
    }

    #[test]
    fn cancel_removes_partial_file() {
        let url = serve_once(200, "application/octet-stream", vec![1u8; 2_000_000]);
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("ggml-test.bin");
        let cancel = AtomicBool::new(false);
        let err = download_from(&url, &dest, &cancel, |_, _| cancel.store(true, Ordering::Relaxed));
        assert!(err.is_err());
        assert!(!dest.exists() && !dest.with_extension("bin.part").exists());
    }
}
