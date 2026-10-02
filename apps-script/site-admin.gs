/**
 * Site content: events and newsletters.
 *
 * Storage:  a Google Sheet created on first use (ID kept in Script Properties).
 * Public:   GET ?data=site returns published events and newsletters as JSON (read-only).
 * Admin:    GET ?portal=1 serves the admin portal, but only to the script owner.
 *           Every admin function re-checks the caller on the server.
 *
 * Deploy the portal as a second web app deployment:
 *   Execute as: Me, Who has access: Only myself.
 * The public deployment (Access: Anyone) never serves the portal, because anonymous
 * visitors have no active user and fail the owner check.
 */

const DB_PROP = 'SITE_DB_ID';
const SITE_CACHE_KEY = 'site-data-v1';
const SITE_CACHE_SECONDS = 60;

const TABLES = {
  events: ['id', 'title', 'type', 'start', 'end', 'location', 'description', 'link', 'status', 'created', 'updated'],
  newsletters: ['id', 'title', 'author', 'summary', 'body', 'status', 'published', 'created', 'updated']
};

const EVENT_TYPES = ['Operation', 'Combat', 'Mining', 'Salvage', 'Cargo', 'Exploration', 'Training', 'Social', 'Other'];
const STATUSES = ['published', 'draft'];

const LIMITS = {
  title: 120, type: 30, location: 120, description: 2000, link: 300,
  author: 60, summary: 300, body: 20000
};

/* ---------- Access control ---------- */

function isOwner_() {
  const active = Session.getActiveUser().getEmail();
  const owner = Session.getEffectiveUser().getEmail();
  return !!active && !!owner && active === owner;
}

function requireOwner_() {
  if (!isOwner_()) throw new Error('Not authorized.');
}

function servePortal_() {
  if (!isOwner_()) {
    return HtmlService.createHtmlOutput('<p style="font-family:sans-serif;padding:24px">Not found.</p>')
      .setTitle('Not found');
  }
  return HtmlService.createHtmlOutputFromFile('portal')
    .setTitle('Project Six Admin')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ---------- Storage ---------- */

function db_(createIfMissing) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(DB_PROP);
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) { /* sheet deleted or moved: recreate below */ }
  }
  if (!createIfMissing) return null;

  const ss = SpreadsheetApp.create('Project Six Site Data');
  props.setProperty(DB_PROP, ss.getId());
  Object.keys(TABLES).forEach(function (name, i) {
    const sh = i === 0 ? ss.getSheets()[0].setName(name) : ss.insertSheet(name);
    const cols = TABLES[name];
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  return ss;
}

function readTable_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) return [];
  const cols = TABLES[name];
  const rows = sh.getLastRow() - 1;
  if (rows < 1) return [];
  return sh.getRange(2, 1, rows, cols.length).getValues()
    .filter(function (r) { return r[0] !== ''; })
    .map(function (r) {
      const o = {};
      cols.forEach(function (c, i) { o[c] = r[i] instanceof Date ? r[i].toISOString() : String(r[i]); });
      return o;
    });
}

function cell_(v) {
  const s = String(v == null ? '' : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;   // keep text from being read as a formula
}

function writeRow_(sh, cols, item, rowIndex) {
  const values = [cols.map(function (c) { return cell_(item[c]); })];
  if (rowIndex) sh.getRange(rowIndex, 1, 1, cols.length).setValues(values);
  else sh.appendRow(values[0]);
}

function findRow_(sh, id) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) return i + 2;
  return 0;
}

/* ---------- Public read API ---------- */

function getSiteData_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(SITE_CACHE_KEY);
  if (hit) return hit;

  const ss = db_(false);
  let body;
  if (!ss) {
    body = JSON.stringify({ ok: true, checked: new Date().toISOString(), events: [], pastEvents: [], newsletters: [] });
  } else {
    const now = Date.now();
    const events = readTable_(ss, 'events')
      .filter(function (e) { return e.status === 'published' && !isNaN(Date.parse(e.start)); })
      .map(publicEvent_)
      .sort(function (a, b) { return Date.parse(a.start) - Date.parse(b.start); });
    const endsAt = function (e) { return e.end ? Date.parse(e.end) : Date.parse(e.start) + 3 * 3600e3; };
    const upcoming = events.filter(function (e) { return endsAt(e) >= now; });
    const past = events.filter(function (e) { return endsAt(e) < now; }).slice(-10).reverse();

    const newsletters = readTable_(ss, 'newsletters')
      .filter(function (n) { return n.status === 'published'; })
      .map(publicNewsletter_)
      .sort(function (a, b) { return Date.parse(b.published) - Date.parse(a.published); })
      .slice(0, 30);

    body = JSON.stringify({ ok: true, checked: new Date().toISOString(), events: upcoming, pastEvents: past, newsletters: newsletters });
  }
  cache.put(SITE_CACHE_KEY, body, SITE_CACHE_SECONDS);
  return body;
}

