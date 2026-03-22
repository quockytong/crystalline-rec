// ============================================================
// Crystalline Rec — Renderer Process
// ============================================================

const api = window.electronAPI;

// ── STATE ──────────────────────────────────────────────────
let currentView = 'record';
let currentMeeting = null;
let meetings = [];
let settings = {};

// Recording
let mediaRecorder = null;
let audioChunks = [];
let recordingStream = null;
let systemAudioStream = null;
let audioContext = null;
let analyserNode = null;
let isRecording = false;
let isPaused = false;
let recordingStartTime = 0;
let pausedDuration = 0;
let pauseStartTime = 0;
let timerInterval = null;
let waveformAnimFrame = null;
let systemAudioEnabled = false;

// Player
let audioPlayer = new Audio();
let isPlaying = false;
let currentPlayingMeetingId = null;
const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
let speedIndex = 2; // 1.0x

// Chat
let chatHistory = [];
let autoSaveTimeout = null;

// ── INIT ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await loadMeetings();
  setupNavigation();
  setupRecordingControls();
  setupPlayerControls();
  setupChatControls();
  setupSettingsControls();
  setupDeleteDialog();
  navigateTo('record');
  await enumerateAudioDevices();
});

// ── NAVIGATION ─────────────────────────────────────────────
function setupNavigation() {
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      navigateTo(link.dataset.nav);
    });
  });
  document.getElementById('btn-new-recording').addEventListener('click', startNewRecording);
  document.getElementById('btn-start-from-empty').addEventListener('click', startNewRecording);
  document.getElementById('btn-back-to-history').addEventListener('click', () => navigateTo('history'));
}

function navigateTo(view, data) {
  currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));

  // Nav highlight
  document.querySelectorAll('.nav-link').forEach(link => {
    const active = link.dataset.nav === view || (view === 'detail' && link.dataset.nav === 'history');
    link.classList.toggle('nav-active', active);
    link.classList.toggle('nav-inactive', !active);
  });

  const viewEl = document.getElementById(`view-${view}`);
  if (viewEl) viewEl.classList.remove('hidden');

  updateTopbar(view);

  if (view === 'history') renderHistoryList();
  else if (view === 'detail' && data) openMeetingDetail(data);
  else if (view === 'settings') populateSettings();
  else if (view === 'record' && !isRecording) {
    document.getElementById('record-empty').classList.remove('hidden');
    document.getElementById('record-active').classList.add('hidden');
  }
}

function updateTopbar(view) {
  const title = document.getElementById('topbar-title');
  const live = document.getElementById('topbar-live');
  live.classList.add('hidden');
  const labels = { record: 'Crystalline Rec', history: 'Meeting History', detail: 'Meeting Detail', settings: 'Settings' };
  title.textContent = labels[view] || 'Crystalline Rec';
  if (view === 'record' && isRecording) live.classList.remove('hidden');
}

// ── RECORDING ──────────────────────────────────────────────
function setupRecordingControls() {
  document.getElementById('btn-pause').addEventListener('click', pauseRecording);
  document.getElementById('btn-resume').addEventListener('click', resumeRecording);
  document.getElementById('btn-finish').addEventListener('click', finishRecording);
  document.getElementById('toggle-system-audio').addEventListener('click', toggleSystemAudio);
}

