/* Ledger — Gmail invoice/refund/recurring-bill tracker
   Everything runs client-side in your browser. Your Gmail data and OAuth
   token never leave this device — there is no backend server. */

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const DB_NAME = 'ledger-db';
const DB_VERSION = 1;

let db = null;
let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;
let currentTab = 'all';
let autoSyncTimer = null;

/* ---------------- IndexedDB ---------------- */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const _db = e.target.result;
      if (!_db.objectStoreNames.contains('transactions')) {
        const store = _db.createObjectStore('transactions', { keyPath: 'id' });
        store.createIndex('monthKey', 'monthKey');
        store.createIndex('category', 'category');
      }
      if (!_db.objectStoreNames.contains('settings')) {
        _db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(store, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbClear(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getSetting(key, fallback) {
  const row = await idbGet('settings', key);
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  await idbPut('settings', { key, value });
}

/* ---------------- Toast ---------------- */

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

/* ---------------- Auth ---------------- */

function waitForGoogleIdentity(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      if (window.google && google.accounts && google.accounts.oauth2) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('Google sign-in script did not load'));
      setTimeout(poll, 100);
    })();
  });
}

async function initTokenClient(clientId) {
  await waitForGoogleIdentity();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: GMAIL_SCOPE,
    callback: '', // set per-request below
  });
}

function requestToken() {
  return new Promise((resolve, reject) => {
    if (!tokenClient) return reject(new Error('Token client not ready'));
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(resp);
      accessToken = resp.access_token;
      tokenExpiresAt = Date.now() + (resp.expires_in - 60) * 1000;
      resolve(accessToken);
    };
    tokenClient.requestAccessToken({ prompt: accessToken ? '' : 'consent' });
  });
}

async function ensureToken() {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
  return requestToken();
}

/* ---------------- Gmail API ---------------- */

