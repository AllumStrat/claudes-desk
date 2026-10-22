//! The OS-specific bits: pasting into other apps, permissions, sounds.
//! Dictate targets macOS; the fallback keeps it building (and usable as a
//! copy-to-clipboard tool) elsewhere.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(not(target_os = "macos"))]
mod other;
#[cfg(not(target_os = "macos"))]
pub use other::*;

/// What happened to the dictated text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteOutcome {
    /// Pasted at the cursor.
    Pasted,
    /// Left on the clipboard because pasting isn't allowed (yet).
    CopiedOnly,
}

#[derive(Debug, Clone, Copy)]
pub enum Sound {
    Start,
    Stop,
    Error,
}

#[derive(Debug, Clone, Copy)]
pub enum SettingsPane {
    Microphone,
    Accessibility,
}

/// Keeps whatever was on the clipboard so it can be put back after a paste.
enum Saved {
    Text(String),
    Image(arboard::ImageData<'static>),
}

fn save_clipboard(cb: &mut arboard::Clipboard) -> Option<Saved> {
    if let Ok(t) = cb.get_text() {
        return Some(Saved::Text(t));
    }
    cb.get_image().ok().map(|i| Saved::Image(i.to_owned_img()))
}

fn restore_clipboard(cb: &mut arboard::Clipboard, saved: Saved) {
    let _ = match saved {
        Saved::Text(t) => cb.set_text(t),
        Saved::Image(i) => cb.set_image(i),
    };
}

/// Puts `text` on the clipboard, presses the paste shortcut through
/// `press_paste`, then (optionally) restores the previous clipboard.
fn paste_with(
    text: &str,
    restore: bool,
    can_paste: bool,
    press_paste: impl FnOnce() -> anyhow::Result<()>,
) -> anyhow::Result<PasteOutcome> {
    let mut cb = arboard::Clipboard::new()?;
    let saved = if restore && can_paste { save_clipboard(&mut cb) } else { None };
    cb.set_text(text.to_string())?;
    if !can_paste {
        return Ok(PasteOutcome::CopiedOnly);
    }
    // Give the pasteboard a moment to settle before the target app reads it.
    std::thread::sleep(std::time::Duration::from_millis(40));
    press_paste()?;
    if let Some(saved) = saved {
        // The target app reads the clipboard asynchronously after Cmd+V.
        std::thread::sleep(std::time::Duration::from_millis(450));
        // Only restore if nothing else changed the clipboard in the meantime.
        if cb.get_text().ok().as_deref() == Some(text) {
            restore_clipboard(&mut cb, saved);
        }
    }
    Ok(PasteOutcome::Pasted)
}
