//! Runs real audio through whisper.cpp. Needs a model file, so it only runs
//! when DICTATE_TEST_MODEL points at one:
//!
//!   DICTATE_TEST_MODEL=~/Library/Application\ Support/com.allumstrategies.dictate/models/ggml-base.en.bin \
//!     cargo test -p dictate-core --release --test whisper -- --nocapture

#![cfg(feature = "whisper")]

use dictate_core::{audio, pipeline, settings::Settings, transcribe::{Options, Transcriber}};
use std::path::PathBuf;

#[test]
fn transcribes_the_sample_clip() {
    let Ok(model) = std::env::var("DICTATE_TEST_MODEL") else {
        eprintln!("skipped: set DICTATE_TEST_MODEL to a ggml model file");
        return;
    };
    let wav = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../samples/jfk.wav");
    let (samples, rate, channels) = audio::read_wav(&wav).unwrap();
    let pcm = audio::prepare_for_whisper(&samples, rate, channels);
    let t = Transcriber::load(std::path::Path::new(&model)).unwrap();
    let raw = t
        .transcribe(&pcm, &Options { language: Some("en".into()), ..Default::default() })
        .unwrap();
    let out = pipeline::process(&raw, &Settings::default(), None);
    eprintln!("raw: {raw}\nfinal: {}", out.text);

    // whisper.cpp's test model has no weights and returns nothing; only a real
    // model is expected to understand the clip.
    let real_model = std::fs::metadata(&model).map(|m| m.len() > 50_000_000).unwrap_or(false);
    if real_model {
        assert!(out.text.to_lowercase().contains("ask not what your country can do for you"), "{}", out.text);
    }
}
