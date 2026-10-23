//! Dictate: a menu bar app. Hold the hotkey, talk, let go, and the text is
//! pasted wherever your cursor is. Transcription runs locally with whisper.cpp.

mod platform;
mod recorder;

use dictate_core::cleanup::LlmConfig;
use dictate_core::history::{self, History};
use dictate_core::settings::{CleanupProvider, RecordMode, Settings};
use dictate_core::transcribe::{Options, Transcriber};
use dictate_core::{audio, models, pipeline, secrets, words};
use platform::{PasteOutcome, SettingsPane, Sound};
use recorder::{Recorder, Recording};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Clips shorter than this are treated as an accidental tap.
const MIN_CLIP_MS: u64 = 300;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Idle,
    Recording,
    Transcribing,
}

struct Paths {
    settings: PathBuf,
    history: PathBuf,
    models: PathBuf,
}

struct AppState {
    paths: Paths,
    settings: Mutex<Settings>,
    history: Mutex<History>,
    recorder: Recorder,
    phase: Mutex<Phase>,
    /// The loaded Whisper model, keyed by model id.
    engine: Mutex<Option<(String, Arc<Transcriber>)>>,
    /// API keys read from the Keychain, cached so dictation doesn't hit it each time.
    keys: Mutex<HashMap<String, Option<String>>>,
    downloading: Mutex<Option<String>>,
    cancel_download: Arc<AtomicBool>,
    status_item: Mutex<Option<MenuItem<Wry>>>,
    last_error: Mutex<Option<String>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl AppState {
    fn settings(&self) -> Settings {
        lock(&self.settings).clone()
    }

    fn api_key(&self, provider: CleanupProvider) -> Option<String> {
        let name = provider.key_name()?;
        let mut keys = lock(&self.keys);
        keys.entry(name.to_string()).or_insert_with(|| secrets::get(name)).clone()
    }

    fn llm_config(&self, s: &Settings) -> Option<LlmConfig> {
        let model = match s.cleanup {
            CleanupProvider::Off => return None,
            CleanupProvider::Groq => s.groq_model.clone(),
            CleanupProvider::Gemini => s.gemini_model.clone(),
        };
        let key = self.api_key(s.cleanup)?;
        Some(LlmConfig::new(s.cleanup, key, model))
    }

    fn model_ready(&self, id: &str) -> bool {
        models::find(id).is_some_and(|m| m.is_downloaded(&self.paths.models))
    }
}

/// Shows "⌥Space" instead of "Alt+Space" in menus and messages.
fn pretty_hotkey(hotkey: &str) -> String {
    hotkey
        .split('+')
        .map(|part| match part.trim().to_ascii_lowercase().as_str() {
            "alt" | "option" => "⌥".to_string(),
            "shift" => "⇧".to_string(),
            "control" | "ctrl" => "⌃".to_string(),
            "super" | "cmd" | "command" | "meta" | "commandorcontrol" | "cmdorctrl" => "⌘".to_string(),
            other => {
                let p = part.trim();
                let p = p.strip_prefix("Key").or_else(|| p.strip_prefix("Digit")).unwrap_or(p);
                if other == "space" { "Space".into() } else { p.to_string() }
            }
        })
        .collect()
}

// ---------------------------------------------------------------- status

fn set_phase(app: &AppHandle, phase: Phase) {
    let state = app.state::<AppState>();
    *lock(&state.phase) = phase;
    let s = state.settings();
    let hk = pretty_hotkey(&s.hotkey);
    let (title, menu_text) = match phase {
        Phase::Idle if !state.model_ready(&s.model) => (None, "Set up needed: open Dictate".to_string()),
        Phase::Idle => (
            None,
            match s.mode {
                RecordMode::Hold => format!("Ready: hold {hk} and talk"),
                RecordMode::Toggle => format!("Ready: press {hk} to start"),
            },
        ),
        Phase::Recording => (Some("● REC"), format!("Listening… release {hk} when done")),
        Phase::Transcribing => (Some("…"), "Transcribing…".to_string()),
    };
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_title(title);
        let _ = tray.set_tooltip(Some(format!("Dictate: {menu_text}")));
    }
    if let Some(item) = lock(&state.status_item).as_ref() {
        let _ = item.set_text(&menu_text);
    }
    let _ = app.emit("status", serde_json::json!({ "phase": phase, "text": menu_text }));
}

