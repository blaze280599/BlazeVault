import * as V from './vault.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'page', title: 'Save page to BlazeVault', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'link', title: 'Save link to BlazeVault', contexts: ['link'] });
  });
});

// Saves run one at a time so quick repeated clicks can't overwrite each other's vault writes.
let queue = Promise.resolve();
chrome.contextMenus.onClicked.addListener((info, tab) => {
  queue = queue.then(() => savePage(info, tab)).catch((err) => console.error('BlazeVault save failed', err));
});

async function savePage(info, tab) {
  const item = info.menuItemId === 'link'
    ? { url: info.linkUrl, title: info.linkUrl }
    : { url: info.pageUrl ?? tab?.url, title: tab?.title };
  if (!item.url) return;

  const raw = await V.getSession();
  if (raw) {
    const data = await V.readData(raw);
    const added = V.addItem(data, item);
    if (added) await V.writeData(raw, data);
    flashBadge(added ? '✓' : '=', '#2e7d32');
  } else {
    const count = await V.addPending(item);
    await chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
    await chrome.action.setBadgeText({ text: String(count) });
  }

  if ((await V.getSettings()).removeFromHistory) await chrome.history.deleteUrl({ url: item.url });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'autolock') V.lock();
});

async function flashBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  setTimeout(async () => {
    if (await V.countPending() === 0) chrome.action.setBadgeText({ text: '' });
  }, 1500);
}
