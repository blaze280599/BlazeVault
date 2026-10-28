import * as V from './vault.js';

const $ = (sel) => document.querySelector(sel);
const isTab = location.hash.length > 0;
if (isTab) document.body.classList.add('tab');

let key = null;      // raw AES key while unlocked
let data = null;     // decrypted vault contents
let settings = V.DEFAULT_SETTINGS;
let editingId = null;

// ---- helpers ----

function show(view) {
  for (const el of document.querySelectorAll('.view')) el.hidden = el.id !== view;
  $('#headActions').hidden = !(view === 'main' || view === 'settings');
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let toastTimer;
function toast(message, isError = false) {
  const t = $('#toast');
  t.textContent = message;
  t.className = isError ? 'error' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 5000 : 2500);
}

// First click arms the button, a second click within 3s runs the action.
function confirmClick(button, label, action) {
  const original = button.textContent;
  let timer;
  const disarm = () => {
    clearTimeout(timer);
    button.classList.remove('confirming');
    button.textContent = original;
  };
  button.addEventListener('click', async () => {
    if (!button.classList.contains('confirming')) {
      button.classList.add('confirming');
      button.textContent = label;
      timer = setTimeout(disarm, 3000);
      return;
    }
    disarm();
    button.disabled = true;
    try {
      await action();
    } catch (err) {
      toast(err.message, true);
    } finally {
      button.disabled = false;
    }
  });
}

async function busy(button, label, work) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

// Bookmarklets and data: URLs can't be opened from an extension.
function isOpenable(url) {
  return !/^\s*(javascript|data):/i.test(url);
}

async function save() {
  await V.writeData(key, data);
  await V.touch();
}

async function removeFromHistory(urls) {
  if (!settings.removeFromHistory) return;
  await Promise.allSettled(urls.map((url) => chrome.history.deleteUrl({ url })));
}

// ---- startup ----

async function init() {
  settings = await V.getSettings();
  if (location.hash === '#restore') return show('restore');
  if (!(await V.hasVault())) return show('setup');
  const raw = await V.getSession();
  if (raw) return enterVault(raw);
  showLocked();
}

async function showLocked() {
  key = null;
  data = null;
  show('locked');
  const pending = await V.countPending();
  $('#pendingNote').hidden = pending === 0;
  $('#pendingNote').textContent = `${pending} page(s) saved while locked will be added when you unlock.`;
  $('#unlockPw').focus();
}

async function enterVault(raw) {
  key = raw;
  data = await V.readData(key);

  const pending = await V.takePending();
  if (pending.length) {
    const added = pending.filter((item) => V.addItem(data, item)).length;
    await save();
    toast(`Added ${added} page(s) saved while locked`);
  }
  chrome.action.setBadgeText({ text: '' });

  show('main');
  resetAddForm();
  renderList();
}

// The background worker locks the vault when the auto-lock alarm fires.
chrome.storage.session.onChanged.addListener((changes) => {
  if (key && changes.key && !changes.key.newValue) showLocked();
});

// Pick up saves made elsewhere (right-click menu, another vault tab) so ours don't overwrite them.
chrome.storage.local.onChanged.addListener(async (changes) => {
  if (!key || !changes.vault?.newValue) return;
  try {
    data = await V.readData(key);
  } catch {
    return; // Re-encrypted under a new key (password change); the session update follows.
  }
  if (!$('#main').hidden) renderList();
});

// ---- setup / unlock / reset ----

$('#setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('#setupPw').value;
  if (pw !== $('#setupPw2').value) return toast('Passwords do not match', true);
  const raw = await busy(e.submitter, 'Creating…', () => V.createVault(pw));
  enterVault(raw);
});

$('#unlockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const raw = await busy(e.submitter, 'Unlocking…', () => V.unlock($('#unlockPw').value));
    $('#unlockPw').value = '';
    enterVault(raw);
  } catch (err) {
    toast(err.message, true);
    $('#unlockPw').select();
  }
});

$('#resetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('#resetConfirm').value !== 'DELETE') return toast('Type DELETE to confirm', true);
  await V.deleteVault();
  chrome.action.setBadgeText({ text: '' });
  toast('Vault deleted');
  show('setup');
});

$('#btnLock').addEventListener('click', async () => {
  await V.lock();
  showLocked();
});

// ---- add / edit ----

async function resetAddForm() {
  editingId = null;
  $('#addSubmit').textContent = 'Save page';
  $('#addCancel').hidden = true;
  $('#addFolder').value = '';
  $('#addTitle').value = '';
  $('#addUrl').value = '';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && !tab.url.startsWith(location.origin)) {
    $('#addTitle').value = tab.title ?? '';
    $('#addUrl').value = tab.url;
  }
}

