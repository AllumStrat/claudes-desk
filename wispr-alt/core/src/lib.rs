//! Platform-independent core of Dictate.
//!
//! Everything here builds and tests on any OS. The Mac-only parts (microphone
//! capture, the global hotkey, pasting into other apps, permissions) live in
//! the Tauri app crate next door.

pub mod audio;
pub mod cleanup;
pub mod history;
pub mod models;
pub mod pipeline;
pub mod secrets;
pub mod settings;
#[cfg(feature = "whisper")]
pub mod transcribe;
pub mod words;

/// Whisper wants 16 kHz mono f32 samples.
pub const WHISPER_SAMPLE_RATE: u32 = 16_000;

#[cfg(test)]
mod testutil;
