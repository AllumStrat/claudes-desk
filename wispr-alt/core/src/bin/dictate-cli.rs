//! Command-line check of the Dictate pipeline, no GUI or permissions needed.
//!
//!   dictate-cli models
//!   dictate-cli download [model-id] [--dir DIR]
//!   dictate-cli transcribe FILE.wav [--model PATH_OR_ID] [--words "Allum,Floorjack"]
//!                          [--language en] [--keep-fillers]
//!   dictate-cli clean "some text" [--words ...] [--keep-fillers]
//!
//! AI cleanup runs when GROQ_API_KEY or GEMINI_API_KEY is set in the environment.

use anyhow::{bail, Context, Result};
use dictate_core::{cleanup, models, pipeline, settings::{CleanupProvider, Settings}};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

fn default_models_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| ".".into());
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/com.allumstrategies.dictate/models")
    } else {
        home.join(".local/share/com.allumstrategies.dictate/models")
    }
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn settings_from(args: &[String]) -> Settings {
    let mut s = Settings::default();
    if let Some(w) = flag(args, "--words") {
        s.words = w.split(',').map(|x| x.trim().to_string()).collect();
    }
    if let Some(l) = flag(args, "--language") {
        s.language = l;
    }
    if args.iter().any(|a| a == "--keep-fillers") {
        s.remove_fillers = false;
    }
    s
}

fn llm_from_env(s: &Settings) -> Option<cleanup::LlmConfig> {
    if let Ok(k) = std::env::var("GROQ_API_KEY") {
        return Some(cleanup::LlmConfig::new(CleanupProvider::Groq, k, s.groq_model.clone()));
    }
    if let Ok(k) = std::env::var("GEMINI_API_KEY") {
        return Some(cleanup::LlmConfig::new(CleanupProvider::Gemini, k, s.gemini_model.clone()));
    }
    None
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("models") => {
            let dir = default_models_dir();
            for m in models::CATALOG {
                let mark = if m.is_downloaded(&dir) { "downloaded" } else { "" };
                println!("{:<22} {:>5} MB  {}  {}", m.id, m.size_mb, m.label, mark);
            }
            println!("\nModels folder: {}", dir.display());
        }
        Some("download") => {
            let id = args.get(1).filter(|a| !a.starts_with("--")).map(String::as_str).unwrap_or(models::DEFAULT_MODEL);
            let m = models::find(id).with_context(|| format!("unknown model {id}; run `dictate-cli models`"))?;
            let dir = flag(&args, "--dir").map(PathBuf::from).unwrap_or_else(default_models_dir);
            let mut last = 0;
            let path = models::download(m, &dir, &AtomicBool::new(false), |done, total| {
                let mb = done / 1_000_000;
                if mb >= last + 25 {
                    last = mb;
                    match total {
                        Some(t) => eprintln!("  {mb} / {} MB", t / 1_000_000),
                        None => eprintln!("  {mb} MB"),
                    }
                }
            })?;
            println!("Saved {}", path.display());
        }
        Some("transcribe") => transcribe(&args)?,
        Some("clean") => {
            let text = args.get(1).context("give the text to clean")?;
            let s = settings_from(&args);
            let p = pipeline::process(text, &s, llm_from_env(&s).as_ref());
            println!("{}", p.text);
            if let Some(n) = p.note {
                eprintln!("note: {n}");
            }
        }
        _ => {
            eprintln!("usage: dictate-cli models | download [id] | transcribe FILE.wav [--model ..] | clean TEXT");
            std::process::exit(2);
        }
    }
    Ok(())
}

#[cfg(feature = "whisper")]
fn transcribe(args: &[String]) -> Result<()> {
    use dictate_core::{audio, transcribe::{Options, Transcriber}, words};
    let wav = args.get(1).context("give a .wav file")?;
    let model_arg = flag(args, "--model").unwrap_or_else(|| models::DEFAULT_MODEL.to_string());
    let model_path = match models::find(&model_arg) {
        Some(m) => m.path_in(&default_models_dir()),
        None => PathBuf::from(&model_arg),
    };
    if !model_path.exists() {
        bail!("no model at {}; run `dictate-cli download`", model_path.display());
    }
    let s = settings_from(args);
    let (samples, rate, channels) = audio::read_wav(std::path::Path::new(wav))?;
    let pcm = audio::prepare_for_whisper(&samples, rate, channels);

    let t0 = std::time::Instant::now();
    let tr = Transcriber::load(&model_path)?;
    let load_ms = t0.elapsed().as_millis();
    let t1 = std::time::Instant::now();
    let raw = tr.transcribe(
        &pcm,
        &Options {
            language: s.whisper_language().map(String::from),
            initial_prompt: words::whisper_prompt(&words::parse(&s.words)),
            threads: 0,
        },
    )?;
    let tx_ms = t1.elapsed().as_millis();
    let p = pipeline::process(&raw, &s, llm_from_env(&s).as_ref());
    println!("raw:   {raw}");
    println!("final: {}", p.text);
    if let Some(n) = p.note {
        println!("note:  {n}");
    }
    eprintln!("model load {load_ms} ms, transcription {tx_ms} ms, audio {} ms", audio::duration_ms(pcm.len(), 16_000));
    Ok(())
}

#[cfg(not(feature = "whisper"))]
fn transcribe(_: &[String]) -> Result<()> {
    bail!("built without the whisper feature")
}
