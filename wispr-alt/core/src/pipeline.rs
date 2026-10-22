//! Everything that happens to a transcript between Whisper and the paste.

use crate::cleanup::{self, LlmConfig};
use crate::settings::Settings;
use crate::words::{self, WordEntry};

#[derive(Debug, Clone, PartialEq)]
pub struct Processed {
    /// What gets pasted. Empty means there's nothing to paste.
    pub text: String,
    /// Set when the AI pass was wanted but skipped or failed.
    pub note: Option<String>,
    pub used_ai: bool,
}

/// Runs the local cleanup, the optional AI cleanup and the word list.
/// `llm` is None when AI cleanup is off or has no key.
pub fn process(raw: &str, settings: &Settings, llm: Option<&LlmConfig>) -> Processed {
    let entries: Vec<WordEntry> = words::parse(&settings.words);
    let mut text = cleanup::strip_annotations(raw);
    if cleanup::is_hallucination(&text) {
        return Processed { text: String::new(), note: None, used_ai: false };
    }
    text = words::apply(&text, &entries);
    if settings.remove_fillers {
        text = cleanup::remove_fillers(&text);
    }

    let mut note = None;
    let mut used_ai = false;
    if let Some(cfg) = llm {
        match cleanup::llm_cleanup(cfg, &text, &words::spelling_list(&entries)) {
            Ok(cleaned) => {
                text = cleaned;
                used_ai = true;
            }
            Err(e) => note = Some(format!("AI cleanup skipped: {e}")),
        }
    }

    // Enforce spellings once more in case the AI pass changed them.
    text = words::apply(&text, &entries);
    Processed { text: cleanup::tidy_keep_lines(&text), note, used_ai }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::CleanupProvider;
    use crate::testutil::serve_once;
    use serde_json::json;

    fn settings() -> Settings {
        Settings {
            words: vec!["Allum".into(), "floor jack -> Floorjack".into()],
            ..Settings::default()
        }
    }

    #[test]
    fn local_only() {
        let p = process(" um, I sent the allum quote to floor jack [BLANK_AUDIO]", &settings(), None);
        assert_eq!(p.text, "I sent the Allum quote to Floorjack");
        assert!(!p.used_ai && p.note.is_none());
    }

    #[test]
    fn fillers_can_be_kept() {
        let mut s = settings();
        s.remove_fillers = false;
        assert_eq!(process("um yes", &s, None).text, "um yes");
    }

    #[test]
    fn silence_hallucinations_paste_nothing() {
        assert_eq!(process(" Thank you.", &settings(), None).text, "");
        assert_eq!(process("[BLANK_AUDIO]", &settings(), None).text, "");
    }

    #[test]
    fn ai_pass_is_used_and_spellings_enforced() {
        let reply = json!({"choices":[{"message":{"content":"I sent the allum quote to Floorjack."}}]});
        let url = serve_once(200, "application/json", reply.to_string().into_bytes());
        let mut cfg = LlmConfig::new(CleanupProvider::Groq, "k".into(), "m".into());
        cfg.base_url = Some(url);
        let p = process("i sent the allum quote to floor jack", &settings(), Some(&cfg));
        assert_eq!(p.text, "I sent the Allum quote to Floorjack.");
        assert!(p.used_ai);
    }

    #[test]
    fn ai_failure_falls_back_to_local_text() {
        let url = serve_once(429, "application/json", br#"{"error":{"message":"Rate limit"}}"#.to_vec());
        let mut cfg = LlmConfig::new(CleanupProvider::Groq, "k".into(), "m".into());
        cfg.base_url = Some(url);
        let p = process("uh call allum", &settings(), Some(&cfg));
        assert_eq!(p.text, "Call Allum");
        assert!(!p.used_ai);
        assert!(p.note.unwrap().contains("Rate limit"));
    }

    #[test]
    fn ai_lists_keep_their_line_breaks() {
        let reply = json!({"choices":[{"message":{"content":"Groceries:\n- eggs\n- milk"}}]});
        let url = serve_once(200, "application/json", reply.to_string().into_bytes());
        let mut cfg = LlmConfig::new(CleanupProvider::Groq, "k".into(), "m".into());
        cfg.base_url = Some(url);
        let p = process("groceries eggs milk", &settings(), Some(&cfg));
        assert_eq!(p.text, "Groceries:\n- eggs\n- milk");
    }
}