/// Shows a problem in the window (and the tray tooltip) without stealing focus
/// from the app the user is typing in.
fn report(app: &AppHandle, message: impl Into<String>) {
    let message = message.into();
    eprintln!("dictate: {message}");
    let state = app.state::<AppState>();
    *lock(&state.last_error) = Some(message.clone());
    let _ = app.emit("notice", &message);
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!("Dictate: {message}")));
    }
}

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// ---------------------------------------------------------------- dictation

fn on_hotkey(app: &AppHandle, pressed: bool) {
    let state = app.state::<AppState>();
    let mode = lock(&state.settings).mode;
    let phase = *lock(&state.phase);
    match (mode, pressed, phase) {
        (RecordMode::Hold, true, Phase::Idle) => start_recording(app),
        (RecordMode::Hold, false, Phase::Recording) => stop_recording(app),
        (RecordMode::Toggle, true, Phase::Idle) => start_recording(app),
        (RecordMode::Toggle, true, Phase::Recording) => stop_recording(app),
        // Key repeat, a release in toggle mode, or a press while busy.
        _ => {}
    }
}

fn start_recording(app: &AppHandle) {
    let state = app.state::<AppState>();
    let s = state.settings();
    if !state.model_ready(&s.model) {
        report(app, "The speech model isn't downloaded yet. Open Dictate to finish setup.");
        platform::play(Sound::Error);
        show_window(app);
        return;
    }
    match state.recorder.start(s.microphone.clone()) {
        Ok(_device) => {
            if s.sounds {
                platform::play(Sound::Start);
            }
            set_phase(app, Phase::Recording);
            // Warm the model up while the user talks.
            let app2 = app.clone();
            std::thread::spawn(move || {
                let _ = ensure_engine(&app2);
            });
        }
        Err(e) => {
            report(app, format!("Couldn't start the microphone: {e}"));
            platform::play(Sound::Error);
        }
    }
}

fn stop_recording(app: &AppHandle) {
    let state = app.state::<AppState>();
    let rec = state.recorder.stop();
    let s = state.settings();
    if s.sounds {
        platform::play(Sound::Stop);
    }
    let Some(rec) = rec else {
        set_phase(app, Phase::Idle);
        return;
    };
    set_phase(app, Phase::Transcribing);
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = dictate(&app, rec) {
            report(&app, e.to_string());
            platform::play(Sound::Error);
        }
        set_phase(&app, Phase::Idle);
    });
}

/// Loads (or reuses) the Whisper model chosen in settings.
fn ensure_engine(app: &AppHandle) -> anyhow::Result<Arc<Transcriber>> {
    let state = app.state::<AppState>();
    let id = lock(&state.settings).model.clone();
    let mut engine = lock(&state.engine);
    if let Some((loaded, t)) = engine.as_ref() {
        if *loaded == id {
            return Ok(t.clone());
        }
    }
    let info = models::find(&id).ok_or_else(|| anyhow::anyhow!("unknown model {id}"))?;
    if !info.is_downloaded(&state.paths.models) {
        anyhow::bail!("The speech model isn't downloaded yet. Open Dictate to finish setup.");
    }
    let t = Arc::new(Transcriber::load(&info.path_in(&state.paths.models))?);
    *engine = Some((id, t.clone()));
    Ok(t)
}

