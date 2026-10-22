"""Parse and build two-voice podcast scripts.

A script is a list of turns. Each turn is {"speaker": "host" | "guest", "text": str}.
The text form is one turn per line, labelled with HOST:/GUEST: or the speaker's name:

    HOST: Welcome back to the show.
    GUEST: Thanks for having me.
"""

from __future__ import annotations

import re

SPEAKERS = ("host", "guest")

_LABEL = re.compile(r"^\s*\**\s*([A-Za-z][\w .'\-]{0,40}?)\s*\**\s*:\s*(.*)$")


class ScriptError(ValueError):
    pass


def _speaker_for(label: str, host_name: str = "", guest_name: str = "") -> str | None:
    key = label.strip().lower()
    if key in ("host", "h", "interviewer"):
        return "host"
    if key in ("guest", "g", "interviewee"):
        return "guest"
    for name, role in ((host_name, "host"), (guest_name, "guest")):
        name = (name or "").strip().lower()
        if name and (key == name or key == name.split()[0]):
            return role
    return None


def parse_script(text: str, host_name: str = "", guest_name: str = "") -> list[dict]:
    """Turn labelled text into turns. Unlabelled lines continue the previous turn."""
    turns: list[dict] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = _LABEL.match(line)
        speaker = _speaker_for(m.group(1), host_name, guest_name) if m else None
        if speaker:
            body = m.group(2).strip()
            if body:
                turns.append({"speaker": speaker, "text": body})
            else:
                turns.append({"speaker": speaker, "text": ""})
        elif turns:
            turns[-1]["text"] = (turns[-1]["text"] + " " + line).strip()
        else:
            raise ScriptError(
                f'The first line needs a speaker label like "HOST:" or "GUEST:" (got: "{line[:60]}")'
            )
    turns = [t for t in turns if t["text"]]
    if not turns:
        raise ScriptError("The script is empty. Add lines that start with HOST: or GUEST:.")
    return turns


def validate_turns(turns: list) -> list[dict]:
    clean = []
    for i, t in enumerate(turns or []):
        speaker = str(t.get("speaker", "")).strip().lower()
        text = str(t.get("text", "")).strip()
        if speaker not in SPEAKERS:
            raise ScriptError(f"Line {i + 1}: speaker must be host or guest, got {speaker!r}")
        if text:
            clean.append({"speaker": speaker, "text": text})
    if not clean:
        raise ScriptError("The script has no lines to read.")
    return clean


def turns_to_text(turns: list[dict]) -> str:
    return "\n".join(f"{t['speaker'].upper()}: {t['text']}" for t in turns)


def simple_script(
    questions: list[str],
    answers: list[str],
    show_name: str = "the show",
    host_name: str = "Jacob",
    guest_name: str = "our guest",
    topic: str = "",
) -> list[dict]:
    """Build a script straight from questions and answers, with no AI.

    The guest's lines are their written answers, word for word.
    """
    pairs = [
        (q.strip(), (answers[i] if i < len(answers) else "").strip())
        for i, q in enumerate(questions)
        if q.strip()
    ]
    pairs = [(q, a) for q, a in pairs if a]
    if not pairs:
        raise ScriptError("Add at least one question with an answer.")
    about = f" to talk about {topic.strip()}" if topic.strip() else ""
    turns = [
        {
            "speaker": "host",
            "text": f"Welcome to {show_name}. I'm {host_name}, and today I'm joined by {guest_name}{about}. Thanks for being here.",
        },
        {"speaker": "guest", "text": f"Thanks for having me, {host_name.split()[0]}."},
    ]
    for n, (q, a) in enumerate(pairs):
        lead = "Let's start here. " if n == 0 else ""
        turns.append({"speaker": "host", "text": lead + q})
        turns.append({"speaker": "guest", "text": a})
    turns.append(
        {
            "speaker": "host",
            "text": f"{guest_name.split()[0]}, thank you for coming on. That's it for this episode of {show_name}. See you next time.",
        }
    )
    return turns
