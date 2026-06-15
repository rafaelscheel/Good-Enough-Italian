/* =====================================================
   GOOD ENOUGH ITALIAN — app.js
   ===================================================== */

'use strict';

// ─── Constants ──────────────────────────────────────────────────────────────
const STORAGE_KEY = 'gei-data';
const TOAST_DURATION = 3500; // ms before toast fades out

// ─── State ──────────────────────────────────────────────────────────────────
let state = {
  proxyUrl: '',       // Cloudflare Worker URL
  proxyPassword: '',  // password that gates access to the proxy
  pauseDuration: 1,   // seconds of silence between sentences during list playback
  lists: {}           // { listName: [{ id, en, it }] }
};

// Tracks the currently playing list (for stop functionality)
let playbackQueue = [];
let playbackIndex = 0;
let isPlaying = false;
let currentUtterance = null;
let playingListName = null;
let playbackTimer = null;

// Speech recognition
let recognition = null;
let isRecording = false;

// Context for saving: the current translation result
let pendingTranslation = { en: '', it: '' };

// Context for editing a sentence
let editContext = { listName: '', id: '' };

// ─── Persistence ────────────────────────────────────────────────────────────
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state.proxyUrl = parsed.proxyUrl || '';
      state.proxyPassword = parsed.proxyPassword || '';
      state.pauseDuration = (typeof parsed.pauseDuration === 'number' && parsed.pauseDuration >= 0)
        ? parsed.pauseDuration : 1;
      state.lists = parsed.lists || {};
    }
  } catch (e) {
    console.warn('Failed to load state from localStorage:', e);
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Failed to save state:', e);
  }
  saveListsToCloud();
}

function saveListsToCloud() {
  if (!state.proxyUrl || !state.proxyPassword) return;
  fetch(state.proxyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'save',
      password: state.proxyPassword,
      lists: state.lists,
    }),
  }).catch(() => {});
}

async function loadListsFromCloud() {
  if (!state.proxyUrl || !state.proxyPassword) return;
  try {
    const response = await fetch(state.proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'load', password: state.proxyPassword }),
    });
    if (!response.ok) return;
    const data = await response.json();
    if (data.lists && typeof data.lists === 'object') {
      state.lists = data.lists;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
      renderLists();
    }
  } catch {}
}

// ─── Unique ID ───────────────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ─── Translation via Cloudflare Worker proxy ──────────────────────────────────
async function translateText(text) {
  if (!state.proxyUrl) {
    throw new Error('No proxy URL configured. Please open Settings.');
  }
  if (!state.proxyPassword) {
    throw new Error('No proxy password configured. Please open Settings.');
  }

  let response;
  try {
    response = await fetch(state.proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'translate', text, password: state.proxyPassword }),
    });
  } catch (err) {
    throw new Error('Could not reach the translation proxy. Check the URL in Settings. (' + err.message + ')');
  }

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `Proxy error ${response.status}`);
  }

  return data.translatedText;
}

// ─── Speech Recognition (dictation) ──────────────────────────────────────────
function initDictation() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;

  recognition = new SR();
  recognition.lang = 'en-US';
  recognition.interimResults = true;
  recognition.continuous = false;

  recognition.onresult = (e) => {
    const transcript = Array.from(e.results).map(r => r[0].transcript).join('');
    document.getElementById('english-input').value = transcript;
  };

  recognition.onend = () => {
    isRecording = false;
    updateDictateBtn();
  };

  recognition.onerror = (e) => {
    if (e.error !== 'aborted') {
      showToast('Microphone error: ' + e.error, 'error');
    }
    isRecording = false;
    updateDictateBtn();
  };
}

function toggleDictation() {
  if (!recognition) {
    showToast('Speech recognition is not supported in this browser.', 'warning');
    return;
  }
  if (isRecording) {
    recognition.stop();
  } else {
    document.getElementById('english-input').value = '';
    isRecording = true;
    updateDictateBtn();
    recognition.start();
  }
}

function updateDictateBtn() {
  const btn = document.getElementById('btn-dictate');
  if (!btn) return;
  btn.classList.toggle('recording', isRecording);
  btn.title = isRecording ? 'Stop dictation' : 'Dictate';
  btn.setAttribute('aria-label', isRecording ? 'Stop dictation' : 'Start dictation');
}

// ─── Web Speech ──────────────────────────────────────────────────────────────
function speak(text, onEnd) {
  if (!window.speechSynthesis) {
    showToast('Speech synthesis is not supported in this browser.', 'warning');
    if (onEnd) onEnd();
    return;
  }
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = 'it-IT';
  utt.rate = 0.85;
  utt.onend = () => { if (onEnd) onEnd(); };
  utt.onerror = (e) => {
    // 'interrupted' fires when cancel() is called — that's expected during stop
    if (e.error !== 'interrupted' && e.error !== 'canceled') {
      console.warn('Speech error:', e.error);
    }
    if (onEnd) onEnd();
  };
  currentUtterance = utt;
  window.speechSynthesis.speak(utt);
}

