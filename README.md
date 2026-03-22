# Crystalline Rec - Meeting Recorder & Transcriber

A native Windows desktop app for recording meetings, transcribing with AI, and chatting about the content.

## Features

- **Record meetings** with microphone + system audio capture (hear others even with headphones)
- **Start/Pause/Resume** recording controls (Start = new meeting)
- **AI Transcription** via OpenAI Whisper, Deepgram Nova-2, or AssemblyAI with speaker diarization
- **Switch between API models** for transcription
- **Editable transcripts** with timestamps and speaker names (auto-saved)
- **Audio playback** synced with transcript highlighting
- **AI Chat** to ask questions about the transcript (GPT-4o, GPT-4 Turbo, or Claude)
- **Meeting history** stored locally with full transcript and audio
- **Delete meetings** with all associated data

## Setup

### Prerequisites
- [Node.js](https://nodejs.org/) v18+ installed
- A Windows computer (system audio capture uses Windows WASAPI loopback)

### Install & Run

```bash
# 1. Install dependencies
npm install

# 2. Run in development mode
npm start
```

### Build for Distribution

```bash
# Build Windows installer
npm run build

# Build portable .exe
npm run build:portable
```

Output will be in the `dist/` folder.

## Configuration

1. Launch the app and go to **Settings**
2. Configure your **API Keys**:
   - **OpenAI** - for Whisper transcription + GPT-4 chat
   - **Anthropic** - for Claude chat
   - **Deepgram** - for Deepgram Nova-2 transcription
   - **AssemblyAI** - for AssemblyAI transcription
3. Choose your preferred **Transcription Model** and **Chat Model**
4. Select your **Audio Input Device** (microphone)
5. Set your **Save Location** for recordings

## How to Use

### Recording a Meeting
1. Click **"New Recording"** or the start button
2. Toggle **"System Audio"** ON to capture what others say (even with headphones)
3. Use **Pause/Resume** as needed
4. Click **"Finish & Transcribe"** when done

### Reviewing Transcripts
1. Go to **History** to see all meetings
2. Click a meeting to open the detail view
3. **Edit** any transcript text or speaker name (changes auto-save)
4. Click timestamps to **seek** the audio to that point
5. The current segment **highlights** as audio plays

### AI Chat
1. Open a meeting detail view
2. Use the AI chat panel on the right
3. Click **"Summarize"** or **"Key Actions"** for quick insights
4. Ask any question about the meeting content
5. Switch between GPT-4o, GPT-4 Turbo, or Claude

## System Audio Capture (Windows)

The app uses Electron's `desktopCapturer` with Windows WASAPI loopback to capture system audio output. This means it records what comes out of your speakers/headphones — perfect for capturing what other meeting participants say, even when you're wearing headphones.

## Data Storage

All recordings are stored locally at:
```
%USERPROFILE%\Documents\CrystallineRec\
```
(Configurable in Settings)

Each meeting gets its own folder with:
- `meeting.json` - metadata, transcript, chat history
- `recording.webm` - audio file (Opus codec)

## Tech Stack

- **Electron** - Desktop app framework
- **Tailwind CSS** (CDN) - Styling
- **Material Symbols** - Icons
- **electron-store** - Settings persistence
- **OpenAI / Deepgram / AssemblyAI / Anthropic APIs** - AI services
