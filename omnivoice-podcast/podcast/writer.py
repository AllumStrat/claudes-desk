"""Claude writes the interview questions and turns the guest's answers into a script.

Optional: the app works without it (paste a script, or build one from the Q&A with no AI).
Uses the key typed in the page, else ANTHROPIC_API_KEY, else an `ant auth login` profile.
"""

from __future__ import annotations

import json
import os

MODEL = os.environ.get("PODCAST_CLAUDE_MODEL", "claude-opus-5-5")


class WriterError(RuntimeError):
    pass


def _client(api_key: str | None):
    try:
        import anthropic
    except ImportError as e:
        raise WriterError("The anthropic package isn't installed. Run: pip install anthropic") from e
    return anthropic, (anthropic.Anthropic(api_key=api_key) if api_key else anthropic.Anthropic())


def _ask_json(system: str, prompt: str, schema: dict, api_key: str | None) -> dict:
    anthropic, client = _client(api_key)
    request = dict(
        model=MODEL,
        max_tokens=16000,
        system=system,
        messages=[{"role": "user", "content": prompt}],
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": schema}},
    )
    try:
        try:
            response = client.beta.messages.create(
                betas=["server-side-fallback-2026-07-01"], fallbacks="default", **request
            )
        except anthropic.BadRequestError:
            # Some accounts or platforms don't take fallbacks; ask again without them.
            response = client.messages.create(**request)
    except anthropic.AuthenticationError as e:
        raise WriterError("Claude rejected the API key. Check it and try again.") from e
    except anthropic.RateLimitError as e:
        raise WriterError("Claude is rate limiting this key. Wait a moment and try again.") from e
    except anthropic.APIStatusError as e:
        raise WriterError(f"Claude API error {e.status_code}: {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise WriterError("Couldn't reach the Claude API. Check your connection.") from e
    except TypeError as e:
        if "api_key" in str(e) or "auth" in str(e).lower():
            raise WriterError("No Claude API key. Paste one in the page or set ANTHROPIC_API_KEY.") from e
        raise

    if response.stop_reason == "refusal":
        raise WriterError("Claude declined to write this one. Try rewording the topic.")
    text = "".join(b.text for b in response.content if getattr(b, "type", "") == "text")
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise WriterError("Claude's reply wasn't valid JSON. Try again.") from e


QUESTIONS_SCHEMA = {
    "type": "object",
    "properties": {"questions": {"type": "array", "items": {"type": "string"}}},
    "required": ["questions"],
    "additionalProperties": False,
}

SCRIPT_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "lines": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "speaker": {"type": "string", "enum": ["host", "guest"]},
                    "text": {"type": "string"},
                },
                "required": ["speaker", "text"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["title", "lines"],
    "additionalProperties": False,
}


def write_questions(
    show_name: str,
    host_name: str,
    guest_name: str,
    guest_bio: str,
    topic: str,
    count: int = 6,
    api_key: str | None = None,
) -> list[str]:
    system = (
        "You write interview questions for a conversational audio podcast. "
        "The guest answers in writing, then the answers are read aloud by a voice model, "
        "so ask open questions that invite stories and specifics, one idea per question, "
        "in plain spoken English with no lists or jargon."
    )
    prompt = (
        f"Show: {show_name}\nHost: {host_name}\nGuest: {guest_name}\n"
        f"About the guest: {guest_bio or 'not given'}\nTopic: {topic or 'not given'}\n\n"
        f"Write {count} interview questions in a natural running order, from an easy opener "
        "to a forward-looking closer. Each question is one or two sentences."
    )
    data = _ask_json(system, prompt, QUESTIONS_SCHEMA, api_key)
    questions = [q.strip() for q in data.get("questions", []) if str(q).strip()]
    if not questions:
        raise WriterError("Claude didn't return any questions.")
    return questions


def write_script(
    show_name: str,
    host_name: str,
    guest_name: str,
    topic: str,
    questions: list[str],
    answers: list[str],
    api_key: str | None = None,
) -> dict:
    qa = "\n\n".join(
        f"Q{i + 1}: {q}\nA{i + 1} (the guest's own words): {answers[i] if i < len(answers) else ''}"
        for i, q in enumerate(questions)
    )
    system = (
        "You turn a written interview into a script for a two-voice podcast. Both voices are "
        "cloned from real people, so the guest must never say anything they didn't write. "
        "Rules for GUEST lines: keep their meaning, facts, and opinions exactly; you may only "
        "split long answers into a few turns, smooth grammar for speech, and add a short "
        "natural acknowledgement such as 'Yeah, sure.' or 'Good question.' Do not invent "
        "facts, stories, numbers, or opinions for the guest. Rules for HOST lines: a short "
        "intro naming the show, host, guest and topic; each question asked conversationally; "
        "brief reactions or follow-up bridges between answers that refer only to what the "
        "guest said; a short thank-you outro. Write for the ear: short sentences, numbers "
        "spelled out, no stage directions, no emoji, no markdown. You may use the tag "
        "[laughter] at most twice, only where it fits."
    )
    prompt = (
        f"Show: {show_name}\nHost: {host_name}\nGuest: {guest_name}\nTopic: {topic or 'not given'}\n\n"
        f"Interview:\n{qa}\n\nWrite the full episode script as alternating lines."
    )
    data = _ask_json(system, prompt, SCRIPT_SCHEMA, api_key)
    lines = [
        {"speaker": l["speaker"], "text": l["text"].strip()}
        for l in data.get("lines", [])
        if l.get("speaker") in ("host", "guest") and l.get("text", "").strip()
    ]
    if not lines:
        raise WriterError("Claude didn't return a script.")
    return {"title": data.get("title", "").strip(), "lines": lines}