function publicEvent_(e) {
  return { id: e.id, title: e.title, type: e.type, start: e.start, end: e.end, location: e.location, description: e.description, link: e.link };
}

function publicNewsletter_(n) {
  return { id: n.id, title: n.title, author: n.author, summary: n.summary, body: n.body, published: n.published };
}

/* ---------- Validation ---------- */

function clean_(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, max);
}

function isoOrEmpty_(v, label) {
  const s = clean_(v, 40);
  if (!s) return '';
  const t = Date.parse(s);
  if (isNaN(t)) throw new Error(label + ' is not a valid date.');
  return new Date(t).toISOString();
}

function safeLink_(v) {
  const s = clean_(v, LIMITS.link);
  if (!s) return '';
  if (!/^https:\/\/[^\s<>"']+$/i.test(s)) throw new Error('Link must start with https:// and contain no spaces.');
  return s;
}

function validateEvent_(input) {
  const e = {
    title: clean_(input.title, LIMITS.title),
    type: clean_(input.type, LIMITS.type),
    start: isoOrEmpty_(input.start, 'Start time'),
    end: isoOrEmpty_(input.end, 'End time'),
    location: clean_(input.location, LIMITS.location),
    description: clean_(input.description, LIMITS.description),
    link: safeLink_(input.link),
    status: clean_(input.status, 20)
  };
  if (!e.title) throw new Error('Title is required.');
  if (!e.start) throw new Error('Start time is required.');
  if (e.end && Date.parse(e.end) < Date.parse(e.start)) throw new Error('End time must be after the start time.');
  if (EVENT_TYPES.indexOf(e.type) < 0) e.type = 'Other';
  if (STATUSES.indexOf(e.status) < 0) e.status = 'draft';
  return e;
}

function validateNewsletter_(input) {
  const n = {
    title: clean_(input.title, LIMITS.title),
    author: clean_(input.author, LIMITS.author),
    summary: clean_(input.summary, LIMITS.summary),
    body: clean_(input.body, LIMITS.body),
    status: clean_(input.status, 20)
  };
  if (!n.title) throw new Error('Title is required.');
  if (!n.body) throw new Error('Body is required.');
  if (!n.summary) n.summary = n.body.replace(/\s+/g, ' ').slice(0, 200) + (n.body.length > 200 ? '…' : '');
  if (STATUSES.indexOf(n.status) < 0) n.status = 'draft';
  return n;
}

/* ---------- Admin API (called from the portal via google.script.run) ---------- */

function adminLoad() {
  requireOwner_();
  const ss = db_(true);
  return {
    user: Session.getActiveUser().getEmail(),
    sheetUrl: ss.getUrl(),
    eventTypes: EVENT_TYPES,
    events: readTable_(ss, 'events').sort(function (a, b) { return Date.parse(b.start) - Date.parse(a.start); }),
    newsletters: readTable_(ss, 'newsletters').sort(function (a, b) { return Date.parse(b.created) - Date.parse(a.created); })
  };
}

function adminSave(kind, input) {
  requireOwner_();
  if (!TABLES[kind]) throw new Error('Unknown content type.');
  input = input || {};
  const clean = kind === 'events' ? validateEvent_(input) : validateNewsletter_(input);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = db_(true);
    const sh = ss.getSheetByName(kind);
    const cols = TABLES[kind];
    const id = clean_(input.id, 64);
    const row = id ? findRow_(sh, id) : 0;
    const now = new Date().toISOString();

    let existing = {};
    if (row) {
      const vals = sh.getRange(row, 1, 1, cols.length).getValues()[0];
      cols.forEach(function (c, i) { existing[c] = vals[i] instanceof Date ? vals[i].toISOString() : String(vals[i]); });
    }

    const item = Object.assign({}, existing, clean, {
      id: row ? existing.id : Utilities.getUuid(),
      created: existing.created || now,
      updated: now
    });
    if (kind === 'newsletters' && item.status === 'published' && !existing.published) item.published = now;

    writeRow_(sh, cols, item, row);
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().remove(SITE_CACHE_KEY);
  return adminLoad();
}

function adminDelete(kind, id) {
  requireOwner_();
  if (!TABLES[kind]) throw new Error('Unknown content type.');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = db_(true).getSheetByName(kind);
    const row = findRow_(sh, clean_(id, 64));
    if (row) sh.deleteRow(row);
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().remove(SITE_CACHE_KEY);
  return adminLoad();
}
