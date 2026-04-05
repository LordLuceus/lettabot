# Voice

LettaBot has full voice support: it can receive voice messages (transcribed to text) and reply with voice memos (generated via TTS). Both features work across Telegram, WhatsApp, Signal, Discord, and Slack.

## Voice Transcription (Receiving Voice Messages)

When a user sends a voice message, LettaBot downloads the audio, transcribes it via the configured provider, and delivers the text to the agent with a `[Voice message]:` prefix.

### Providers

**OpenAI Whisper** (default):

```yaml
transcription:
  provider: openai
  apiKey: sk-...       # Optional: falls back to OPENAI_API_KEY env var
  model: whisper-1     # Default
```

**Mistral Voxtral** (faster, lower cost):

```yaml
transcription:
  provider: mistral
  apiKey: ...          # Optional: falls back to MISTRAL_API_KEY env var
  model: voxtral-mini-latest  # Default
```

Or configure via environment variables alone:

```bash
# OpenAI (default provider when no config is set)
export OPENAI_API_KEY=sk-...

# Mistral (requires provider to be set in config)
export MISTRAL_API_KEY=...
```

If no API key is configured, users who send voice messages will receive an error message with a setup link.

### Supported Audio Formats

These formats are sent directly to the transcription API (some with a filename remap):

`flac`, `m4a`, `mp3`, `mp4`, `mpeg`, `mpga`, `oga`, `ogg`, `opus`, `wav`, `webm`

These formats are automatically converted to MP3 via ffmpeg (if installed):

`aac`, `amr`, `caf`, `3gp`, `3gpp`

Files over 20MB are automatically split into 10-minute chunks before transcription.

### Channel Support

| Channel   | Format received | Notes |
|-----------|----------------|-------|
| Telegram  | OGG/Opus       | Native voice messages |
| WhatsApp  | OGG/Opus       | Push-to-talk voice messages |
| Signal    | Various        | Voice attachments |
| Discord   | Various        | Audio file attachments |
| Slack     | Various        | Audio file uploads |

## Voice Memos (Sending Voice Notes)

The agent can reply with voice notes using the `<voice>` directive. The text is sent to a TTS provider, converted to OGG Opus audio, and delivered as a native voice bubble (on Telegram and WhatsApp) or a playable audio attachment (on Discord and Slack).

### How It Works

The agent includes a `<voice>` tag in its response:

```xml
<actions>
  <voice>Hey, here's a quick update on that thing we discussed.</voice>
</actions>
```

This can be combined with text -- anything after the `</actions>` block is sent as a normal message alongside the voice note:

```xml
<actions>
  <voice>Here's the summary as audio.</voice>
</actions>
And here it is in text form too!
```

See [directives.md](./directives.md) for the full directive reference.

### Providers

**ElevenLabs** (default):

```yaml
tts:
  provider: elevenlabs
  apiKey: sk_475a...                    # Or ELEVENLABS_API_KEY env var
  voiceId: onwK4e9ZLuTAKqWW03F9         # Or ELEVENLABS_VOICE_ID env var
  model: eleven_multilingual_v2         # Or ELEVENLABS_MODEL_ID
```

