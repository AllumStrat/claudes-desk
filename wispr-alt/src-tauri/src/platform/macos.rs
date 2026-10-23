use super::{paste_with, PasteOutcome, SettingsPane, Sound};
use anyhow::{anyhow, Result};
use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::string::CFString;
use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use std::process::Command;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
}

/// Whether macOS lets this app send keystrokes (System Settings → Privacy &
/// Security → Accessibility). With `prompt`, macOS shows its own dialog.
pub fn accessibility_trusted(prompt: bool) -> bool {
    unsafe {
        if !prompt {
            return AXIsProcessTrusted();
        }
        let key = CFString::new("AXTrustedCheckOptionPrompt");
        let options = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), CFBoolean::true_value().as_CFType())]);
        AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef())
    }
}

/// kVK_ANSI_V
const KEY_V: u16 = 9;

fn press_cmd_v() -> Result<()> {
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .map_err(|_| anyhow!("couldn't create a keyboard event source"))?;
    for down in [true, false] {
        let event = CGEvent::new_keyboard_event(source.clone(), KEY_V, down)
            .map_err(|_| anyhow!("couldn't create the paste keystroke"))?;
        // Only Command, even if the user is still holding the hotkey's modifiers.
        event.set_flags(CGEventFlags::CGEventFlagCommand);
        event.post(CGEventTapLocation::HID);
        std::thread::sleep(std::time::Duration::from_millis(8));
    }
    Ok(())
}

pub fn paste_text(text: &str, restore: bool) -> Result<PasteOutcome> {
    paste_with(text, restore, accessibility_trusted(false), press_cmd_v)
}

pub fn open_settings(pane: SettingsPane) {
    let anchor = match pane {
        SettingsPane::Microphone => "Privacy_Microphone",
        SettingsPane::Accessibility => "Privacy_Accessibility",
    };
    let _ = Command::new("open")
        .arg(format!("x-apple.systempreferences:com.apple.preference.security?{anchor}"))
        .spawn();
}

pub fn open_url(url: &str) {
    let _ = Command::new("open").arg(url).spawn();
}

pub fn play(sound: Sound) {
    let file = match sound {
        Sound::Start => "Tink",
        Sound::Stop => "Pop",
        Sound::Error => "Basso",
    };
    let _ = Command::new("afplay")
        .arg(format!("/System/Library/Sounds/{file}.aiff"))
        .spawn();
}