async function gmailFetch(path, params = {}) {
  const token = await ensureToken();
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function listMessageIds(query, cap) {
  let ids = [];
  let pageToken = undefined;
  do {
    const params = { q: query, maxResults: 100 };
    if (pageToken) params.pageToken = pageToken;
    const data = await gmailFetch('messages', params);
    if (data.messages) ids = ids.concat(data.messages.map((m) => m.id));
    pageToken = data.nextPageToken;
  } while (pageToken && ids.length < cap);
  return ids.slice(0, cap);
}

function decodeBase64Url(str) {
  try {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(b64);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch (e) {
    return '';
  }
}

function extractBodyText(payload) {
  let text = '';
  let html = '';
  function walk(part) {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body && part.body.data) {
      text += decodeBase64Url(part.body.data) + '\n';
    } else if (part.mimeType === 'text/html' && part.body && part.body.data) {
      html += decodeBase64Url(part.body.data) + '\n';
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(payload);
  if (text.trim()) return text;
  if (html.trim()) return html.replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
  return '';
}

function getHeader(headers, name) {
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

/* ---------------- Parsing / categorization ---------------- */

const REFUND_WORDS = /\b(refund(ed)?|reimburs(ed|ement)|money\s?back|credit(ed)?\s+to\s+your)\b/i;
const BILL_WORDS = /\b(auto[- ]?pay|subscription|statement|payment\s+due|bill(ing)?|renews?\b|renewal|next\s+billing)\b/i;
const INVOICE_WORDS = /\b(invoice|receipt|order\s+confirmation|payment\s+confirmation|purchase|you('|’)ve\s+paid|thank you for your (order|purchase))\b/i;

function categorize(subject, body) {
  const text = `${subject} ${body}`;
  if (REFUND_WORDS.test(text)) return 'refund';
  if (BILL_WORDS.test(text)) return 'bill';
  if (INVOICE_WORDS.test(text)) return 'invoice';
  return null;
}

const AMOUNT_RE = /(?:USD\s?|US\$)?\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/g;
const PRIORITY_CONTEXT = /(total|amount\s+(due|charged|paid)|grand\s+total|refund(ed)?\s+of|you('|’)ve\s+been\s+charged)/i;

function extractAmount(text) {
  const matches = [...text.matchAll(AMOUNT_RE)];
  if (!matches.length) return null;
  // Prefer an amount that appears near priority context words.
  for (const m of matches) {
    const windowStart = Math.max(0, m.index - 40);
    const context = text.slice(windowStart, m.index);
    if (PRIORITY_CONTEXT.test(context)) {
      const val = parseFloat(m[1].replace(/,/g, ''));
      if (!isNaN(val) && val > 0 && val < 100000) return val;
    }
  }
  // Fall back to the largest plausible amount found (avoids grabbing "$5 off").
  const vals = matches
    .map((m) => parseFloat(m[1].replace(/,/g, '')))
    .filter((v) => !isNaN(v) && v > 0 && v < 100000);
  if (!vals.length) return null;
  return Math.max(...vals);
}

function parseSender(fromHeader) {
  const match = fromHeader.match(/^(.*?)<(.+)>$/);
  if (match) {
    return { name: match[1].replace(/"/g, '').trim() || match[2], email: match[2].trim() };
  }
  return { name: fromHeader, email: fromHeader };
}

function domainOf(email) {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : email.toLowerCase();
}

function monthKeyOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function buildTransaction(messageId, headers, bodyText) {
  const subject = getHeader(headers, 'Subject');
  const from = getHeader(headers, 'From');
  const dateHeader = getHeader(headers, 'Date');
  const category = categorize(subject, bodyText);
  if (!category) return null;
  const amount = extractAmount(`${subject}\n${bodyText}`);
  if (amount === null) return null;
  const sender = parseSender(from);
  const date = dateHeader ? new Date(dateHeader) : new Date();
  return {
    id: messageId,
    date: date.toISOString(),
    monthKey: monthKeyOf(date),
    fromName: sender.name,
    fromEmail: sender.email,
    fromDomain: domainOf(sender.email),
    subject: subject || '(no subject)',
    amount,
    category, // 'invoice' | 'refund' | 'bill'
  };
}

/* ---------------- Sync ---------------- */

async function syncNow() {
  const statusEl = document.getElementById('sync-status');
  const syncBtn = document.getElementById('sync-btn');
  syncBtn.disabled = true;
  const lookbackDays = await getSetting('lookbackDays', 180);
  statusEl.textContent = 'Searching Gmail…';
  try {
    const query = `(invoice OR receipt OR refund OR reimbursement OR bill OR statement OR subscription OR "order confirmation" OR "payment confirmation") newer_than:${lookbackDays}d`;
    const ids = await listMessageIds(query, 400);

    const existing = await idbGetAll('transactions');
    const existingIds = new Set(existing.map((t) => t.id));
    const newIds = ids.filter((id) => !existingIds.has(id));

    let added = 0;
    for (let i = 0; i < newIds.length; i++) {
      statusEl.textContent = `Reading messages… ${i + 1}/${newIds.length}`;
      const id = newIds[i];
      try {
        const msg = await gmailFetch(`messages/${id}`, { format: 'full' });
        const headers = msg.payload.headers || [];
        const bodyText = extractBodyText(msg.payload);
        const txn = buildTransaction(id, headers, bodyText);
        if (txn) {
          await idbPut('transactions', txn);
          added++;
        }
      } catch (e) {
        console.warn('Skipping message', id, e);
      }
    }

    await setSetting('lastSync', new Date().toISOString());
    statusEl.textContent = `Synced just now · ${added} new`;
    toast(added ? `Found ${added} new item${added === 1 ? '' : 's'}` : 'Up to date — nothing new');
    await refreshUI();
  } catch (e) {
    console.error(e);
    statusEl.textContent = 'Sync failed — see console';
    toast('Sync failed. Check your Client ID and try again.');
  } finally {
    syncBtn.disabled = false;
  }
}

/* ---------------- Recurring detection ---------------- */
// Groups bill/invoice transactions by sender domain + rounded amount.
// Flags a group "recurring" once it has appeared in 2+ distinct months.

function computeRecurring(transactions) {
  const groups = new Map();
  transactions
    .filter((t) => t.category === 'bill' || t.category === 'invoice')
    .forEach((t) => {
      const key = `${t.fromDomain}::${Math.round(t.amount)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    });

  const recurring = [];
  for (const [, items] of groups) {
    const months = new Set(items.map((t) => t.monthKey));
    if (months.size < 2) continue;
    items.sort((a, b) => new Date(b.date) - new Date(a.date));
    const latest = items[0];
    const last = new Date(latest.date);
    const next = new Date(last);
    next.setDate(next.getDate() + 30);
    recurring.push({
      fromName: latest.fromName,
      fromDomain: latest.fromDomain,
      amount: latest.amount,
      occurrences: items.length,
      lastDate: last,
      nextEstimate: next,
      ids: items.map((t) => t.id),
    });
  }
  recurring.sort((a, b) => b.amount - a.amount);
  return recurring;
}

/* ---------------- Rendering ---------------- */

function money(n) {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatShortDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function refreshUI() {
  const transactions = await idbGetAll('transactions');
  transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
  const recurring = computeRecurring(transactions);
  const recurringIds = new Set(recurring.flatMap((r) => r.ids));

  const invoiceTotal = transactions.filter((t) => t.category === 'invoice').reduce((s, t) => s + t.amount, 0);
  const refundTotal = transactions.filter((t) => t.category === 'refund').reduce((s, t) => s + t.amount, 0);
  const recurringMonthly = recurring.reduce((s, r) => s + r.amount, 0);

  document.getElementById('stat-invoices').textContent = money(invoiceTotal);
  document.getElementById('stat-refunds').textContent = money(refundTotal);
  document.getElementById('stat-recurring').textContent = money(recurringMonthly);

  // Recurring section
  const recurringSection = document.getElementById('recurring-section');
  const recurringList = document.getElementById('recurring-list');
  if (currentTab === 'recurring' || currentTab === 'all') {
    recurringSection.classList.toggle('hidden', recurring.length === 0);
    recurringList.innerHTML = recurring.map((r) => `
      <div class="recurring-row">
        <span class="recurring-dot"></span>
        <div class="recurring-main">
          <div class="recurring-sender">${escapeHtml(r.fromName)}</div>
          <div class="recurring-meta">${r.occurrences} charges seen · next expected ~${formatShortDate(r.nextEstimate)}</div>
        </div>
        <div class="recurring-amount">${money(r.amount)}</div>
      </div>
    `).join('');
  } else {
    recurringSection.classList.add('hidden');
  }

  // Transaction list
  let filtered = transactions;
  let title = 'All activity';
  if (currentTab === 'invoice') { filtered = transactions.filter((t) => t.category === 'invoice'); title = 'Invoices & purchases'; }
  else if (currentTab === 'refund') { filtered = transactions.filter((t) => t.category === 'refund'); title = 'Refunds'; }
  else if (currentTab === 'recurring') { filtered = transactions.filter((t) => recurringIds.has(t.id)); title = 'Recurring bill history'; }

  document.getElementById('list-title').textContent = title;
  const listEl = document.getElementById('txn-list');
  const emptyEl = document.getElementById('empty-state');

  if (filtered.length === 0) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
  } else {
    emptyEl.classList.add('hidden');
    listEl.innerHTML = filtered.map((t) => {
      const isRefund = t.category === 'refund';
      const amountClass = isRefund ? 'amount-refund' : (t.category === 'bill' ? 'amount-bill' : '');
      const sign = isRefund ? '+' : '';
      const badge = recurringIds.has(t.id) ? '<span class="txn-badge badge-recurring">Recurring</span>' : '';
      return `
        <div class="txn-row">
          <div class="txn-date">${formatShortDate(new Date(t.date))}</div>
          <div class="txn-main">
            <div class="txn-sender">${escapeHtml(t.fromName)}${badge}</div>
            <div class="txn-subject">${escapeHtml(t.subject)}</div>
          </div>
          <div class="txn-amount ${amountClass}">${sign}${money(t.amount)}</div>
        </div>
      `;
    }).join('');
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

/* ---------------- Auto-sync interval ---------------- */

async function applyAutoSync() {
  clearInterval(autoSyncTimer);
  const minutes = parseInt(await getSetting('autoSyncMinutes', 0), 10);
  if (minutes > 0) {
    autoSyncTimer = setInterval(() => {
      if (accessToken) syncNow();
    }, minutes * 60 * 1000);
  }
}

/* ---------------- UI wiring ---------------- */

async function showApp() {
  document.getElementById('setup-screen').classList.add('hidden');
  document.getElementById('app-screen').classList.remove('hidden');
}

async function handleSignIn() {
  try {
    await requestToken();
    document.getElementById('signed-out-panel').classList.add('hidden');
    document.getElementById('signed-in-panel').classList.remove('hidden');
    document.getElementById('tab-row').classList.remove('hidden');
    document.getElementById('content').classList.remove('hidden');
    await refreshUI();
    syncNow();
  } catch (e) {
    console.error(e);
    toast('Sign-in was cancelled or failed.');
  }
}

function wireTabs() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      refreshUI();
    });
  });
}

function wireSettings() {
  const sheet = document.getElementById('settings-sheet');
  document.getElementById('settings-btn').addEventListener('click', async () => {
    document.getElementById('auto-sync-select').value = String(await getSetting('autoSyncMinutes', 0));
    document.getElementById('lookback-select').value = String(await getSetting('lookbackDays', 180));
    sheet.classList.remove('hidden');
  });
  document.getElementById('close-settings').addEventListener('click', () => sheet.classList.add('hidden'));

  document.getElementById('auto-sync-select').addEventListener('change', async (e) => {
    await setSetting('autoSyncMinutes', parseInt(e.target.value, 10));
    applyAutoSync();
  });
  document.getElementById('lookback-select').addEventListener('change', async (e) => {
    await setSetting('lookbackDays', parseInt(e.target.value, 10));
    toast('Saved. Tap "Sync now" to apply the new range.');
  });

  document.getElementById('reauth-btn').addEventListener('click', () => {
    accessToken = null;
    tokenExpiresAt = 0;
    requestToken().then(() => toast('Switched account. Syncing…')).then(syncNow);
  });

  document.getElementById('clear-data-btn').addEventListener('click', async () => {
    if (!confirm('Delete all synced invoice/refund/bill data from this device? This cannot be undone.')) return;
    await idbClear('transactions');
    await refreshUI();
    toast('Cleared.');
  });
}

async function init() {
  db = await openDB();

  const savedClientId = await getSetting('clientId', null);
  if (!savedClientId) {
    document.getElementById('setup-screen').classList.remove('hidden');
  } else {
    initTokenClient(savedClientId);
    await showApp();
  }

  document.getElementById('save-client-id').addEventListener('click', async () => {
    const val = document.getElementById('client-id-input').value.trim();
    if (!val.endsWith('.apps.googleusercontent.com')) {
      toast('That doesn\'t look like a Google OAuth Client ID.');
      return;
    }
    await setSetting('clientId', val);
    initTokenClient(val);
    await showApp();
  });

  document.getElementById('signin-btn').addEventListener('click', handleSignIn);
  document.getElementById('sync-btn').addEventListener('click', syncNow);
  wireTabs();
  wireSettings();
  applyAutoSync();

  if (navigator.serviceWorker) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }
}

window.addEventListener('DOMContentLoaded', init);
