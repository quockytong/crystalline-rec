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
  return await transcribeWithGemini(audioBuffer, apiKey, model, mime);
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

const CHUNK_DURATION_SEC = 60; // 1-minute chunks

async function transcribeWithGemini(audioBuffer, apiKey, model, mime = 'audio/webm') {
  // Step 1: upload audio once to the Gemini File API
  const fileUri = await uploadGeminiFile(audioBuffer, apiKey, mime);

  try {
    // Step 2: estimate duration from file size
    // 32kbps mono webm ≈ 4KB/s; imported files may be larger (128kbps ≈ 16KB/s)
    const bytesPerSec = audioBuffer.length > 500000 ? 16000 : 4000;
    const estimatedDuration = Math.max(60, Math.ceil(audioBuffer.length / bytesPerSec));
    const chunkCount = Math.ceil(estimatedDuration / CHUNK_DURATION_SEC);

    // For short audio (≤ 2 min), transcribe in one shot
    if (chunkCount <= 2) {
      return await transcribeChunk(fileUri, apiKey, model, null, null, null, mime);
    }

    // Step 3: transcribe in 1-minute windows to reduce output tokens per call
    const allSegments = [];
    const previousSpeakers = []; // carry speaker names across chunks for consistency

    for (let i = 0; i < chunkCount; i++) {
      const startSec = i * CHUNK_DURATION_SEC;
      const endSec = (i + 1) * CHUNK_DURATION_SEC;

      // Notify renderer of progress
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcription-progress', {
          current: i + 1,
          total: chunkCount
        });
      }

      try {
        const segments = await transcribeChunk(
          fileUri, apiKey, model, startSec, endSec, previousSpeakers, mime
        );
        // Track speaker names for consistency
        segments.forEach(seg => {
          if (!previousSpeakers.includes(seg.speaker)) previousSpeakers.push(seg.speaker);
        });
        allSegments.push(...segments);
      } catch (err) {
        console.error(`Chunk ${i + 1}/${chunkCount} failed:`, err.message);
        // Continue with remaining chunks — don't abort entire transcription
      }
    }

    if (allSegments.length === 0) {
      throw new Error('All transcription chunks failed. Check your API key and try again.');
    }

    return allSegments;
  } finally {
    // Clean up uploaded file
    deleteGeminiFile(fileUri, apiKey).catch(() => {});
  }
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
