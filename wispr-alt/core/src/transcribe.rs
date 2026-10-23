//! Local speech-to-text with whisper.cpp.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState};

pub struct Transcriber {
    pub model_path: PathBuf,
    // Kept for the lifetime of the state below.
    _ctx: WhisperContext,
    state: Mutex<WhisperState>,
}

#[derive(Debug, Clone, Default)]
pub struct Options {
    /// Language code, or None to auto-detect.
    pub language: Option<String>,
    /// Spelling hints from the word list.
    pub initial_prompt: Option<String>,
    /// 0 picks a sensible number for this machine.
    pub threads: usize,
}

impl Transcriber {
    /// Loads a ggml model. Uses the GPU (Metal) when the crate was built with it.
    pub fn load(model_path: &Path) -> Result<Transcriber> {
        // Route whisper.cpp's chatty C logging through the (silent) log crate.
        whisper_rs::install_logging_hooks();
        // GPU (Metal) is on whenever the crate is built with the metal feature.
        let params = WhisperContextParameters::default();
        let path = model_path.to_str().context("model path isn't valid UTF-8")?;
        let ctx = WhisperContext::new_with_params(path, params)
            .with_context(|| format!("couldn't load the Whisper model at {}", model_path.display()))?;
        let state = ctx.create_state().context("couldn't start Whisper")?;
        Ok(Transcriber { model_path: model_path.to_path_buf(), _ctx: ctx, state: Mutex::new(state) })
    }

    /// Transcribes 16 kHz mono audio and returns the joined segment text.
    pub fn transcribe(&self, samples: &[f32], opts: &Options) -> Result<String> {
        // Large v3 Turbo has a 4-layer decoder, so beam search costs little and
        // noticeably helps with names and punctuation.
        let mut params = FullParams::new(SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 });
        params.set_language(Some(opts.language.as_deref().unwrap_or("auto")));
        if let Some(prompt) = &opts.initial_prompt {
            params.set_initial_prompt(prompt);
        }
        let threads = if opts.threads > 0 {
            opts.threads
        } else {
            std::thread::available_parallelism().map(|n| n.get().min(8)).unwrap_or(4)
        };
        params.set_n_threads(threads as i32);
        params.set_no_context(true);
        params.set_suppress_blank(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);

        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.full(params, samples).context("Whisper failed on this clip")?;
        let mut text = String::new();
        for segment in state.as_iter() {
            let s = segment.to_str_lossy().map(|c| c.into_owned()).unwrap_or_default();
            let s = s.trim();
            if !s.is_empty() {
                if !text.is_empty() {
                    text.push(' ');
                }
                text.push_str(s);
            }
        }
        Ok(text)
    }
}