async function startNewRecording() {
  try {
    const title = `Meeting — ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
    currentMeeting = await api.createMeeting(title);

    const micConstraints = {
      audio: {
        deviceId: settings.audioInputDevice !== 'default' ? { exact: settings.audioInputDevice } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000
      }
    };

    recordingStream = await navigator.mediaDevices.getUserMedia(micConstraints);

    audioContext = new AudioContext({ sampleRate: 48000 });
    const src = audioContext.createMediaStreamSource(recordingStream);
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 512;
    src.connect(analyserNode);

    let combinedStream = recordingStream;
    if (systemAudioEnabled) combinedStream = await addSystemAudio(recordingStream);

    mediaRecorder = new MediaRecorder(combinedStream, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 128000
    });
    audioChunks = [];
    mediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) { audioChunks.push(e.data); updateFileSize(); }
    };
    mediaRecorder.start(1000);

    isRecording = true;
    isPaused = false;
    recordingStartTime = Date.now();
    pausedDuration = 0;

    document.getElementById('record-empty').classList.add('hidden');
    document.getElementById('record-active').classList.remove('hidden');
    updateTopbar('record');
    startTimer();
    startWaveform();
    updateRecordingButtons();
    showToast('Recording started', 'fiber_manual_record');
  } catch (err) {
    console.error(err);
    showToast('Failed to start: ' + err.message, 'error');
  }
}

async function toggleSystemAudio() {
  const btn = document.getElementById('toggle-system-audio');
  const dot = btn.querySelector('.toggle-dot');
  systemAudioEnabled = !systemAudioEnabled;

  btn.classList.toggle('bg-primary', systemAudioEnabled);
  btn.classList.toggle('bg-zinc-300', !systemAudioEnabled);
  dot.style.transform = systemAudioEnabled ? 'translateX(16px)' : 'translateX(0)';

  showToast(systemAudioEnabled ? 'System audio ON — captures all meeting audio through headphones' : 'System audio OFF',
            systemAudioEnabled ? 'speaker' : 'speaker_slash');
}

async function addSystemAudio(micStream) {
  try {
    // Get the screen source ID from the main process — required on Windows
    // so Electron knows which loopback device to tap (works even with headphones)
    const sources = await api.getDesktopSources();
    const screenSource = sources.find(s => s.id.startsWith('screen:')) || sources[0];
    if (!screenSource) throw new Error('No screen source found for loopback audio');

    systemAudioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: screenSource.id   // ← key fix: tells Windows which loopback to use
        }
      },
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: screenSource.id,
          maxWidth: 1,
          maxHeight: 1
        }
      }
    });
    // Drop the unwanted video track immediately
    systemAudioStream.getVideoTracks().forEach(t => t.stop());

    const ctx = audioContext || new AudioContext({ sampleRate: 48000 });
    const micSrc = ctx.createMediaStreamSource(micStream);
    const sysSrc = ctx.createMediaStreamSource(new MediaStream(systemAudioStream.getAudioTracks()));
    const dest = ctx.createMediaStreamDestination();
    micSrc.connect(dest);
    sysSrc.connect(dest);
    if (analyserNode) sysSrc.connect(analyserNode);
    return dest.stream;
  } catch (err) {
    console.error('System audio capture failed:', err);
    showToast('System audio unavailable — mic only. ' + err.message, 'warning');
    return micStream;
  }
}

function pauseRecording() {
  if (!isRecording || isPaused) return;
  mediaRecorder.pause();
  isPaused = true;
  pauseStartTime = Date.now();
  updateRecordingButtons();
  setStatusIndicator('Paused', false);
  showToast('Recording paused', 'pause');
}

function resumeRecording() {
  if (!isRecording || !isPaused) return;
  mediaRecorder.resume();
  pausedDuration += Date.now() - pauseStartTime;
  isPaused = false;
  updateRecordingButtons();
  setStatusIndicator('Recording', true);
  showToast('Recording resumed', 'fiber_manual_record');
}

async function finishRecording() {
  if (!isRecording) return;
  return new Promise(resolve => {
    mediaRecorder.onstop = async () => {
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const arrayBuf = await blob.arrayBuffer();
      await api.saveAudio(currentMeeting.id, arrayBuf);

      const duration = (Date.now() - recordingStartTime - pausedDuration) / 1000;
      currentMeeting.duration = duration;
      currentMeeting.status = 'recorded';
      await api.updateMeeting(currentMeeting);

      stopRecordingResources();

      document.getElementById('record-empty').classList.remove('hidden');
      document.getElementById('record-active').classList.add('hidden');
      updateTopbar('record');

      showToast('Recording saved!', 'check_circle');
      await loadMeetings();
      navigateTo('detail', currentMeeting.id);

      // Auto-transcribe if Google API key is configured
      const model = settings.transcriptionModel || 'gemini-2.0-flash';
      if (settings.apiKeys?.google) startTranscription(currentMeeting.id, model);

      resolve();
    };
    mediaRecorder.stop();
  });
}

function stopRecordingResources() {
  isRecording = false; isPaused = false;
  clearInterval(timerInterval);
  cancelAnimationFrame(waveformAnimFrame);
  recordingStream?.getTracks().forEach(t => t.stop()); recordingStream = null;
  systemAudioStream?.getTracks().forEach(t => t.stop()); systemAudioStream = null;
  audioContext?.close(); audioContext = null;
  analyserNode = null; mediaRecorder = null;
}

function updateRecordingButtons() {
  const pauseBtn = document.getElementById('btn-pause');
  const resumeBtn = document.getElementById('btn-resume');
  if (isPaused) {
    pauseBtn.classList.add('opacity-40', 'cursor-not-allowed');
    resumeBtn.className = 'w-14 h-14 rounded-full flex items-center justify-center bg-green-600 text-white shadow-md hover:bg-green-500 transition-all active:scale-95 cursor-pointer';
    resumeBtn.disabled = false;
  } else {
    pauseBtn.classList.remove('opacity-40', 'cursor-not-allowed');
    resumeBtn.className = 'w-14 h-14 rounded-full flex items-center justify-center bg-surface-container-high text-on-surface-variant/30 transition-all cursor-not-allowed';
    resumeBtn.disabled = true;
  }
}

function setStatusIndicator(text, pulsing) {
  const indicator = document.getElementById('record-status-indicator');
  const dot = indicator.querySelector('span:first-child');
  const label = indicator.querySelector('span:last-child');
  label.textContent = text;
  dot.classList.toggle('animate-ping', pulsing);
  dot.classList.toggle('bg-primary', pulsing);
  dot.classList.toggle('bg-yellow-500', !pulsing);
  dot.classList.remove(pulsing ? 'bg-yellow-500' : 'bg-primary');
}

// Timer
function startTimer() {
  timerInterval = setInterval(() => {
    if (isPaused) return;
    const elapsed = (Date.now() - recordingStartTime - pausedDuration) / 1000;
    const m = Math.floor(elapsed / 60);
    const s = Math.floor(elapsed % 60);
    const cs = Math.floor((elapsed % 1) * 100);
    document.getElementById('timer-display').innerHTML =
      `${pad(m)}:${pad(s)}<span class="text-3xl text-primary/30 font-black">.${pad(cs)}</span>`;
  }, 50);
}

// Waveform
function startWaveform() {
  const canvas = document.getElementById('waveform-canvas');
  const ctx = canvas.getContext('2d');
  function draw() {
    waveformAnimFrame = requestAnimationFrame(draw);
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.offsetWidth, h = canvas.offsetHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const barCount = 60;
    const barW = (w / barCount) - 1.5;

    if (!analyserNode || isPaused) {
      for (let i = 0; i < barCount; i++) {
        ctx.fillStyle = 'rgba(166,200,255,0.15)';
        ctx.beginPath();
        ctx.roundRect(i * (barW + 1.5), h / 2 - 2, barW, 4, 2);
        ctx.fill();
      }
      return;
    }

    const bufLen = analyserNode.frequencyBinCount;
    const data = new Uint8Array(bufLen);
    analyserNode.getByteFrequencyData(data);

    for (let i = 0; i < barCount; i++) {
      const idx = Math.floor((i / barCount) * bufLen);
      const v = data[idx] / 255;
      const barH = Math.max(3, v * h);
      const alpha = 0.25 + v * 0.75;
      ctx.fillStyle = `rgba(166,200,255,${alpha})`;
      ctx.beginPath();
      ctx.roundRect(i * (barW + 1.5), h - barH, barW, barH, [2, 2, 0, 0]);
      ctx.fill();
    }

    // Peak level
    const peak = Math.max(...data) / 255;
    const db = peak > 0 ? (20 * Math.log10(peak)).toFixed(1) : '-∞';
    document.getElementById('peak-level-bar').style.width = `${peak * 100}%`;
    document.getElementById('peak-level-db').textContent = `${db} dB`;
  }
  draw();
}

function updateFileSize() {
  const bytes = audioChunks.reduce((s, c) => s + c.size, 0);
  const el = document.getElementById('file-size-display');
  if (bytes < 1024) el.textContent = `${bytes} B`;
  else if (bytes < 1048576) el.textContent = `${(bytes / 1024).toFixed(1)} KB`;
  else el.textContent = `${(bytes / 1048576).toFixed(1)} MB`;
}

// ── HISTORY ────────────────────────────────────────────────
async function loadMeetings() {
  meetings = await api.getMeetings();
}

function renderHistoryList() {
  const itemsEl = document.getElementById('history-items');
  const listEl = document.getElementById('history-list');
  const emptyEl = document.getElementById('history-empty');

  const search = (document.getElementById('history-search')?.value || '').toLowerCase();
  const filtered = search ? meetings.filter(m => m.title.toLowerCase().includes(search)) : meetings;

  if (filtered.length === 0) {
    listEl.classList.add('hidden');
    emptyEl.classList.remove('hidden');
  } else {
    listEl.classList.remove('hidden');
    emptyEl.classList.add('hidden');

    const icons = ['waves', 'clinical_notes', 'person_pin', 'mic_external_on', 'record_voice_over', 'headphones', 'forum'];
    itemsEl.innerHTML = filtered.map(m => {
      const date = new Date(m.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const dur = formatDuration(m.duration || 0);
      const icon = icons[Math.abs(hashCode(m.id)) % icons.length];
      const { cls: statusCls, dot: statusDot, label: statusLabel } = statusBadge(m.status);

      return `
        <div class="grid grid-cols-12 px-6 py-4 items-center hover:bg-zinc-50/70 transition-colors group border-b border-zinc-50 last:border-0 cursor-pointer" data-id="${m.id}">
          <div class="col-span-5 flex items-center gap-3" onclick="navigateTo('detail','${m.id}')">
            <div class="w-9 h-9 rounded-xl bg-secondary-container/30 flex items-center justify-center text-primary shrink-0">
              <span class="material-symbols-outlined text-[18px]">${icon}</span>
            </div>
            <div class="min-w-0">
              <p class="font-semibold text-on-surface group-hover:text-primary transition-colors text-sm truncate">${escapeHtml(m.title)}</p>
              <p class="text-[11px] text-zinc-400">${(m.transcript?.length || 0)} segments</p>
            </div>
          </div>
          <div class="col-span-2 text-[12px] text-zinc-500">${date}</div>
          <div class="col-span-2 text-[12px] text-zinc-500 font-medium tabular-nums">${dur}</div>
          <div class="col-span-2">
            <span class="inline-flex items-center gap-1.5 py-0.5 px-2.5 rounded-full ${statusCls} text-[10px] font-bold">
              <span class="w-1.5 h-1.5 rounded-full ${statusDot}"></span>${statusLabel}
            </span>
          </div>
          <div class="col-span-1 flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button class="p-1.5 hover:bg-white rounded-lg text-zinc-400 hover:text-primary transition-colors shadow-none hover:shadow-sm" onclick="event.stopPropagation();navigateTo('detail','${m.id}')">
              <span class="material-symbols-outlined text-[16px]">open_in_new</span>
            </button>
            <button class="p-1.5 hover:bg-error-container rounded-lg text-zinc-400 hover:text-error transition-colors" onclick="event.stopPropagation();confirmDeleteMeeting('${m.id}')">
              <span class="material-symbols-outlined text-[16px]">delete_outline</span>
            </button>
          </div>
        </div>`;
    }).join('');
  }

  // Stats
  const totalDur = meetings.reduce((s, m) => s + (m.duration || 0), 0);
  document.getElementById('stat-total-time').textContent = formatDuration(totalDur);
  document.getElementById('stat-total-meetings').textContent = meetings.length;
  document.getElementById('stat-transcribed').textContent = meetings.filter(m => m.status === 'transcribed').length;
}

function statusBadge(status) {
  if (status === 'transcribed') return { cls: 'bg-secondary-container text-on-secondary-container', dot: 'bg-primary', label: 'Transcribed' };
  if (status === 'recording') return { cls: 'bg-error-container text-error', dot: 'bg-error animate-pulse', label: 'Recording' };
  return { cls: 'bg-zinc-100 text-zinc-500', dot: 'bg-zinc-400', label: 'Recorded' };
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('history-search')?.addEventListener('input', renderHistoryList);
});

// ── MEETING DETAIL ─────────────────────────────────────────
async function openMeetingDetail(meetingId) {
  const meeting = await api.getMeeting(meetingId);
  if (!meeting) { showToast('Meeting not found', 'error'); navigateTo('history'); return; }

  currentMeeting = meeting;
  chatHistory = meeting.chatHistory || [];

  // Header
  const titleEl = document.getElementById('detail-title');
  titleEl.textContent = meeting.title;
  titleEl.onblur = async () => {
    const t = titleEl.textContent.trim();
    if (t && t !== currentMeeting.title) { currentMeeting.title = t; await api.updateMeeting(currentMeeting); }
  };

  document.getElementById('detail-meta').textContent =
    `${new Date(meeting.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} · ${formatDuration(meeting.duration || 0)}`;

  // Buttons
  document.getElementById('btn-delete-meeting').onclick = () => confirmDeleteMeeting(meetingId);
  document.getElementById('btn-retranscribe').onclick = () => startTranscription(meetingId, settings.transcriptionModel);
  document.getElementById('btn-transcribe-from-detail').onclick = () => startTranscription(meetingId, settings.transcriptionModel);
  document.getElementById('btn-copy-transcript').onclick = () => copyTranscript();

  renderTranscript(meeting);
  loadAudioPlayer(meetingId);
  renderChatHistory();

  // Set chat model select to current setting
  const chatModelSelect = document.getElementById('chat-model-select');
  if (chatModelSelect && settings.chatModel) chatModelSelect.value = settings.chatModel;
}

// ── TRANSCRIPT ─────────────────────────────────────────────
const SPEAKER_PALETTE = [
  'text-primary',
  'text-secondary',
  'text-tertiary-container',
  'text-green-700',
  'text-purple-700',
  'text-rose-600'
];

function speakerColor(speaker) {
  return SPEAKER_PALETTE[Math.abs(hashCode(speaker)) % SPEAKER_PALETTE.length];
}

function renderTranscript(meeting) {
  const content = document.getElementById('transcript-content');
  const loading = document.getElementById('transcript-loading');
  const empty = document.getElementById('transcript-empty');

  loading.classList.add('hidden');

  if (!meeting.transcript?.length) {
    content.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  content.innerHTML = meeting.transcript.map((seg, i) => {
    const color = speakerColor(seg.speaker);
    return `
      <div class="transcript-segment group relative flex gap-6" data-index="${i}" data-start="${seg.startTime || 0}">
        <div class="w-24 shrink-0 text-right pt-0.5">
          <span class="text-[10px] font-black ${color} uppercase tracking-widest block cursor-text speaker-name" contenteditable="true" data-index="${i}" spellcheck="false">${escapeHtml(seg.speaker)}</span>
          <span class="text-[10px] text-zinc-400 font-mono cursor-pointer hover:text-primary transition-colors timestamp-click" data-time="${seg.startTime || 0}">${seg.timestamp}</span>
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-[14px] leading-7 text-on-surface rounded-xl px-3 py-1 -mx-3 -my-1 hover:bg-zinc-50 transition-colors transcript-text" contenteditable="true" data-index="${i}" spellcheck="false">${escapeHtml(seg.text)}</div>
        </div>
      </div>`;
  }).join('');

  setupTranscriptEditing();
}

function copyTranscript() {
  if (!currentMeeting?.transcript?.length) return;
  const text = currentMeeting.transcript
    .map(seg => `[${seg.timestamp}] ${seg.speaker}: ${seg.text}`)
    .join('\n');
  navigator.clipboard.writeText(text).then(() => showToast('Transcript copied to clipboard'));
}

function setupTranscriptEditing() {
  document.querySelectorAll('.transcript-text').forEach(el => {
    el.addEventListener('input', () => {
      const idx = parseInt(el.dataset.index);
      if (currentMeeting.transcript[idx]) {
        currentMeeting.transcript[idx].text = el.textContent.trim();
        debounceSave();
      }
    });
  });

  document.querySelectorAll('.speaker-name').forEach(el => {
    el.addEventListener('input', () => {
      const idx = parseInt(el.dataset.index);
      if (currentMeeting.transcript[idx]) {
        const newName = el.textContent.trim();
        const oldName = currentMeeting.transcript[idx].speaker;
        // Update all segments with same old speaker name
        currentMeeting.transcript.forEach(seg => {
          if (seg.speaker === oldName) seg.speaker = newName;
        });
        debounceSave();
      }
    });
  });

  document.querySelectorAll('.timestamp-click').forEach(el => {
    el.addEventListener('click', () => {
      const t = parseFloat(el.dataset.time);
      if (audioPlayer.src) {
        audioPlayer.currentTime = t;
        if (!isPlaying) { audioPlayer.play(); isPlaying = true; updatePlayBtn(); }
      }
    });
  });
}

function debounceSave() {
  clearTimeout(autoSaveTimeout);
  autoSaveTimeout = setTimeout(async () => {
    await api.updateMeeting(currentMeeting);
    flashAutosave();
  }, 700);
}

function flashAutosave() {
  const el = document.getElementById('detail-autosave');
  if (!el) return;
  el.classList.add('ring-2', 'ring-green-400/50');
  setTimeout(() => el.classList.remove('ring-2', 'ring-green-400/50'), 1200);
}

// ── TRANSCRIPTION ──────────────────────────────────────────
async function startTranscription(meetingId, model) {
  const content = document.getElementById('transcript-content');
  const loading = document.getElementById('transcript-loading');
  const empty = document.getElementById('transcript-empty');

  content.innerHTML = '';
  empty.classList.add('hidden');
  loading.classList.remove('hidden');

  try {
    const transcript = await api.transcribeAudio(meetingId, model);
    const meeting = await api.getMeeting(meetingId);
    meeting.transcript = transcript;
    meeting.status = 'transcribed';
    await api.updateMeeting(meeting);
    currentMeeting = meeting;
    await loadMeetings();
    loading.classList.add('hidden');
    renderTranscript(meeting);
    showToast('Transcription complete!', 'check_circle');
  } catch (err) {
    loading.classList.add('hidden');
    empty.classList.remove('hidden');
    showToast('Transcription failed: ' + err.message, 'error');
    console.error(err);
  }
}

// ── AUDIO PLAYER ───────────────────────────────────────────
function setupPlayerControls() {
  document.getElementById('player-play-pause').addEventListener('click', togglePlay);
  document.getElementById('player-back-10').addEventListener('click', () => { audioPlayer.currentTime = Math.max(0, audioPlayer.currentTime - 10); });
  document.getElementById('player-fwd-10').addEventListener('click', () => { audioPlayer.currentTime = Math.min(audioPlayer.duration || 0, audioPlayer.currentTime + 10); });
  document.getElementById('player-volume').addEventListener('input', e => { audioPlayer.volume = parseFloat(e.target.value); });
  document.getElementById('player-speed').addEventListener('click', () => {
    speedIndex = (speedIndex + 1) % SPEEDS.length;
    audioPlayer.playbackRate = SPEEDS[speedIndex];
    document.getElementById('player-speed').textContent = SPEEDS[speedIndex] + '×';
  });

  // Seekbar
  const bar = document.getElementById('player-progress-bar');
  bar.addEventListener('click', e => {
    const r = bar.getBoundingClientRect();
    const ratio = (e.clientX - r.left) / r.width;
    if (audioPlayer.duration) audioPlayer.currentTime = ratio * audioPlayer.duration;
  });

  // Player events
  audioPlayer.addEventListener('timeupdate', () => {
    if (!audioPlayer.duration) return;
    const pct = (audioPlayer.currentTime / audioPlayer.duration) * 100;
    document.getElementById('player-progress').style.width = `${pct}%`;
    const thumb = document.getElementById('player-thumb');
    if (thumb) { thumb.style.left = `${pct}%`; }
    document.getElementById('player-current-time').textContent = formatTimestamp(audioPlayer.currentTime);
    highlightSegment(audioPlayer.currentTime);
  });

  audioPlayer.addEventListener('loadedmetadata', () => {
    document.getElementById('player-total-time').textContent = formatDuration(audioPlayer.duration);
  });

  audioPlayer.addEventListener('ended', () => { isPlaying = false; updatePlayBtn(); });
}

let currentBlobUrl = null;

async function loadAudioPlayer(meetingId) {
  // Revoke previous blob URL to free memory
  if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }

  // Read file as buffer via IPC → Blob URL (avoids all file:// URL issues on Windows)
  const buffer = await api.getAudioBuffer(meetingId);
  if (buffer) {
    const blob = new Blob([buffer], { type: 'audio/webm' });
    currentBlobUrl = URL.createObjectURL(blob);
    audioPlayer.src = currentBlobUrl;
    audioPlayer.load();
    currentPlayingMeetingId = meetingId;
    isPlaying = false;
    updatePlayBtn();
    document.getElementById('player-progress').style.width = '0%';
    document.getElementById('player-current-time').textContent = '00:00:00';
  }
}

function togglePlay() {
  isPlaying ? audioPlayer.pause() : audioPlayer.play();
  isPlaying = !isPlaying;
  updatePlayBtn();
}

function updatePlayBtn() {
  const icon = document.querySelector('#player-play-pause .material-symbols-outlined');
  if (icon) icon.textContent = isPlaying ? 'pause' : 'play_arrow';
}

function highlightSegment(time) {
  const segs = document.querySelectorAll('.transcript-segment');
  segs.forEach((seg, i) => {
    const start = parseFloat(seg.dataset.start);
    const nextStart = segs[i + 1] ? parseFloat(segs[i + 1].dataset.start) : Infinity;
    const active = time >= start && time < nextStart;
    seg.classList.toggle('bg-primary-fixed/20', active);
    seg.classList.toggle('rounded-2xl', active);
    seg.classList.toggle('px-4', active);
    seg.classList.toggle('py-3', active);
    seg.classList.toggle('-mx-4', active);
    if (active) seg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

// ── AI CHAT ────────────────────────────────────────────────
function setupChatControls() {
  document.getElementById('btn-send-chat').addEventListener('click', sendChat);
  document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  document.querySelectorAll('.chat-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('chat-input').value = btn.dataset.prompt;
      sendChat();
    });
  });
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  input.style.height = '';

  chatHistory.push({ role: 'user', content: msg });
  renderChatHistory();

  const transcriptText = (currentMeeting?.transcript || [])
    .map(s => `[${s.timestamp}] ${s.speaker}: ${s.text}`)
    .join('\n');

  if (!transcriptText) {
    chatHistory.push({ role: 'assistant', content: 'No transcript available yet. Transcribe the recording first.' });
    renderChatHistory(); saveChatHistory(); return;
  }

  // Typing indicator
  const messagesEl = document.getElementById('chat-messages');
  const typing = document.createElement('div');
  typing.id = 'typing-indicator';
  typing.className = 'flex items-center gap-2.5 text-zinc-400 text-sm';
  typing.innerHTML = `<div class="w-6 h-6 bg-gradient-to-br from-primary to-primary-container rounded-lg flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-white text-[12px]" style="font-variation-settings:'FILL' 1;">auto_awesome</span></div><span class="animate-pulse text-[12px]">Thinking…</span>`;
  messagesEl.appendChild(typing);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  try {
    const model = document.getElementById('chat-model-select').value;
    const reply = await api.aiChat(chatHistory, transcriptText, model);
    document.getElementById('typing-indicator')?.remove();
    chatHistory.push({ role: 'assistant', content: reply });
    renderChatHistory(); saveChatHistory();
  } catch (err) {
    document.getElementById('typing-indicator')?.remove();
    chatHistory.push({ role: 'assistant', content: `⚠ ${err.message}` });
    renderChatHistory();
  }
}

function renderChatHistory() {
  const el = document.getElementById('chat-messages');
  if (!chatHistory.length) {
    el.innerHTML = `<div class="flex flex-col items-center justify-center h-full py-12 text-center">
      <div class="w-12 h-12 bg-primary/10 rounded-2xl flex items-center justify-center mb-4">
        <span class="material-symbols-outlined text-primary text-[22px]" style="font-variation-settings:'FILL' 1;">auto_awesome</span>
      </div>
      <p class="text-zinc-500 font-semibold text-sm">Ask about your meeting</p>
      <p class="text-zinc-400 text-[11px] mt-1">Summarize, find actions, analyse speakers…</p>
    </div>`;
    return;
  }

  el.innerHTML = chatHistory.map(m => {
    if (m.role === 'user') {
      return `<div class="flex justify-end"><div class="bg-primary text-white px-4 py-2.5 rounded-2xl rounded-tr-sm text-[13px] max-w-[88%] shadow-sm leading-relaxed">${escapeHtml(m.content)}</div></div>`;
    }
    return `<div class="flex flex-col gap-1.5">
      <div class="flex items-center gap-1.5">
        <div class="w-5 h-5 bg-gradient-to-br from-primary to-primary-container rounded-md flex items-center justify-center">
          <span class="material-symbols-outlined text-white text-[10px]" style="font-variation-settings:'FILL' 1;">auto_awesome</span>
        </div>
        <span class="text-[10px] font-bold text-zinc-400">Crystalline AI</span>
      </div>
      <div class="bg-white border border-zinc-100 px-4 py-3 rounded-2xl rounded-tl-sm text-[13px] text-on-surface leading-relaxed shadow-sm whitespace-pre-wrap max-w-[95%]">${formatAIResponse(m.content)}</div>
    </div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function formatAIResponse(text) {
  // Bold **text**, inline code `code`, preserve line breaks
  return escapeHtml(text)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.*?)`/g, '<code class="bg-zinc-100 px-1 rounded text-xs font-mono">$1</code>')
    .replace(/\n/g, '<br/>');
}

async function saveChatHistory() {
  if (currentMeeting) { currentMeeting.chatHistory = chatHistory; await api.updateMeeting(currentMeeting); }
}

// ── DELETE ─────────────────────────────────────────────────
let pendingDeleteId = null;

function confirmDeleteMeeting(id) {
  pendingDeleteId = id;
  document.getElementById('delete-dialog').classList.remove('hidden');
}

function setupDeleteDialog() {
  document.getElementById('delete-cancel').addEventListener('click', () => {
    document.getElementById('delete-dialog').classList.add('hidden');
    pendingDeleteId = null;
  });
  document.getElementById('delete-confirm').addEventListener('click', async () => {
    if (!pendingDeleteId) return;
    await api.deleteMeeting(pendingDeleteId);
    document.getElementById('delete-dialog').classList.add('hidden');
    if (currentPlayingMeetingId === pendingDeleteId) { audioPlayer.pause(); audioPlayer.src = ''; isPlaying = false; }
    pendingDeleteId = null;
    await loadMeetings();
    showToast('Meeting deleted', 'delete');
    navigateTo('history');
  });
  // Close on backdrop click
  document.getElementById('delete-dialog').addEventListener('click', e => {
    if (e.target === e.currentTarget) {
      e.currentTarget.classList.add('hidden');
      pendingDeleteId = null;
    }
  });
}

// ── SETTINGS ───────────────────────────────────────────────
function setupSettingsControls() {
  document.getElementById('btn-change-save-location').addEventListener('click', async () => {
    const p = await api.chooseSaveLocation();
    if (p) { document.getElementById('settings-save-path').textContent = p; settings.saveLocation = p; showToast('Save location updated', 'folder'); }
  });

  document.getElementById('settings-transcription-model').addEventListener('change', async e => {
    settings.transcriptionModel = e.target.value;
    await api.saveSettings({ transcriptionModel: e.target.value });
    showToast('Transcription model updated', 'check');
  });

  document.getElementById('settings-chat-model').addEventListener('change', async e => {
    settings.chatModel = e.target.value;
    await api.saveSettings({ chatModel: e.target.value });
    showToast('Chat model updated', 'check');
  });

  document.getElementById('settings-audio-input').addEventListener('change', async e => {
    settings.audioInputDevice = e.target.value;
    await api.saveSettings({ audioInputDevice: e.target.value });
    showToast('Audio input updated', 'mic');
  });

  document.querySelectorAll('.btn-save-api').forEach(btn => {
    btn.addEventListener('click', async () => {
      const input = document.getElementById('api-key-google');
      const status = document.getElementById('api-status-google');
      const key = input.value.trim();
      const apiKeys = { google: key };
      await api.saveSettings({ apiKeys });
      settings.apiKeys = apiKeys;
      if (key) {
        status.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-green-500 inline-block"></span> Configured`;
        status.className = 'text-[11px] text-green-600 font-bold flex items-center gap-1.5';
        showToast('Google API key saved', 'check_circle');
      } else {
        status.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-zinc-300 inline-block"></span> Not configured`;
        status.className = 'text-[11px] text-zinc-400 font-bold flex items-center gap-1.5';
      }
    });
  });
}