Browse voices at [elevenlabs.io/voice-library](https://elevenlabs.io/voice-library).

**OpenAI**:

```yaml
tts:
  provider: openai
  apiKey: sk-...                        # Or OPENAI_API_KEY env var
  voiceId: alloy                        # Or OPENAI_TTS_VOICE (options: alloy, echo, fable, onyx, nova, shimmer)
  model: tts-1                          # Or OPENAI_TTS_MODEL (use tts-1-hd for higher quality)
```

### Channel Support

| Channel   | Delivery | Notes |
|-----------|----------|-------|
| Telegram  | Native voice bubble | Falls back to audio file if user has voice message privacy enabled (Telegram Premium). Users can allow via Settings > Privacy and Security > Voice Messages. |
| WhatsApp  | Native voice bubble | Sent with push-to-talk (`ptt: true`) for native rendering. |
| Discord   | Audio attachment | Playable inline. |
| Slack     | Audio attachment | Playable inline. |
| Signal    | Audio attachment | Sent as a file attachment. |

### When to Use Voice

- User sent a voice message and a voice reply feels natural
- User explicitly asks for a voice/audio response
- Short, conversational responses (under ~30 seconds of speech)

### When NOT to Use Voice

- Code snippets, file paths, URLs, or structured data -- these should be text
- Long responses (keep voice under ~30 seconds)
- When the user has indicated a preference for text

## CLI Tools

### `lettabot-tts`

Generate audio from the command line:

```bash
lettabot-tts "Hello, this is a test"           # Outputs file path to stdout
lettabot-tts "Hello" /tmp/output.ogg            # Explicit output path
```

Output files are written to `data/outbound/` by default and auto-cleaned after 1 hour.

### `lettabot-message --voice`

Send a voice note from a background task (heartbeat, cron):

```bash
# Generate + send in one step
OUTPUT=$(lettabot-tts "Your message here") || exit 1
lettabot-message send --file "$OUTPUT" --voice

# Send to a specific channel
lettabot-message send --file "$OUTPUT" --voice --channel telegram --chat 123456
```

## Environment Variable Reference

| Variable | Description | Default |
|----------|-------------|---------|
| **Transcription** | | |
| `OPENAI_API_KEY` | OpenAI API key (Whisper transcription + OpenAI TTS) | -- |
| `MISTRAL_API_KEY` | Mistral API key (Voxtral transcription) | -- |
| `TRANSCRIPTION_MODEL` | Override transcription model | `whisper-1` / `voxtral-mini-latest` |
| **Text-to-Speech** | | |
| `TTS_PROVIDER` | TTS backend | `elevenlabs` |
| `ELEVENLABS_API_KEY` | ElevenLabs API key | -- |
| `ELEVENLABS_VOICE_ID` | ElevenLabs voice ID | `onwK4e9ZLuTAKqWW03F9` |
| `ELEVENLABS_MODEL_ID` | ElevenLabs model | `eleven_multilingual_v2` |
| `OPENAI_TTS_VOICE` | OpenAI TTS voice name | `alloy` |
| `OPENAI_TTS_MODEL` | OpenAI TTS model | `tts-1` |

All environment variables can be overridden by the equivalent YAML config fields (see above).

## Troubleshooting

### Voice messages not transcribing

1. Check that an API key is configured -- either in `lettabot.yaml` under `transcription.apiKey` or via the `OPENAI_API_KEY` / `MISTRAL_API_KEY` environment variable
2. Check the logs for transcription errors
3. If using an unsupported audio format, install `ffmpeg` for automatic conversion

### Voice memos not generating

1. Check that a TTS provider is configured -- either in `lettabot.yaml` under `tts` or via `ELEVENLABS_API_KEY` / `OPENAI_API_KEY`
2. Check that `jq` and `curl` are installed (required by the `lettabot-tts` script)
3. Check logs for voice pipeline events:
   - `[Bot] Directive voice: generating memo (...)`
   - `[Bot] Directive voice: generated file ...`
   - `[Bot] Directive voice failed: ...`
   - `[Telegram] sendVoice failed, falling back to sendAudio: ...`
4. Check logs for TTS API errors (HTTP status codes, rate limits)

### Docker checklist for voice

For container images, ensure these binaries are available:

- `bash` (required by `lettabot-tts` shebang)
- `curl` and `jq` (required for TTS API calls)
- `ffmpeg` (recommended for full inbound voice transcription compatibility)
- `ca-certificates` (required for HTTPS API calls)

Quick runtime validation from inside the container:

```bash
which bash curl jq ffmpeg
lettabot-tts "TTS health check"
```

### Telegram voice privacy

If the bot sends audio files instead of voice bubbles on Telegram, the recipient has voice message privacy enabled (Telegram Premium feature). They can allow voice messages via Settings > Privacy and Security > Voice Messages.

---

## Discord Voice Channels

LettaBot can join Discord voice channels and play TTS audio in real time. When the bot is in a voice channel, `<voice>` directives play audio directly in the channel (in addition to sending the usual file attachment in text chat).

This is a **half-duplex** implementation: the bot can speak but cannot hear. Voice receive (speech-to-text) is planned for a future release.

### Prerequisites

1. **FFmpeg** must be installed and available in `PATH`. All TTS audio is transcoded through FFmpeg before playback.
   - Docker: already included in the official LettaBot image
   - Linux: `apt install ffmpeg` / `dnf install ffmpeg`
   - macOS: `brew install ffmpeg`

2. **Discord bot permissions** — the bot needs these additional permissions in the voice channel:
   - `Connect` — join the voice channel
   - `Speak` — transmit audio

   Update your invite URL to include voice permissions, or grant them via Server Settings → Roles.

3. **Gateway intent** — `GuildVoiceStates` is automatically enabled when voice is configured. No manual action needed.

### Configuration

Add a `voice` section to your Discord channel config:

```yaml
channels:
  discord:
    enabled: true
    token: "your-bot-token"
    voice:
      enabled: true
      autoJoin:                          # Voice channel IDs to join on startup
        - "1084504969052430379"
      tts:                               # Optional: override global TTS settings for voice
        provider: elevenlabs             # or 'openai'
        voiceId: onwK4e9ZLuTAKqWW03F9
        model: eleven_multilingual_v2
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `voice.enabled` | boolean | `false` | Enable voice channel support |
| `voice.autoJoin` | string[] | -- | Voice channel IDs to auto-join on startup |
| `voice.tts.provider` | string | -- | TTS provider override (`elevenlabs` or `openai`). Falls back to global `tts` config |
| `voice.tts.voiceId` | string | -- | Voice ID override for voice channel TTS |
| `voice.tts.model` | string | -- | Model override for voice channel TTS |

If `voice.tts` is not set, voice playback uses the same TTS provider configured in the global `tts` section.

### Agent Directives

The agent controls voice channels through XML directives in its responses:

**Join a voice channel:**
```xml
<actions><join-voice channel="VOICE_CHANNEL_ID" /></actions>
```

**Leave the current voice channel:**
```xml
<actions><leave-voice /></actions>
```

**Speak in voice (when connected):**
```xml
<actions><voice>Hello everyone, welcome to the channel!</voice></actions>
```

When the bot is connected to a voice channel, `<voice>` directives generate TTS audio and play it in the voice channel. The audio file attachment is still sent in the text channel as well.

If the bot is **not** in a voice channel, `<voice>` only sends the audio as a text channel attachment (the existing behavior).

### Voice Status

The agent sees its current voice connection state in the **Chat Context** section of every Discord message:

- `Voice: Connected — <voice> directives play TTS in voice channel`
- `Voice: Not connected`

This prevents the agent from attempting voice playback when it isn't in a channel (e.g., after a restart).

### Finding Voice Channel IDs

Use the `lettabot-channels list` CLI to find voice channel IDs:

```bash
lettabot-channels list
```

Voice channels are prefixed with 🔊 and show their type:

```
Guild: My Server (1084504967223709756)
  #general              1084504969052430376  text
  🔊 Voice Chat         1084504969052430379  voice
  🔊 Music              1084504969052430380  voice
```

Use the numeric ID (e.g., `1084504969052430379`) in your config or in `<join-voice>` directives.

### Example: Complete Voice Setup

```yaml
# Global TTS config (used by voice memos in all channels)
tts:
  provider: elevenlabs
  apiKey: sk_475a...
  voiceId: onwK4e9ZLuTAKqWW03F9
  model: eleven_multilingual_v2

channels:
  discord:
    enabled: true
    token: "your-bot-token"
    voice:
      enabled: true
      autoJoin:
        - "1084504969052430379"    # Auto-join "Voice Chat" on startup
```

With this config, the bot will:
1. Connect to Discord
2. Automatically join the "Voice Chat" channel
3. Play TTS audio in the voice channel whenever the agent uses `<voice>` directives
4. Show voice connection status in the agent's message context

### Troubleshooting

#### No audio plays in voice channel

1. Check that `ffmpeg` is installed: `which ffmpeg`
2. Check the logs for TTS generation errors — the `<voice>` directive must successfully generate an audio file before playback
3. Verify the bot has `Connect` and `Speak` permissions in the voice channel

#### Bot joins but immediately disconnects

1. Check for errors in the logs after the join message
2. Ensure the voice channel isn't full (check the user limit)
3. Verify the channel ID is correct (use `lettabot-channels list`)

#### Bot doesn't auto-join on startup

1. Confirm `voice.enabled: true` is set
2. Confirm `voice.autoJoin` contains valid voice channel IDs (not text channel IDs)
3. Check that the bot has access to the voice channel (permissions + visibility)

#### "FFmpeg/avconv not found" in logs

FFmpeg is required for voice playback. Install it or ensure it's in the container image. See [Docker checklist](#docker-checklist-for-voice) above.

#### Agent tries to use `<voice>` when not in a channel

The agent sees its voice status in every message. If it still tries to play voice when not connected, check that:
1. `voice.enabled` is `true` in your config
2. The bot was in the channel when the message was received (not between a disconnect and reconnect)