/// Recording → text at the cursor.
fn dictate(app: &AppHandle, rec: Recording) -> anyhow::Result<()> {
    let started = Instant::now();
    let state = app.state::<AppState>();
    let s = state.settings();
    let mono = audio::to_mono(&rec.samples, rec.channels);
    let audio_ms = audio::duration_ms(mono.len(), rec.rate);
    if audio_ms < MIN_CLIP_MS {
        return Ok(());
    }
    if audio::is_silent(&mono) {
        anyhow::bail!(
            "Didn't hear anything from \"{}\". If this keeps happening, check that Dictate is allowed under Microphone in System Settings.",
            rec.device
        );
    }
    let pcm = audio::prepare_for_whisper(&mono, rec.rate, 1);
    let engine = ensure_engine(app)?;
    let raw = engine.transcribe(
        &pcm,
        &Options {
            language: s.whisper_language().map(String::from),
            initial_prompt: words::whisper_prompt(&words::parse(&s.words)),
            threads: 0,
        },
    )?;
    let processed = pipeline::process(&raw, &s, state.llm_config(&s).as_ref());
    if processed.text.is_empty() {
        return Ok(());
    }

    let outcome = platform::paste_text(&processed.text, s.restore_clipboard)?;
    let mut note = processed.note.clone();
    if outcome == PasteOutcome::CopiedOnly {
        let msg = "Copied to the clipboard. Allow Dictate under Accessibility in System Settings so it can paste for you.";
        note = Some(note.map_or(msg.to_string(), |n| format!("{n} {msg}")));
        report(app, msg);
    } else if let Some(n) = &processed.note {
        report(app, n.clone());
    }

    let entry = history::Entry {
        at: history::now_secs(),
        text: processed.text,
        raw,
        audio_ms,
        took_ms: started.elapsed().as_millis() as u64,
        note,
    };
    let mut h = lock(&state.history);
    h.push(entry, s.history_limit.max(1));
    let _ = h.save(&state.paths.history);
    let _ = app.emit("history", &h.entries);
    Ok(())
}

// ---------------------------------------------------------------- hotkey

fn register_hotkey(app: &AppHandle, hotkey: &str) -> anyhow::Result<()> {
    let shortcut: Shortcut = hotkey
        .parse()
        .map_err(|e| anyhow::anyhow!("\"{hotkey}\" isn't a shortcut Dictate understands ({e})"))?;
    let gs = app.global_shortcut();
    gs.unregister_all()?;
    gs.register(shortcut)
        .map_err(|e| anyhow::anyhow!("couldn't use {hotkey}; another app may own it ({e})"))?;
    Ok(())
}

// ---------------------------------------------------------------- commands

#[derive(Serialize)]
struct ModelView {
    id: &'static str,
    label: &'static str,
    size_mb: u32,
    english_only: bool,
    downloaded: bool,
}

#[derive(Serialize)]
struct StateView {
    settings: Settings,
    models: Vec<ModelView>,
    microphones: Vec<String>,
    accessibility: bool,
    has_key: HashMap<&'static str, bool>,
    history: Vec<history::Entry>,
    phase: Phase,
    downloading: Option<String>,
    last_error: Option<String>,
    hotkey_label: String,
    models_dir: String,
    version: &'static str,
}