async function populateSettings() {
  settings = await api.getSettings();
  document.getElementById('settings-save-path').textContent = settings.saveLocation;
  document.getElementById('settings-transcription-model').value = settings.transcriptionModel || 'gemini-2.0-flash';
  document.getElementById('settings-chat-model').value = settings.chatModel || 'gemini-2.0-flash';

  // Google API key only
  const input = document.getElementById('api-key-google');
  const status = document.getElementById('api-status-google');
  if (settings.apiKeys?.google) {
    input.value = settings.apiKeys.google;
    status.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-green-500 inline-block"></span> Configured`;
    status.className = 'text-[11px] text-green-600 font-bold flex items-center gap-1.5';
  }

  await enumerateAudioDevices();
}

async function enumerateAudioDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(d => d.kind === 'audioinput');
    const sel = document.getElementById('settings-audio-input');
    if (!sel) return;
    sel.innerHTML = '<option value="default">Default Microphone</option>';
    inputs.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Microphone (${d.deviceId.slice(0, 8)})`;
      sel.appendChild(opt);
    });
    if (settings.audioInputDevice) sel.value = settings.audioInputDevice;
  } catch { /* permissions not yet granted */ }
}

async function loadSettings() {
  settings = await api.getSettings();
}

// ── UTILITIES ──────────────────────────────────────────────
function pad(n) { return n.toString().padStart(2, '0'); }

function formatTimestamp(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function formatDuration(secs) {
  if (!secs) return '0:00';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function escapeHtml(text) {
  const d = document.createElement('div'); d.textContent = text; return d.innerHTML;
}

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
  return h;
}

let toastTimeout = null;
function showToast(msg, icon = 'info') {
  const toast = document.getElementById('toast');
  const text = document.getElementById('toast-text');
  const iconEl = document.getElementById('toast-icon');
  text.textContent = msg;
  iconEl.textContent = icon;
  toast.classList.remove('hidden');
  toast.classList.add('toast-enter');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.add('hidden');
    toast.classList.remove('toast-enter');
  }, 3000);
}

// ── GLOBALS ────────────────────────────────────────────────
window.navigateTo = navigateTo;
window.confirmDeleteMeeting = confirmDeleteMeeting;