function startEdit(item) {
  editingId = item.id;
  $('#addTitle').value = item.title;
  $('#addUrl').value = item.url;
  $('#addFolder').value = item.folder;
  $('#addSubmit').textContent = 'Update';
  $('#addCancel').hidden = false;
  $('#addTitle').focus();
}

$('#addCancel').addEventListener('click', resetAddForm);

$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fields = {
    title: $('#addTitle').value.trim(),
    url: $('#addUrl').value.trim(),
    folder: $('#addFolder').value.trim(),
  };
  if (!isOpenable(fields.url)) return toast('Bookmarklets and data: URLs can\'t be saved', true);

  if (editingId) {
    if (data.items.some((i) => i.url === fields.url && i.id !== editingId)) return toast('That URL is already saved', true);
    Object.assign(data.items.find((i) => i.id === editingId), fields);
    await save();
    toast('Updated');
  } else {
    if (!V.addItem(data, fields)) return toast('Already in the vault', true);
    await save();
    await removeFromHistory([fields.url]);
    toast('Saved');
  }
  resetAddForm();
  renderList();
});

// ---- list ----

function renderList() {
  const folders = [...new Set(data.items.map((i) => i.folder).filter(Boolean))].sort();
  const filter = $('#folderFilter');
  const selected = folders.includes(filter.value) ? filter.value : '';
  filter.replaceChildren(new Option('All folders', ''), ...folders.map((f) => new Option(f, f)));
  filter.value = selected;
  $('#folderList').replaceChildren(...folders.map((f) => new Option(f)));

  const q = $('#search').value.trim().toLowerCase();
  const items = data.items.filter((i) => (!selected || i.folder === selected)
    && (!q || `${i.title} ${i.url} ${i.folder}`.toLowerCase().includes(q)));

  $('#list').replaceChildren(...items.map(itemRow));
  $('#empty').hidden = items.length > 0;
  $('#empty').textContent = data.items.length ? 'Nothing matches.' : 'No bookmarks yet. Save this page above, right-click any page or link, or click Import to bring in your Brave bookmarks.';
}

function itemRow(item) {
  const li = el('li', 'item');

  const main = el('button', 'item-main');
  main.title = item.url;
  main.append(
    el('span', 'item-title', item.title),
    el('span', 'item-sub', [item.folder, hostOf(item.url)].filter(Boolean).join(' · ')),
  );
  main.addEventListener('click', () => openUrl(item.url, settings.openPrivate));

  const alt = el('button', 'icon', settings.openPrivate ? '↗' : '🕶');
  alt.title = settings.openPrivate ? 'Open in a normal tab' : 'Open in a private window';
  alt.addEventListener('click', () => openUrl(item.url, !settings.openPrivate));

  const edit = el('button', 'icon', '✎');
  edit.title = 'Edit';
  edit.addEventListener('click', () => startEdit(item));

  const del = el('button', 'icon', '✕');
  del.title = 'Delete (click twice)';
  confirmClick(del, '✕?', async () => {
    data.items = data.items.filter((i) => i.id !== item.id);
    await save();
    renderList();
  });

  li.append(main, alt, edit, del);
  return li;
}

$('#search').addEventListener('input', renderList);
$('#folderFilter').addEventListener('change', renderList);

async function openUrl(url, inPrivate) {
  await V.touch();
  if (!inPrivate) return chrome.tabs.create({ url });

  if (!(await chrome.extension.isAllowedIncognitoAccess())) {
    return toast('Turn on "Allow in Private" for BlazeVault first (Settings → Open extension settings).', true);
  }
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const privateWindow = windows.find((w) => w.incognito);
  if (privateWindow) {
    await chrome.tabs.create({ windowId: privateWindow.id, url });
    await chrome.windows.update(privateWindow.id, { focused: true });
  } else {
    await chrome.windows.create({ url, incognito: true });
  }
}

// ---- settings ----

async function openSettings() {
  $('#setLock').value = String(settings.lockMinutes);
  $('#setPrivate').checked = settings.openPrivate;
  $('#setHistory').checked = settings.removeFromHistory;
  await updatePrivateWarning();
  await loadBookmarkFolders();
  show('settings');
}

$('#btnSettings').addEventListener('click', openSettings);

$('#btnImportMain').addEventListener('click', async () => {
  await openSettings();
  $('#importSection').scrollIntoView();
  $('#importFolder').focus();
});

$('#btnBack').addEventListener('click', () => {
  show('main');
  renderList();
});

async function updateSettings(patch) {
  settings = { ...settings, ...patch };
  await V.saveSettings(settings);
  await V.touch();
}

