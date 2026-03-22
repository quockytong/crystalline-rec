const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Desktop capturer for system audio
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  chooseSaveLocation: () => ipcRenderer.invoke('choose-save-location'),

  // Meeting CRUD
  createMeeting: (title) => ipcRenderer.invoke('create-meeting', title),
  getMeetings: () => ipcRenderer.invoke('get-meetings'),
  getMeeting: (id) => ipcRenderer.invoke('get-meeting', id),
  updateMeeting: (meeting) => ipcRenderer.invoke('update-meeting', meeting),
  deleteMeeting: (id) => ipcRenderer.invoke('delete-meeting', id),

  // Audio
  saveAudio: (meetingId, audioBuffer) => ipcRenderer.invoke('save-audio', { meetingId, audioBuffer }),
  getAudioPath: (meetingId) => ipcRenderer.invoke('get-audio-path', meetingId),
  getAudioBuffer: (meetingId) => ipcRenderer.invoke('get-audio-buffer', meetingId),

  // AI Services
  transcribeAudio: (meetingId, model) => ipcRenderer.invoke('transcribe-audio', { meetingId, model }),
  aiChat: (messages, transcript, model) => ipcRenderer.invoke('ai-chat', { messages, transcript, model })
});