#[tauri::command]
fn get_state(state: State<AppState>) -> StateView {
    let settings = state.settings();
    let has_key = [CleanupProvider::Groq, CleanupProvider::Gemini]
        .into_iter()
        .map(|p| (p.key_name().unwrap(), state.api_key(p).is_some()))
        .collect();
    StateView {
        hotkey_label: pretty_hotkey(&settings.hotkey),
        models: models::CATALOG
            .iter()
            .map(|m| ModelView {
                id: m.id,
                label: m.label,
                size_mb: m.size_mb,
                english_only: m.english_only,
                downloaded: m.is_downloaded(&state.paths.models),
            })
            .collect(),
        microphones: recorder::input_devices(),
        accessibility: platform::accessibility_trusted(false),
        has_key,
        history: lock(&state.history).entries.iter().cloned().collect(),
        phase: *lock(&state.phase),
        downloading: lock(&state.downloading).clone(),
        last_error: lock(&state.last_error).clone(),
        models_dir: state.paths.models.display().to_string(),
        version: env!("CARGO_PKG_VERSION"),
        settings,
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, state: State<AppState>, settings: Settings) -> Result<(), String> {
    let old = state.settings();
    if settings.hotkey != old.hotkey {
        if let Err(e) = register_hotkey(&app, &settings.hotkey) {
            let _ = register_hotkey(&app, &old.hotkey);
            return Err(e.to_string());
        }
    }
    if models::find(&settings.model).is_none() {
        return Err(format!("unknown model {}", settings.model));
    }
    settings.save(&state.paths.settings).map_err(|e| e.to_string())?;
    *lock(&state.settings) = settings.clone();
    if settings.model != old.model {
        *lock(&state.engine) = None;
        if state.model_ready(&settings.model) {
            let app2 = app.clone();
            std::thread::spawn(move || {
                let _ = ensure_engine(&app2);
            });
        }
    }
    {
        let mut h = lock(&state.history);
        let limit = settings.history_limit.max(1);
        h.entries.truncate(limit);
    }
    set_phase(&app, *lock(&state.phase));
    Ok(())
}

#[tauri::command]
fn download_model(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    let info = models::find(&id).ok_or("unknown model")?;
    {
        let mut d = lock(&state.downloading);
        if d.is_some() {
            return Err("a download is already running".into());
        }
        *d = Some(id.clone());
    }
    state.cancel_download.store(false, Ordering::Relaxed);
    let dir = state.paths.models.clone();
    let cancel = state.cancel_download.clone();
    std::thread::spawn(move || {
        let mut last_emit = Instant::now() - Duration::from_secs(1);
        let result = models::download(info, &dir, &cancel, |done, total| {
            if last_emit.elapsed() >= Duration::from_millis(200) {
                last_emit = Instant::now();
                let _ = app.emit("download", serde_json::json!({ "id": info.id, "done": done, "total": total }));
            }
        });
        let state = app.state::<AppState>();
        *lock(&state.downloading) = None;
        let payload = match &result {
            Ok(_) => serde_json::json!({ "id": info.id, "finished": true }),
            Err(e) => serde_json::json!({ "id": info.id, "error": e.to_string() }),
        };
        let _ = app.emit("download", payload);
        if result.is_ok() && state.settings().model == info.id {
            set_phase(&app, *lock(&state.phase));
            let _ = ensure_engine(&app);
        }
    });
    Ok(())
}

#[tauri::command]
fn cancel_download(state: State<AppState>) {
    state.cancel_download.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn delete_model(state: State<AppState>, id: String) -> Result<(), String> {
    let info = models::find(&id).ok_or("unknown model")?;
    let mut engine = lock(&state.engine);
    if engine.as_ref().is_some_and(|(loaded, _)| loaded == &id) {
        *engine = None;
    }
    std::fs::remove_file(info.path_in(&state.paths.models)).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_api_key(state: State<AppState>, provider: CleanupProvider, key: String) -> Result<(), String> {
    let name = provider.key_name().ok_or("pick Groq or Gemini first")?;
    let key = key.trim().to_string();
    if key.is_empty() {
        secrets::delete(name).map_err(|e| e.to_string())?;
        lock(&state.keys).insert(name.into(), None);
    } else {
        secrets::set(name, &key).map_err(|e| e.to_string())?;
        lock(&state.keys).insert(name.into(), Some(key));
    }
    Ok(())
}

/// Runs a sample sentence through the AI cleanup so the user can check their key.
#[tauri::command]
async fn test_cleanup(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let s = state.settings();
        let cfg = state
            .llm_config(&s)
            .ok_or("Pick a provider and save its API key first.")?;
        let sample = "um so i wanted to uh check in about the the quote for floor jack, no wait, for allum strategies";
        let spellings = words::spelling_list(&words::parse(&s.words));
        dictate_core::cleanup::llm_cleanup(&cfg, sample, &spellings).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct MicTest {
    device: String,
    peak: f32,
    rms: f32,
}

/// Records 1.5 s so the user can see the mic works (and so macOS asks for
/// Microphone permission the first time).
#[tauri::command]
async fn test_microphone(app: AppHandle) -> Result<MicTest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if *lock(&state.phase) != Phase::Idle {
            return Err("Dictation is running; try again in a moment.".to_string());
        }
        let device = state
            .recorder
            .start(state.settings().microphone)
            .map_err(|e| e.to_string())?;
        std::thread::sleep(Duration::from_millis(1500));
        let rec = state.recorder.stop().ok_or("recording didn't start")?;
        let mono = audio::to_mono(&rec.samples, rec.channels);
        Ok(MicTest { device, peak: audio::peak(&mono), rms: audio::rms(&mono) })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn request_accessibility() -> bool {
    let trusted = platform::accessibility_trusted(true);
    if !trusted {
        platform::open_settings(SettingsPane::Accessibility);
    }
    trusted
}

#[tauri::command]
fn open_settings_pane(pane: String) {
    platform::open_settings(if pane == "microphone" {
        SettingsPane::Microphone
    } else {
        SettingsPane::Accessibility
    });
}

/// Opens one of the known sign-up pages for a free API key.
#[tauri::command]
fn open_key_page(provider: CleanupProvider) {
    match provider {
        CleanupProvider::Groq => platform::open_url("https://console.groq.com/keys"),
        CleanupProvider::Gemini => platform::open_url("https://aistudio.google.com/apikey"),
        CleanupProvider::Off => {}
    }
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_history(state: State<AppState>) -> Result<(), String> {
    let mut h = lock(&state.history);
    h.clear();
    h.save(&state.paths.history).map_err(|e| e.to_string())
}

#[tauri::command]
fn dismiss_notice(state: State<AppState>) {
    *lock(&state.last_error) = None;
}

// ---------------------------------------------------------------- app

pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    on_hotkey(app, event.state() == ShortcutState::Pressed);
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_state,
            save_settings,
            download_model,
            cancel_download,
            delete_model,
            set_api_key,
            test_cleanup,
            test_microphone,
            request_accessibility,
            open_settings_pane,
            open_key_page,
            copy_text,
            clear_history,
            dismiss_notice,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            let paths = Paths {
                settings: config_dir.join("settings.json"),
                history: data_dir.join("history.json"),
                models: data_dir.join("models"),
            };
            std::fs::create_dir_all(&paths.models)?;
            let settings = Settings::load(&paths.settings);
            let history = History::load(&paths.history);
            let hotkey = settings.hotkey.clone();
            let model_ready = models::find(&settings.model).is_some_and(|m| m.is_downloaded(&paths.models));

            app.manage(AppState {
                paths,
                settings: Mutex::new(settings),
                history: Mutex::new(history),
                recorder: Recorder::new(),
                phase: Mutex::new(Phase::Idle),
                engine: Mutex::new(None),
                keys: Mutex::new(HashMap::new()),
                downloading: Mutex::new(None),
                cancel_download: Arc::new(AtomicBool::new(false)),
                status_item: Mutex::new(None),
                last_error: Mutex::new(None),
            });

            let status = MenuItem::with_id(app, "status", "Starting…", false, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "Open Dictate…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Dictate", true, Some("CmdOrCtrl+Q"))?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&status, &sep, &open, &quit])?;
            *lock(&app.state::<AppState>().status_item) = Some(status);

            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            TrayIconBuilder::with_id("main")
                .icon(icon)
                .icon_as_template(true)
                .tooltip("Dictate")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            let handle = app.handle().clone();
            if let Err(e) = register_hotkey(&handle, &hotkey) {
                report(&handle, e.to_string());
            }
            set_phase(&handle, Phase::Idle);

            if !model_ready || !platform::accessibility_trusted(false) {
                show_window(&handle);
            }
            if model_ready {
                std::thread::spawn(move || {
                    if let Err(e) = ensure_engine(&handle) {
                        report(&handle, e.to_string());
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps Dictate running in the menu bar.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Dictate");
}

#[cfg(test)]
mod tests {
    use super::pretty_hotkey;

    #[test]
    fn hotkey_labels() {
        assert_eq!(pretty_hotkey("Alt+Space"), "⌥Space");
        assert_eq!(pretty_hotkey("CommandOrControl+Shift+KeyD"), "⌘⇧D");
        assert_eq!(pretty_hotkey("Control+Alt+Digit9"), "⌃⌥9");
        assert_eq!(pretty_hotkey("F5"), "F5");
    }
}