async function updatePrivateWarning() {
  $('#privateWarn').hidden = !settings.openPrivate || await chrome.extension.isAllowedIncognitoAccess();
}

$('#setLock').addEventListener('change', (e) => updateSettings({ lockMinutes: Number(e.target.value) }));
$('#setHistory').addEventListener('change', (e) => updateSettings({ removeFromHistory: e.target.checked }));
$('#setPrivate').addEventListener('change', async (e) => {
  await updateSettings({ openPrivate: e.target.checked });
  updatePrivateWarning();
});

$('#btnExtPage').addEventListener('click', () => {
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

// ---- import from Brave bookmarks ----

async function loadBookmarkFolders() {
  const [root] = await chrome.bookmarks.getTree();
  const options = [new Option('All bookmarks', 'all')];
  (function walk(node, path) {
    for (const child of node.children ?? []) {
      if (child.url) continue;
      const childPath = path ? `${path} / ${child.title}` : child.title;
      options.push(new Option(childPath, child.id));
      walk(child, childPath);
    }
  })(root, '');
  $('#importFolder').replaceChildren(...options);
}

confirmClick($('#btnImport'), 'Click again to import', async () => {
  const id = $('#importFolder').value;
  const [folder] = id === 'all' ? await chrome.bookmarks.getTree() : await chrome.bookmarks.getSubTree(id);
  const found = [];
  let unsupported = 0;
  (function walk(node, path) {
    for (const child of node.children ?? []) {
      if (!child.url) walk(child, path ? `${path}/${child.title}` : child.title);
      else if (isOpenable(child.url)) found.push({ id: child.id, url: child.url, title: child.title, folder: path });
      else unsupported++;
    }
  })(folder, folder.title);

  // addItem puts new items on top, so go in reverse to keep the original order.
  const added = [...found].reverse().filter((item) => V.addItem(data, item)).length;
  await save();

  // Remove only what made it into the vault, then any folders that are left empty.
  let notRemoved = 0;
  if ($('#importRemove').checked) {
    for (const item of found) {
      try { await chrome.bookmarks.remove(item.id); } catch { notRemoved++; }
    }
    await pruneEmptyFolders(folder);
  }
  await removeFromHistory(found.map((i) => i.url));

  const notes = [];
  if (found.length > added) notes.push(`${found.length - added} already saved`);
  if (unsupported) notes.push(`${unsupported} bookmarklet(s) left in Brave`);
  if (notRemoved) notes.push(`${notRemoved} couldn't be removed from Brave`);
  toast(`Imported ${added} bookmark(s)${notes.length ? ` (${notes.join(', ')})` : ''}`);
  loadBookmarkFolders();
});

// Built-in root folders (Bookmarks bar, Other bookmarks) can't be removed and are skipped.
async function pruneEmptyFolders(node) {
  for (const child of node.children ?? []) {
    if (!child.url) await pruneEmptyFolders(child);
  }
  if (!node.parentId || node.parentId === '0') return;
  try {
    if ((await chrome.bookmarks.getChildren(node.id)).length === 0) await chrome.bookmarks.remove(node.id);
  } catch {
    // Managed or already-removed folder.
  }
}

// ---- backup ----

$('#btnExport').addEventListener('click', async () => {
  // A data: URL (unlike a blob: URL) keeps working if the popup closes as the download starts.
  const a = document.createElement('a');
  a.href = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(await V.exportVault()))}`;
  a.download = `blazevault-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
});

// The file picker closes extension popups, so restoring happens in a full tab.
for (const button of document.querySelectorAll('[data-restore]')) {
  button.addEventListener('click', () => {
    if (isTab) return show('restore');
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html#restore') });
    window.close();
  });
}

$('#btnChooseFile').addEventListener('click', () => $('#restoreFile').click());
// window.close() is ignored in tabs the page didn't open itself.
$('#btnRestoreCancel').addEventListener('click', async () => {
  const tab = await chrome.tabs.getCurrent();
  chrome.tabs.remove(tab.id);
});

$('#restoreFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    await V.restoreVault(JSON.parse(await file.text()));
    toast('Backup restored. Unlock it with the backup\'s password.');
    showLocked();
  } catch (err) {
    toast(err instanceof SyntaxError ? 'That file is not valid JSON' : err.message, true);
  }
  e.target.value = '';
});

// ---- change password ----

$('#pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('#newPw').value;
  if (pw !== $('#newPw2').value) return toast('Passwords do not match', true);
  key = await busy(e.submitter, 'Changing…', () => V.changePassword(key, pw));
  e.target.reset();
  toast('Password changed. Download a new backup, old ones still use the old password.');
});

init();