function stopSpeech() {
  isPlaying = false;
  playbackQueue = [];
  playingListName = null;
  if (playbackTimer) { clearTimeout(playbackTimer); playbackTimer = null; }
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  currentUtterance = null;
  renderLists(); // refresh to swap play/stop buttons
}

function playList(listName) {
  const items = state.lists[listName];
  if (!items || items.length === 0) {
    showToast('This list has no sentences to play.', 'warning');
    return;
  }
  stopSpeech(); // stop any existing playback first
  isPlaying = true;
  playingListName = listName;
  playbackQueue = items.map(item => item.it);
  playbackIndex = 0;
  renderLists(); // show stop button
  playNext();
}

function playNext() {
  if (!isPlaying || playbackIndex >= playbackQueue.length) {
    isPlaying = false;
    playingListName = null;
    renderLists(); // revert to play button
    return;
  }
  const text = playbackQueue[playbackIndex];
  playbackIndex++;
  speak(text, () => {
    playbackTimer = setTimeout(playNext, state.pauseDuration * 1000);
  });
}

// ─── Toast notifications ─────────────────────────────────────────────────────
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const icons = { success: '✓', error: '✕', warning: '⚠' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || '✓'}</span><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  // Remove after animation completes (3.2s delay + 0.3s out = 3.5s)
  setTimeout(() => {
    toast.remove();
  }, TOAST_DURATION);
}

// ─── Modals ──────────────────────────────────────────────────────────────────
function openModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.hidden = false;
    // Focus first focusable element
    const focusable = el.querySelector('input, textarea, select, button');
    if (focusable) setTimeout(() => focusable.focus(), 50);
  }
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
}

// ─── Settings modal ──────────────────────────────────────────────────────────
function openSettings() {
  document.getElementById('proxy-url-input').value = state.proxyUrl;
  document.getElementById('proxy-password-input').value = state.proxyPassword;
  document.getElementById('pause-duration-input').value = state.pauseDuration;
  openModal('modal-settings');
}

function saveSettings() {
  const url = document.getElementById('proxy-url-input').value.trim();
  const pwd = document.getElementById('proxy-password-input').value.trim();
  if (!url || !pwd) {
    showToast('Please fill in both the proxy URL and password.', 'warning');
    return;
  }
  const rawPause = parseFloat(document.getElementById('pause-duration-input').value);
  state.proxyUrl = url;
  state.proxyPassword = pwd;
  state.pauseDuration = (!isNaN(rawPause) && rawPause >= 0) ? rawPause : 1;
  saveState();
  closeModal('modal-settings');
  showToast('Settings saved!', 'success');
}

