//! Personal word list: names and terms Whisper should spell your way.
//!
//! Each line is either a plain term ("Floorjack"), which is fed to Whisper as
//! a spelling hint and fixes its capitalization afterwards, or a rewrite
//! ("floor jack -> Floorjack"), which also replaces what Whisper heard.

use regex::Regex;

#[derive(Debug, Clone, PartialEq)]
pub struct WordEntry {
    /// What Whisper tends to write, if it differs from the right spelling.
    pub spoken: Option<String>,
    /// The spelling you want.
    pub written: String,
}

pub fn parse(lines: &[String]) -> Vec<WordEntry> {
    lines
        .iter()
        .flat_map(|l| l.lines())
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| {
            let split = l.split_once("->").or_else(|| l.split_once("=>"));
            match split {
                Some((spoken, written)) => {
                    let (spoken, written) = (spoken.trim(), written.trim());
                    if written.is_empty() {
                        return None;
                    }
                    Some(WordEntry {
                        spoken: (!spoken.is_empty()).then(|| spoken.to_string()),
                        written: written.to_string(),
                    })
                }
                None => Some(WordEntry { spoken: None, written: l.to_string() }),
            }
        })
        .collect()
}

/// Whisper's initial prompt nudges spelling toward words it has "seen". It's
/// limited to about 224 tokens, so keep it to a couple hundred characters.
pub fn whisper_prompt(entries: &[WordEntry]) -> Option<String> {
    let mut terms: Vec<&str> = Vec::new();
    let mut len = 0;
    for e in entries {
        if terms.iter().any(|t| t.eq_ignore_ascii_case(&e.written)) {
            continue;
        }
        if len + e.written.len() > 400 {
            break;
        }
        len += e.written.len() + 2;
        terms.push(&e.written);
    }
    (!terms.is_empty()).then(|| format!("Glossary: {}.", terms.join(", ")))
}

/// Builds a case-insensitive, whole-word pattern that also tolerates spaces
/// or hyphens between the words of a phrase ("floor jack" ~ "Floor-Jack").
fn phrase_pattern(phrase: &str) -> Option<Regex> {
    let parts: Vec<String> = phrase.split_whitespace().map(regex::escape).collect();
    if parts.is_empty() {
        return None;
    }
    let body = parts.join(r"[\s\-]+");
    // \b only works next to word characters; skip it at edges that aren't.
    let start = if phrase.starts_with(|c: char| c.is_alphanumeric()) { r"\b" } else { "" };
    let end = if phrase.ends_with(|c: char| c.is_alphanumeric()) { r"\b" } else { "" };
    Regex::new(&format!("(?i){start}{body}{end}")).ok()
}

/// Applies rewrites, then fixes the spelling/capitalization of every term.
pub fn apply(text: &str, entries: &[WordEntry]) -> String {
    let mut out = text.to_string();
    for e in entries {
        if let Some(spoken) = &e.spoken {
            if let Some(re) = phrase_pattern(spoken) {
                out = re.replace_all(&out, regex::NoExpand(&e.written)).into_owned();
            }
        }
    }
    for e in entries {
        if let Some(re) = phrase_pattern(&e.written) {
            out = re.replace_all(&out, regex::NoExpand(&e.written)).into_owned();
        }
    }
    out
}

/// Comma-separated list for the AI cleanup prompt.
pub fn spelling_list(entries: &[WordEntry]) -> String {
    let mut seen: Vec<&str> = Vec::new();
    for e in entries {
        if !seen.contains(&e.written.as_str()) {
            seen.push(&e.written);
        }
    }
    seen.join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(lines: &[&str]) -> Vec<WordEntry> {
        parse(&lines.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn parses_terms_rewrites_and_comments() {
        let e = entries(&["Allum", "  floor jack -> Floorjack ", "# note", "", "jake => Jacob", "x ->"]);
        assert_eq!(
            e,
            vec![
                WordEntry { spoken: None, written: "Allum".into() },
                WordEntry { spoken: Some("floor jack".into()), written: "Floorjack".into() },
                WordEntry { spoken: Some("jake".into()), written: "Jacob".into() },
            ]
        );
    }

    #[test]
    fn multiline_strings_are_split() {
        assert_eq!(entries(&["Allum\nFloorjack"]).len(), 2);
    }

    #[test]
    fn fixes_capitalization_on_whole_words_only() {
        let e = entries(&["Allum", "Floorjack"]);
        assert_eq!(
            apply("call allum about floorjack, not allumbaugh", &e),
            "call Allum about Floorjack, not allumbaugh"
        );
    }

    #[test]
    fn rewrites_spoken_forms_with_flexible_spacing() {
        let e = entries(&["floor jack -> Floorjack", "alum strategies -> Allum Strategies"]);
        assert_eq!(
            apply("Floor-Jack and floor  jack work with Alum Strategies.", &e),
            "Floorjack and Floorjack work with Allum Strategies."
        );
    }

    #[test]
    fn replacement_text_is_literal() {
        let e = entries(&["price -> $5 deal"]);
        assert_eq!(apply("the price", &e), "the $5 deal");
    }

    #[test]
    fn prompt_dedupes_and_is_bounded() {
        let e = entries(&["Allum", "allum", "Floorjack"]);
        assert_eq!(whisper_prompt(&e).unwrap(), "Glossary: Allum, Floorjack.");
        assert_eq!(whisper_prompt(&[]), None);
        let many: Vec<String> = (0..200).map(|i| format!("Term{i}")).collect();
        assert!(whisper_prompt(&parse(&many)).unwrap().len() < 450);
    }
}
