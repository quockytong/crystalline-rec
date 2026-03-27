const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const Store = require('electron-store');

const store = new Store({
  defaults: {
    saveLocation: path.join(app.getPath('documents'), 'CrystallineRec'),
    audioInputDevice: 'default',
    transcriptionModel: 'gemini-2.5-flash',
    chatModel: 'gemini-2.5-flash',
    apiKeys: {
      google: ''
    }
  }
});

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#ffffff',
      symbolColor: '#1a1c1c',
      height: 36
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#f9f9f9'
  });

  mainWindow.loadFile('index.html');

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(true);
  });
}

app.whenReady().then(() => {
  const saveLocation = store.get('saveLocation');
  if (!fs.existsSync(saveLocation)) {
    fs.mkdirSync(saveLocation, { recursive: true });
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ============ IPC HANDLERS ============

// Expose desktop sources so renderer can pick the correct screen for loopback audio
ipcMain.handle('get-desktop-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 }
  });
  return sources.map(s => ({ id: s.id, name: s.name }));
});

// Settings
ipcMain.handle('get-settings', () => ({
  saveLocation: store.get('saveLocation'),
  audioInputDevice: store.get('audioInputDevice'),
  transcriptionModel: store.get('transcriptionModel'),
  chatModel: store.get('chatModel'),
  apiKeys: store.get('apiKeys')
}));

ipcMain.handle('save-settings', (event, settings) => {
  if (settings.saveLocation)       store.set('saveLocation', settings.saveLocation);
  if (settings.audioInputDevice)   store.set('audioInputDevice', settings.audioInputDevice);
  if (settings.transcriptionModel) store.set('transcriptionModel', settings.transcriptionModel);
  if (settings.chatModel)          store.set('chatModel', settings.chatModel);
  if (settings.apiKeys)            store.set('apiKeys', settings.apiKeys);
  return true;
});

ipcMain.handle('choose-save-location', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Choose Save Location'
  });
  if (!result.canceled && result.filePaths.length > 0) {
    store.set('saveLocation', result.filePaths[0]);
    return result.filePaths[0];
  }
  return null;
});

// Meeting management
ipcMain.handle('create-meeting', (event, title) => {
  const saveLocation = store.get('saveLocation');
  const id = uuidv4();
  const meetingDir = path.join(saveLocation, id);
  fs.mkdirSync(meetingDir, { recursive: true });
  const meeting = {
    id,
    title: title || `Meeting ${new Date().toLocaleDateString()}`,
    createdAt: new Date().toISOString(),
    duration: 0,
    status: 'recording',
    transcript: [],
    chatHistory: []
  };
  fs.writeFileSync(path.join(meetingDir, 'meeting.json'), JSON.stringify(meeting, null, 2));
  return meeting;
});

ipcMain.handle('save-audio', (event, { meetingId, audioBuffer }) => {
  const saveLocation = store.get('saveLocation');
  const audioPath = path.join(saveLocation, meetingId, 'recording.webm');
  fs.writeFileSync(audioPath, Buffer.from(audioBuffer));
  return audioPath;
});

ipcMain.handle('update-meeting', (event, meeting) => {
  const saveLocation = store.get('saveLocation');
  const meetingPath = path.join(saveLocation, meeting.id, 'meeting.json');
  if (fs.existsSync(meetingPath)) {
    fs.writeFileSync(meetingPath, JSON.stringify(meeting, null, 2));
    return true;
  }
  return false;
});