// ─── Tab navigation ──────────────────────────────────────────────────────────
function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const isActive = btn.dataset.tab === tabName;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    const isActive = panel.id === `tab-${tabName}`;
    panel.hidden = !isActive;
  });
  if (tabName === 'lists') {
    renderLists();
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderLists() {
  const container = document.getElementById('lists-container');
  const emptyState = document.getElementById('lists-empty');
  const listNames = Object.keys(state.lists);

  if (listNames.length === 0) {
    container.innerHTML = '';
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  container.innerHTML = listNames.map(name => renderListCard(name)).join('');
}

function renderListCard(name) {
  const items = state.lists[name] || [];
  const isThisPlaying = isPlaying && playingListName === name;
  const safeName = escapeHtml(name);

  const playStopBtn = isThisPlaying
    ? `<button class="btn-icon-sm" data-action="stop-list" data-list="${safeName}" title="Stop playback" aria-label="Stop playing ${safeName}">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <rect x="4" y="4" width="16" height="16" rx="2"/>
        </svg>
       </button>`
    : `<button class="btn-icon-sm play-list-btn" data-action="play-list" data-list="${safeName}" title="Play all aloud" aria-label="Play ${safeName}">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
       </button>`;

  const sentencesHtml = items.length === 0
    ? `<p class="list-empty-msg">No sentences yet. Translate something and save it here!</p>`
    : `<ul class="sentence-list">${items.map(item => renderSentenceItem(name, item)).join('')}</ul>`;

  return `
    <div class="list-card" data-list="${safeName}">
      <div class="list-card-header">
        <span class="list-card-title" title="${safeName}">${safeName}</span>
        <div class="list-card-actions">
          ${playStopBtn}
          <button class="btn-icon-sm danger" data-action="delete-list" data-list="${safeName}" title="Delete list" aria-label="Delete list ${safeName}">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
              <path d="M10 11v6"></path><path d="M14 11v6"></path>
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
            </svg>
          </button>
        </div>
      </div>
      ${sentencesHtml}
    </div>`;
}

function renderSentenceItem(listName, item) {
  const safeList = escapeHtml(listName);
  const safeId   = escapeHtml(item.id);
  const safeIt   = escapeHtml(item.it);
  const safeEn   = escapeHtml(item.en);

  return `
    <li class="sentence-item" data-id="${safeId}" data-list="${safeList}">
      <div class="sentence-text">
        <div class="sentence-it">${safeIt}</div>
        <div class="sentence-en">${safeEn}</div>
      </div>
      <div class="sentence-actions">
        <button class="btn-icon-xs play" data-action="play-sentence" data-it="${safeIt}" title="Play aloud" aria-label="Play Italian">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="none">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
        </button>
        <button class="btn-icon-xs edit" data-action="edit-sentence" data-list="${safeList}" data-id="${safeId}" title="Edit" aria-label="Edit sentence">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
        </button>
        <button class="btn-icon-xs danger" data-action="delete-sentence" data-list="${safeList}" data-id="${safeId}" title="Delete" aria-label="Delete sentence">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
            <path d="M10 11v6"></path><path d="M14 11v6"></path>
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
          </svg>
        </button>
      </div>
    </li>`;
}

// ─── Translation flow ─────────────────────────────────────────────────────────
async function doTranslate() {
  const input = document.getElementById('english-input');
  const text = input.value.trim();

  if (!text) {
    showToast('Please enter an English sentence first.', 'warning');
    return;
  }

  if (!state.proxyUrl || !state.proxyPassword) {
    showToast('Proxy not configured. Opening Settings…', 'warning');
    openSettings();
    return;
  }

  const btn = document.getElementById('btn-translate');
  btn.classList.add('loading');
  btn.innerHTML = '<span class="spinner"></span> Translating…';

  try {
    const italian = await translateText(text);
    pendingTranslation = { en: text, it: italian };

    const outputGroup = document.getElementById('output-group');
    const italianOutput = document.getElementById('italian-output');
    italianOutput.textContent = italian;
    outputGroup.hidden = false;

    // Auto-read aloud
    speak(italian);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.classList.remove('loading');
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="5 12 19 12"></polyline>
        <polyline points="12 5 19 12 12 19"></polyline>
      </svg>
      Translate`;
  }
}

// ─── Save-to-list flow ────────────────────────────────────────────────────────
function openSaveToList() {
  if (!pendingTranslation.it) {
    showToast('Nothing to save yet. Translate a sentence first.', 'warning');
    return;
  }

  // Populate the list select
  const select = document.getElementById('save-list-select');
  const listNames = Object.keys(state.lists);
  const selectGroup = document.getElementById('save-list-select-group');

  if (listNames.length === 0) {
    selectGroup.hidden = true;
  } else {
    selectGroup.hidden = false;
    select.innerHTML = listNames.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  }

  document.getElementById('save-new-list-name').value = '';
  openModal('modal-save-to-list');
}

function confirmSave() {
  const newListInput = document.getElementById('save-new-list-name').value.trim();
  const existingSelect = document.getElementById('save-list-select');
  const selectGroup = document.getElementById('save-list-select-group');

  let targetList = '';

  if (newListInput) {
    // Creating a new list
    targetList = newListInput;
    if (state.lists[targetList]) {
      // List already exists — just add to it
    } else {
      state.lists[targetList] = [];
    }
  } else if (!selectGroup.hidden && existingSelect.value) {
    targetList = existingSelect.value;
  } else {
    showToast('Please choose a list or enter a new list name.', 'warning');
    return;
  }

  // Add the sentence
  const item = {
    id: uid(),
    en: pendingTranslation.en,
    it: pendingTranslation.it
  };
  state.lists[targetList].push(item);
  saveState();
  closeModal('modal-save-to-list');
  showToast(`Saved to "${targetList}"!`, 'success');
}

// ─── New list flow ─────────────────────────────────────────────────────────────
function openNewListModal() {
  document.getElementById('new-list-name').value = '';
  openModal('modal-new-list');
}

function confirmNewList() {
  const nameInput = document.getElementById('new-list-name');
  const name = nameInput.value.trim();
  if (!name) {
    showToast('Please enter a list name.', 'warning');
    return;
  }
  if (state.lists[name]) {
    showToast('A list with that name already exists.', 'warning');
    return;
  }
  state.lists[name] = [];
  saveState();
  closeModal('modal-new-list');
  showToast(`List "${name}" created!`, 'success');
  switchTab('lists');
}

// ─── Delete list ─────────────────────────────────────────────────────────────
function deleteList(name) {
  if (!state.lists.hasOwnProperty(name)) return;
  if (!confirm(`Delete list "${name}" and all its sentences? This cannot be undone.`)) return;
  if (isPlaying && playingListName === name) stopSpeech();
  delete state.lists[name];
  saveState();
  renderLists();
  showToast(`List "${name}" deleted.`, 'success');
}

// ─── Edit sentence ────────────────────────────────────────────────────────────
function openEditSentence(listName, id) {
  const items = state.lists[listName];
  if (!items) return;
  const item = items.find(i => i.id === id);
  if (!item) return;

  editContext = { listName, id };
  document.getElementById('edit-italian').value = item.it;
  document.getElementById('edit-english').value = item.en;
  openModal('modal-edit-sentence');
}

function confirmEdit() {
  const { listName, id } = editContext;
  const newIt = document.getElementById('edit-italian').value.trim();
  const newEn = document.getElementById('edit-english').value.trim();

  if (!newIt || !newEn) {
    showToast('Both fields are required.', 'warning');
    return;
  }

  const items = state.lists[listName];
  if (!items) return;
  const idx = items.findIndex(i => i.id === id);
  if (idx === -1) return;

  items[idx] = { ...items[idx], it: newIt, en: newEn };
  saveState();
  closeModal('modal-edit-sentence');
  renderLists();
  showToast('Sentence updated!', 'success');
}

// ─── Delete sentence ──────────────────────────────────────────────────────────
function deleteSentence(listName, id) {
  const items = state.lists[listName];
  if (!items) return;
  const idx = items.findIndex(i => i.id === id);
  if (idx === -1) return;
  items.splice(idx, 1);
  saveState();
  renderLists();
  showToast('Sentence removed.', 'success');
}

// ─── Event delegation (list container) ───────────────────────────────────────
function handleListsAction(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action   = btn.dataset.action;
  const listName = btn.dataset.list;
  const id       = btn.dataset.id;
  const it       = btn.dataset.it;

  switch (action) {
    case 'play-list':
      playList(listName);
      break;
    case 'stop-list':
      stopSpeech();
      break;
    case 'delete-list':
      deleteList(listName);
      break;
    case 'play-sentence':
      speak(it);
      break;
    case 'edit-sentence':
      openEditSentence(listName, id);
      break;
    case 'delete-sentence':
      deleteSentence(listName, id);
      break;
  }
}

// ─── Modal overlay click (close on backdrop) ──────────────────────────────────
function handleOverlayClick(e) {
  // Close if user clicked the overlay backdrop itself (not the modal content)
  if (e.target.classList.contains('modal-overlay')) {
    e.target.hidden = true;
    // If playback was interrupted by modal, nothing to clean up
  }
}

// ─── Wire up all event listeners ─────────────────────────────────────────────
function initEvents() {
  // Tab nav
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Settings button
  document.getElementById('btn-settings').addEventListener('click', openSettings);

  // Dictation button
  document.getElementById('btn-dictate').addEventListener('click', toggleDictation);

  // Translate button
  document.getElementById('btn-translate').addEventListener('click', doTranslate);

  // Ctrl+Enter in textarea
  document.getElementById('english-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      doTranslate();
    }
  });

  // Play once (re-speak current translation)
  document.getElementById('btn-play-once').addEventListener('click', () => {
    const text = document.getElementById('italian-output').textContent;
    if (text) speak(text);
  });

  // Save to list
  document.getElementById('btn-save-to-list').addEventListener('click', openSaveToList);

  // New list button (My Lists tab)
  document.getElementById('btn-new-list').addEventListener('click', openNewListModal);

  // Settings modal save
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('proxy-password-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveSettings();
  });

  // New list modal confirm
  document.getElementById('btn-confirm-new-list').addEventListener('click', confirmNewList);
  document.getElementById('new-list-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmNewList();
  });

  // Save-to-list modal confirm
  document.getElementById('btn-confirm-save').addEventListener('click', confirmSave);

  // Edit sentence modal confirm
  document.getElementById('btn-confirm-edit').addEventListener('click', confirmEdit);

  // Generic modal close buttons (data-modal attribute = which modal to close)
  document.querySelectorAll('[data-modal]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.modal));
  });

  // Close modal on backdrop click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', handleOverlayClick);
  });

  // Close modal on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay:not([hidden])').forEach(m => {
        m.hidden = true;
      });
    }
  });

  // Event delegation for list actions
  document.getElementById('lists-container').addEventListener('click', handleListsAction);
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
function init() {
  loadState();
  initDictation();
  initEvents();
  renderLists();

  // Open Settings on first load if the proxy isn't configured yet
  if (!state.proxyUrl || !state.proxyPassword) {
    setTimeout(() => openSettings(), 120);
  }

  // Fetch cloud lists in background — renders local cache immediately, updates when cloud responds
  loadListsFromCloud();
}

// Wait for DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