ipcMain.handle('get-meetings', () => {
  const saveLocation = store.get('saveLocation');
  if (!fs.existsSync(saveLocation)) return [];
  const dirs = fs.readdirSync(saveLocation, { withFileTypes: true }).filter(d => d.isDirectory());
  const meetings = [];
  for (const dir of dirs) {
    const f = path.join(saveLocation, dir.name, 'meeting.json');
    if (fs.existsSync(f)) {
      try { meetings.push(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch {}
    }
  }
  return meetings.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
});

ipcMain.handle('get-meeting', (event, meetingId) => {
  const saveLocation = store.get('saveLocation');
  const f = path.join(saveLocation, meetingId, 'meeting.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
});

ipcMain.handle('get-audio-path', (event, meetingId) => {
  const saveLocation = store.get('saveLocation');
  return findAudioFile(path.join(saveLocation, meetingId));
});

ipcMain.handle('get-audio-buffer', (event, meetingId) => {
  const saveLocation = store.get('saveLocation');
  const audioPath = findAudioFile(path.join(saveLocation, meetingId));
  if (!audioPath) return null;
  return fs.readFileSync(audioPath);
});

// Import an audio file from disk as a new meeting
ipcMain.handle('import-audio', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Audio File',
    filters: [
      { name: 'Audio Files', extensions: ['mp3', 'wav', 'webm', 'ogg', 'm4a', 'aac', 'flac', 'wma'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const srcPath = result.filePaths[0];
  const originalName = path.basename(srcPath, path.extname(srcPath));
  const ext = path.extname(srcPath);

  const id = uuidv4();
  const saveLocation = store.get('saveLocation');
  const meetingDir = path.join(saveLocation, id);
  fs.mkdirSync(meetingDir, { recursive: true });

  // Copy audio file to meeting folder, keep original extension
  const destPath = path.join(meetingDir, `recording${ext}`);
  fs.copyFileSync(srcPath, destPath);

  // Get file stats for approximate duration (will be updated when player loads)
  const stats = fs.statSync(destPath);

  const meeting = {
    id,
    title: originalName || `Imported — ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
    createdAt: new Date().toISOString(),
    duration: 0,
    status: 'recorded',
    transcript: [],
    chatHistory: [],
    audioFile: `recording${ext}`
  };

  fs.writeFileSync(path.join(meetingDir, 'meeting.json'), JSON.stringify(meeting, null, 2));
  return meeting;
});

ipcMain.handle('delete-meeting', (event, meetingId) => {
  const saveLocation = store.get('saveLocation');
  const meetingDir = path.join(saveLocation, meetingId);
  if (fs.existsSync(meetingDir)) {
    fs.rmSync(meetingDir, { recursive: true, force: true });
    return true;
  }
  return false;
});

// Transcription — Gemini only
ipcMain.handle('transcribe-audio', async (event, { meetingId, model }) => {
  const saveLocation = store.get('saveLocation');
  const audioPath = findAudioFile(path.join(saveLocation, meetingId));
  const apiKey = store.get('apiKeys').google;

  if (!audioPath) throw new Error('Audio file not found');
  if (!apiKey) throw new Error('Google API key not configured — go to Settings');

  const ext = path.extname(audioPath);
  const mime = mimeForExt(ext);
  const audioBuffer = fs.readFileSync(audioPath);
  return await transcribeWithGemini(audioBuffer, apiKey, model, mime, meetingId);
});

// AI Chat — Gemini only
ipcMain.handle('ai-chat', async (event, { messages, transcript, model }) => {
  const apiKey = store.get('apiKeys').google;
  if (!apiKey) throw new Error('Google API key not configured — go to Settings');

  const systemPrompt =
    `You are an AI assistant helping analyse a meeting transcript.\n\nTranscript:\n${transcript}\n\nAnswer questions accurately based on the transcript. If something is not mentioned, say so clearly.`;

  return await chatWithGemini(systemPrompt, messages, apiKey, model);
});

// ============ HELPERS — FILE LOOKUP ============

const AUDIO_EXTENSIONS = ['.webm', '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.wma'];

function findAudioFile(meetingDir) {
  for (const ext of AUDIO_EXTENSIONS) {
    const p = path.join(meetingDir, `recording${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function mimeForExt(ext) {
  const map = {
    '.webm': 'audio/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    '.flac': 'audio/flac', '.wma': 'audio/x-ms-wma'
  };
  return map[ext] || 'audio/webm';
}

// ============ GEMINI TRANSCRIPTION ============

const CHUNK_DURATION_SEC = 60; // 1-minute windows
const CHUNK_OVERLAP_SEC  = 5;  // 5s tail overlap to avoid cutting words at boundaries
const MAX_RETRIES        = 3;  // retries per chunk before giving up on it
const RETRY_DELAY_MS     = 2000; // base delay; multiplied by attempt number

// Returns approximate bytes/sec for a given mime type — used for duration estimation.
// Direct recordings are webm/opus at ~32kbps (4 KB/s).
// Imported files are typically mp3/m4a at ~128kbps (16 KB/s).
function getBytesPerSec(mime) {
  if (mime === 'audio/webm' || mime === 'audio/ogg') return 4000;
  return 16000;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// After all chunks are merged, remove near-duplicate segments that fell in the
// overlap window between adjacent chunks (same speaker + matching opening text).
function reconcileSegments(segments) {
  if (segments.length === 0) return segments;
  segments.sort((a, b) => a.startTime - b.startTime);
  const out = [];
  for (const seg of segments) {
    const dup = out.some(e =>
      Math.abs(e.startTime - seg.startTime) < 2.0 &&
      e.speaker === seg.speaker &&
      e.text.substring(0, 20) === seg.text.substring(0, 20)
    );
    if (!dup) out.push(seg);
  }
  return out;
}

// Persist partial transcript to disk after each successful chunk so a crash
// or API failure mid-way doesn't lose all progress.
function savePartialTranscript(meetingId, segments) {
  try {
    const p = path.join(store.get('saveLocation'), meetingId, 'meeting.json');
    if (!fs.existsSync(p)) return;
    const meeting = JSON.parse(fs.readFileSync(p, 'utf8'));
    meeting.transcript = segments;
    meeting.status = 'transcribing';
    fs.writeFileSync(p, JSON.stringify(meeting, null, 2));
  } catch (e) {
    console.error('savePartialTranscript:', e.message);
  }
}

async function transcribeWithGemini(audioBuffer, apiKey, model, mime = 'audio/webm', meetingId = null) {
  // Upload the file once; all chunk requests reference the same URI.
  const fileUri = await uploadGeminiFile(audioBuffer, apiKey, mime);

  try {
    // Accurate duration estimate based on codec/format, not arbitrary file-size threshold.
    const estimatedDuration = Math.max(60, Math.ceil(audioBuffer.length / getBytesPerSec(mime)));
    const chunkCount = Math.ceil(estimatedDuration / CHUNK_DURATION_SEC);

    // Short recordings: single-pass transcription is cheaper and faster.
    if (chunkCount <= 2) {
      const segs = await transcribeChunkWithRetry(fileUri, apiKey, model, null, null, [], mime);
      if (meetingId) savePartialTranscript(meetingId, segs);
      return segs;
    }

    const allSegments = [];
    const previousSpeakers = [];

    for (let i = 0; i < chunkCount; i++) {
      const startSec = i * CHUNK_DURATION_SEC;
      // Add overlap tail so words at chunk boundaries are not cut off.
      const endSec   = (i + 1) * CHUNK_DURATION_SEC + CHUNK_OVERLAP_SEC;

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcription-progress', {
          current: i + 1,
          total: chunkCount,
          savedSegments: allSegments.length
        });
      }

      const segments = await transcribeChunkWithRetry(
        fileUri, apiKey, model, startSec, endSec, previousSpeakers, mime
      );

      segments.forEach(seg => {
        if (!previousSpeakers.includes(seg.speaker)) previousSpeakers.push(seg.speaker);
      });
      allSegments.push(...segments);

      // Persist reconciled progress so failures mid-way don't lose work.
      if (meetingId && segments.length > 0) {
        savePartialTranscript(meetingId, reconcileSegments([...allSegments]));
      }
    }

    if (allSegments.length === 0) {
      throw new Error('All transcription chunks failed. Check your API key and try again.');
    }

    return reconcileSegments(allSegments);
  } finally {
    deleteGeminiFile(fileUri, apiKey).catch(() => {});
  }
}

// Wraps transcribeChunk with up to MAX_RETRIES attempts and exponential backoff.
// Returns an empty array (rather than throwing) if all retries are exhausted,
// so the overall transcription can continue with the remaining chunks.
async function transcribeChunkWithRetry(fileUri, apiKey, model, startSec, endSec, knownSpeakers, mime) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await transcribeChunk(fileUri, apiKey, model, startSec, endSec, knownSpeakers, mime);
    } catch (err) {
      lastErr = err;
      const label = startSec !== null ? `${startSec}-${endSec}s` : 'full';
      console.warn(`Chunk [${label}] attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  console.error(`Chunk [${startSec}-${endSec}s] gave up after ${MAX_RETRIES} retries:`, lastErr.message);
  return []; // partial failure — continue with remaining chunks
}

async function transcribeChunk(fileUri, apiKey, model, startSec, endSec, knownSpeakers, mime = 'audio/webm') {
  let timeInstruction = '';
  if (startSec !== null && endSec !== null) {
    const startTs = formatTimestamp(startSec);
    const endTs = formatTimestamp(endSec);
    timeInstruction = `\nOnly transcribe audio between ${startTs} and ${endTs}. Ignore audio outside this window. Timestamps must be absolute (from the start of the full recording).`;
  }

  let speakerInstruction = '';
  if (knownSpeakers && knownSpeakers.length > 0) {
    speakerInstruction = `\nKnown speakers so far: ${knownSpeakers.join(', ')}. Reuse these names if the same voices appear. Only add new speaker labels if you hear a new voice.`;
  }

  const prompt = `Transcribe this meeting audio. Output ONLY a JSON array, no markdown, no explanation.
Label speakers "Speaker 1", "Speaker 2" etc. by voice (consistent throughout).${speakerInstruction}${timeInstruction}
Each item: {"speaker":"Speaker 1","timestamp":"00:00:04","startTime":4.0,"endTime":9.5,"text":"words"}
If the audio segment is silent or has no speech, return an empty array [].
JSON array:`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { fileData: { mimeType: mime, fileUri } },
            { text: prompt }
          ]
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
      })
    }
  );

  if (!res.ok) throw new Error(`Gemini transcription error: ${await res.text()}`);
  const data = await res.json();

  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // Parse JSON — strip any accidental markdown fences
  const clean = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const jsonStart = clean.indexOf('[');
  const jsonEnd = clean.lastIndexOf(']');
  if (jsonStart === -1 || jsonEnd === -1) return []; // empty chunk

  const segments = JSON.parse(clean.slice(jsonStart, jsonEnd + 1));
  return segments.map(seg => ({
    id: uuidv4(),
    speaker: seg.speaker || 'Speaker 1',
    timestamp: seg.timestamp || formatTimestamp(seg.startTime || 0),
    startTime: Number(seg.startTime) || 0,
    endTime: Number(seg.endTime) || 0,
    text: (seg.text || '').trim()
  })).filter(seg => seg.text.length > 0);
}

async function uploadGeminiFile(audioBuffer, apiKey, mime = 'audio/webm') {
  // Multipart upload to the Gemini File API
  const boundary = `----GeminiBoundary${Date.now()}`;
  const meta = JSON.stringify({ file: { mimeType: mime, displayName: 'recording' } });

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${meta}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
    audioBuffer,
    Buffer.from(`\r\n--${boundary}--`)
  ]);

  const res = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=multipart&key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    }
  );

  if (!res.ok) throw new Error(`Gemini file upload failed: ${await res.text()}`);
  const data = await res.json();

  if (!data.file?.uri) throw new Error('Gemini file upload did not return a URI');
  return data.file.uri;
}

async function deleteGeminiFile(fileUri, apiKey) {
  const name = fileUri.split('/files/')[1];
  if (!name) return;
  await fetch(
    `https://generativelanguage.googleapis.com/v1beta/files/${name}?key=${apiKey}`,
    { method: 'DELETE' }
  );
}

// ============ GEMINI CHAT ============

async function chatWithGemini(systemPrompt, messages, apiKey, model) {
  // Map chat history to Gemini's role format (user / model)
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
      })
    }
  );

  if (!res.ok) throw new Error(`Gemini chat error: ${await res.text()}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '(no response)';
}

// ============ HELPERS ============

function formatTimestamp(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map(n => n.toString().padStart(2, '0')).join(':');
}
