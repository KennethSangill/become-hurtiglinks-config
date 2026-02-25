/* global chrome */

// -------------------- fallback data (local) --------------------
const FALLBACK_STANDARD = Array.isArray(window.BECOME_HURTIGLINKS) ? window.BECOME_HURTIGLINKS : [];
const FALLBACK_CUSTOMERS = Array.isArray(window.BECOME_CUSTOMERS) ? window.BECOME_CUSTOMERS : [];

// -------------------- sheet integration --------------------
const SHEETS_WEBAPP_URL =
  "https://script.google.com/a/macros/become.dk/s/AKfycbwHdaBg5YXZH6OU04CnfBxaFgqLzeAz4cihcCAUFwCT3okr4xHzGeUZ-BgpJhD7xYLJ6w/exec";

const SHEETS_KEY = "Become-123*";

const GITHUB_STANDARD_URL = `${SHEETS_WEBAPP_URL}?type=standard${SHEETS_KEY ? `&key=${encodeURIComponent(SHEETS_KEY)}` : ""}`;
const GITHUB_CUSTOMERS_URL = `${SHEETS_WEBAPP_URL}?type=customers${SHEETS_KEY ? `&key=${encodeURIComponent(SHEETS_KEY)}` : ""}`;

// -------------------- sync strategy --------------------
// "soft sync": show cache instantly, then sync in background only if >= 24h since last OK
const SOFT_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// -------------------- constants --------------------
const VIEW = {
  standard: "standard",
  customers: "customers"
};

const STORAGE_KEYS = {
  recentCustomers: "become_hurtiglinks_recent_v1",

  customStandard: "become_hurtiglinks_custom_standard_v1",
  customCustomers: "become_hurtiglinks_custom_customers_v1",

  cacheStandard: "become_hurtiglinks_cache_standard_v1",
  cacheCustomers: "become_hurtiglinks_cache_customers_v1",

  meta: "become_hurtiglinks_meta_v1", // { standard:{lastOkAt,lastError}, customers:{lastOkAt,lastError} }
  migratedToLocal: "become_hurtiglinks_migrated_to_local_v1"
};

// we init DOM nodes on DOMContentLoaded to avoid null issues
const el = {};
let currentView = VIEW.standard;

// -------------------- utils --------------------
function normalize(s) {
  return (s || "").toLowerCase().trim();
}

function safeHostname(url) {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return "link";
  }
}

function nowTs() {
  return Date.now();
}

function formatTime(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString("da-DK");
  } catch {
    return "";
  }
}

function setStatus(text, kind) {
  if (!el.status) return;
  el.status.innerHTML = text;
  el.status.classList.remove("ok", "err");
  if (kind === "ok") el.status.classList.add("ok");
  if (kind === "err") el.status.classList.add("err");
}

// -------------------- storage (LOCAL) --------------------
async function getStorage(keys) {
  return await chrome.storage.local.get(keys);
}

async function setStorage(obj) {
  await chrome.storage.local.set(obj);
}

// one-time migration from chrome.storage.sync -> chrome.storage.local
async function migrateSyncToLocalIfNeeded() {
  const local = await chrome.storage.local.get([STORAGE_KEYS.migratedToLocal]);
  if (local[STORAGE_KEYS.migratedToLocal]) return;

  const keysToMove = [
    STORAGE_KEYS.recentCustomers,
    STORAGE_KEYS.customStandard,
    STORAGE_KEYS.customCustomers,
    STORAGE_KEYS.cacheStandard,
    STORAGE_KEYS.cacheCustomers,
    STORAGE_KEYS.meta
  ];

  const fromSync = await chrome.storage.sync.get(keysToMove);
  const hasAnything = keysToMove.some((k) => typeof fromSync[k] !== "undefined");

  if (hasAnything) {
    await chrome.storage.local.set(fromSync);
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.migratedToLocal]: true });
}

function linkId(namespace, ownerId, item) {
  // namespace: "std" or "cus"
  return `${namespace}||${ownerId}||${item.title || ""}||${item.url || ""}`;
}

function openUrl(url) {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

function openMany(urls) {
  (urls || []).forEach((u) => openUrl(u));
}

// accordion behaviour: only one open at a time
function closeOtherFolders(exceptEl) {
  document.querySelectorAll(".folder.open").forEach((node) => {
    if (node !== exceptEl) node.classList.remove("open");
  });
}

function shouldSoftSync(state) {
  const meta = state.meta || {};
  const stdOk = meta.standard && meta.standard.lastOkAt ? meta.standard.lastOkAt : 0;
  const cusOk = meta.customers && meta.customers.lastOkAt ? meta.customers.lastOkAt : 0;

  // If we've never had a successful sync for either dataset -> background sync
  if (!stdOk || !cusOk) return true;

  // Only sync if it's been >= interval since BOTH were OK
  const oldestOk = Math.min(stdOk, cusOk);
  return (Date.now() - oldestOk) >= SOFT_SYNC_INTERVAL_MS;
}

// -------------------- validators --------------------
function validateStandard(data) {
  if (!Array.isArray(data)) return { ok: false, msg: "standard json skal være en array" };
  for (const folder of data) {
    if (!folder || typeof folder !== "object") return { ok: false, msg: "folder skal være et objekt" };
    if (!folder.id || !folder.name) return { ok: false, msg: "folder mangler id eller name" };
    if (!Array.isArray(folder.items)) return { ok: false, msg: `folder "${folder.name}" mangler items array` };
    for (const it of folder.items) {
      if (!it.title || !it.url) return { ok: false, msg: `et link i "${folder.name}" mangler title eller url` };
    }
  }
  return { ok: true };
}

function validateCustomers(data) {
  if (!Array.isArray(data)) return { ok: false, msg: "customers json skal være en array" };
  for (const c of data) {
    if (!c || typeof c !== "object") return { ok: false, msg: "kunde skal være et objekt" };
    if (!c.id || !c.name) return { ok: false, msg: "kunde mangler id eller name" };
    if (!Array.isArray(c.links)) return { ok: false, msg: `kunde "${c.name}" mangler links array` };
    for (const it of c.links) {
      if (!it.title || !it.url) return { ok: false, msg: `et link i "${c.name}" mangler title eller url` };
    }
  }
  return { ok: true };
}

// -------------------- fetch (via background service worker) --------------------
// requires background.js service worker that handles {type:"FETCH_JSON", url}
async function fetchJson(url, validator, label) {
  if (!url) throw new Error(`${label} url er ikke sat`);

  const u = new URL(url);
  u.searchParams.set("_ts", String(Date.now()));

  const resp = await chrome.runtime.sendMessage({
    type: "FETCH_JSON",
    url: u.toString()
  });

  if (!resp || !resp.ok) {
    throw new Error(`${label} fetch fejlede (${resp ? resp.status : "noresp"}): ${resp && resp.text ? resp.text : ""}`);
  }

  const data = resp.data;
  const v = validator(data);
  if (!v.ok) throw new Error(`${label} json ugyldig: ${v.msg}`);

  return data;
}

// -------------------- DOM init --------------------
function initDom() {
  el.tabStandard = document.getElementById("tabStandard");
  el.tabCustomers = document.getElementById("tabCustomers");
  el.search = document.getElementById("search");
  el.btnSync = document.getElementById("btnSync");
  el.btnExport = document.getElementById("btnExport");
  el.btnImport = document.getElementById("btnImport");
  el.status = document.getElementById("status");
  el.content = document.getElementById("content");

  el.importWrap = document.getElementById("importWrap");
  el.importArea = document.getElementById("importArea");
  el.importMsg = document.getElementById("importMsg");
  el.btnImportApply = document.getElementById("btnImportApply");
  el.btnImportCancel = document.getElementById("btnImportCancel");
  el.btnResetOverride = document.getElementById("btnResetOverride");

  const required = [
    "tabStandard",
    "tabCustomers",
    "search",
    "btnSync",
    "btnExport",
    "btnImport",
    "status",
    "content",
    "importWrap",
    "importArea",
    "importMsg",
    "btnImportApply",
    "btnImportCancel",
    "btnResetOverride"
  ];

  for (const id of required) {
    if (!el[id]) throw new Error(`mangler element i popup.html: #${id}`);
  }
}

// -------------------- import/export UI --------------------
function showImport(show) {
  el.importWrap.classList.toggle("hidden", !show);
  el.importMsg.textContent = "";
  el.importMsg.classList.remove("error");
  if (show) el.importArea.focus();
}

function setImportMessage(msg, isError = false) {
  el.importMsg.textContent = msg || "";
  el.importMsg.classList.toggle("error", Boolean(isError));
}

function clearContent() {
  el.content.innerHTML = "";
}

function makeSectionTitle(text) {
  const wrap = document.createElement("div");
  wrap.className = "sectionTitle";
  const h = document.createElement("h2");
  h.textContent = text;
  wrap.appendChild(h);
  return wrap;
}

// -------------------- rendering widgets --------------------
function createLinkRow(link, onClick) {
  const row = document.createElement("div");
  row.className = "linkItem";

  const leftClick = document.createElement("div");
  leftClick.className = "linkClick";

  const left = document.createElement("div");
  left.className = "linkLeft";

  const t = document.createElement("div");
  t.className = "linkTitle";
  t.textContent = link.title;

  const u = document.createElement("div");
  u.className = "linkUrl";
  u.textContent = link.url;

  left.appendChild(t);
  left.appendChild(u);
  leftClick.appendChild(left);

  leftClick.addEventListener("click", () => onClick());
  leftClick.tabIndex = 0;
  leftClick.role = "button";

  const right = document.createElement("div");
  right.className = "linkRight";

  row.appendChild(leftClick);
  row.appendChild(right);

  return row;
}

function createFolder({ title, links, openAllLabel, onOpenAll, onItemClick }) {
  const wrap = document.createElement("section");
  wrap.className = "folder";

  const headerBtn = document.createElement("button");
  headerBtn.className = "folderHeader";
  headerBtn.type = "button";

  const headerLeft = document.createElement("div");
  headerLeft.className = "folderHeaderLeft";

  const leftStack = document.createElement("div");
  leftStack.style.minWidth = "0";

  const name = document.createElement("div");
  name.className = "folderName";
  name.textContent = title;

  leftStack.appendChild(name);
  headerLeft.appendChild(leftStack);

  const headerRight = document.createElement("div");
  headerRight.className = "folderActions";

  const btnOpenAll = document.createElement("button");
  btnOpenAll.className = "actionBtn";
  btnOpenAll.type = "button";
  btnOpenAll.title = openAllLabel || "Åbn alle links";
  btnOpenAll.textContent = "Åbn alle links";

  btnOpenAll.addEventListener("click", (e) => {
    e.stopPropagation();
    onOpenAll();
  });

  const chev = document.createElement("div");
  chev.className = "chev";
  chev.textContent = "Toggle";

  headerRight.appendChild(btnOpenAll);
  headerRight.appendChild(chev);

  headerBtn.appendChild(headerLeft);
  headerBtn.appendChild(headerRight);

  const linksEl = document.createElement("div");
  linksEl.className = "links";

  links.forEach((l) => {
    linksEl.appendChild(createLinkRow(l, () => onItemClick(l)));
  });

  headerBtn.addEventListener("click", () => {
    const isOpen = wrap.classList.contains("open");
    closeOtherFolders(wrap);
    wrap.classList.toggle("open", !isOpen);
  });

  wrap.appendChild(headerBtn);
  wrap.appendChild(linksEl);

  return wrap;
}

// -------------------- state building --------------------
async function loadState() {
  const store = await getStorage([
    STORAGE_KEYS.recentCustomers,

    STORAGE_KEYS.customStandard,
    STORAGE_KEYS.customCustomers,

    STORAGE_KEYS.cacheStandard,
    STORAGE_KEYS.cacheCustomers,

    STORAGE_KEYS.meta
  ]);

  const recentCustomers = Array.isArray(store[STORAGE_KEYS.recentCustomers]) ? store[STORAGE_KEYS.recentCustomers] : [];

  const customStandard = store[STORAGE_KEYS.customStandard];
  const customCustomers = store[STORAGE_KEYS.customCustomers];

  const cacheStandard = store[STORAGE_KEYS.cacheStandard];
  const cacheCustomers = store[STORAGE_KEYS.cacheCustomers];

  const meta = store[STORAGE_KEYS.meta] || {};

  const standard =
    Array.isArray(customStandard) ? customStandard :
    Array.isArray(cacheStandard) ? cacheStandard :
    FALLBACK_STANDARD;

  const customers =
    Array.isArray(customCustomers) ? customCustomers :
    Array.isArray(cacheCustomers) ? cacheCustomers :
    FALLBACK_CUSTOMERS;

  return {
    recentCustomers,
    meta,
    standard,
    customers,
    hasCustomStandard: Array.isArray(customStandard),
    hasCustomCustomers: Array.isArray(customCustomers),
    hasCacheStandard: Array.isArray(cacheStandard),
    hasCacheCustomers: Array.isArray(cacheCustomers)
  };
}

async function addRecentCustomer(customerId) {
  const store = await getStorage([STORAGE_KEYS.recentCustomers]);
  const arr = Array.isArray(store[STORAGE_KEYS.recentCustomers]) ? store[STORAGE_KEYS.recentCustomers] : [];
  const next = [customerId, ...arr.filter((x) => x !== customerId)].slice(0, 12);
  await setStorage({ [STORAGE_KEYS.recentCustomers]: next });
}

async function setCache(which, data) {
  if (which === VIEW.standard) {
    await setStorage({ [STORAGE_KEYS.cacheStandard]: data });
  } else {
    await setStorage({ [STORAGE_KEYS.cacheCustomers]: data });
  }
}

async function setCustom(which, dataOrNull) {
  if (which === VIEW.standard) {
    await setStorage({ [STORAGE_KEYS.customStandard]: dataOrNull });
  } else {
    await setStorage({ [STORAGE_KEYS.customCustomers]: dataOrNull });
  }
}

// -------------------- actions --------------------
function setActiveTab(view) {
  currentView = view;

  el.tabStandard.classList.toggle("active", view === VIEW.standard);
  el.tabCustomers.classList.toggle("active", view === VIEW.customers);

  el.search.placeholder = view === VIEW.standard ? "Søg..." : "Søg..";
}

function computeStatusText(state) {
  const meta = state.meta || {};
  const std = meta.standard || {};
  const cus = meta.customers || {};

  const stdT = std.lastOkAt ? formatTime(std.lastOkAt) : "";
  const cusT = cus.lastOkAt ? formatTime(cus.lastOkAt) : "";

  const stdMode = state.hasCustomStandard ? "standard: lokal override" : (state.hasCacheStandard ? "Hurtiglinks: cache" : "Sync fejl: fallback");
  const cusMode = state.hasCustomCustomers ? "kunder: lokal override" : (state.hasCacheCustomers ? "Kundelinks: cache" : "Sync fejl: fallback");

  return `${stdMode}${stdT ? ` (Sidst ok: ${stdT})` : ""}<br />` +
         `${cusMode}${cusT ? ` (Sidst ok: ${cusT})` : ""}`;
}

function filterStandardFolders(standard, q) {
  if (!q) return standard;

  return standard
    .map((folder) => {
      const items = (folder.items || []).filter((it) => {
        const hay = normalize(`${folder.name} ${it.title} ${it.url}`);
        return hay.includes(q);
      });
      return { ...folder, items };
    })
    .filter((folder) => (folder.items || []).length > 0);
}

function filterCustomers(customers, q) {
  if (!q) return customers;

  const qq = q;
  return customers.filter((c) => {
    const base = normalize(`${c.name} ${(c.tags || []).join(" ")}`);
    if (base.includes(qq)) return true;

    for (const it of c.links || []) {
      const hay = normalize(`${it.title} ${it.url}`);
      if (hay.includes(qq)) return true;
    }
    return false;
  });
}

// -------------------- render sections --------------------
async function renderStandard(state, q) {
  const folders = filterStandardFolders(state.standard, q);

  for (const folder of folders) {
    const links = (folder.items || []).map((it) => ({
      title: it.title,
      url: it.url,
      id: linkId("std", folder.id, it)
    }));

    const folderEl = createFolder({
      title: folder.name,
      links,
      openAllLabel: `åbn alle i ${folder.name}`,
      onOpenAll: () => openMany(links.map((l) => l.url)),
      onItemClick: (l) => openUrl(l.url)
    });

    folderEl.dataset.folderId = folder.id;
    el.content.appendChild(folderEl);
  }

  if (folders.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "ingen resultater";
    el.content.appendChild(empty);
    return;
  }

  if (q) {
    const first = el.content.querySelector(".folder");
    if (first) first.classList.add("open");
  }
}

async function renderCustomers(state, q) {
  const customers = filterCustomers(state.customers, q);

  if (!q && state.recentCustomers.length > 0) {
    const map = new Map(state.customers.map((c) => [c.id, c]));
    const recent = state.recentCustomers.map((id) => map.get(id)).filter(Boolean);

    if (recent.length > 0) {
      el.content.appendChild(makeSectionTitle("senest brugte"));

      for (const c of recent) {
        const links = (c.links || []).map((it) => ({
          title: it.title,
          url: it.url,
          id: linkId("cus", c.id, it)
        }));

        const folderEl = createFolder({
          title: c.name,
          links,
          openAllLabel: `åbn alle for ${c.name}`,
          onOpenAll: async () => {
            await addRecentCustomer(c.id);
            openMany(links.map((l) => l.url));
          },
          onItemClick: async (l) => {
            await addRecentCustomer(c.id);
            openUrl(l.url);
          }
        });

        folderEl.dataset.folderId = c.id;
        el.content.appendChild(folderEl);
      }
    }
  }

  el.content.appendChild(makeSectionTitle(q ? "kunder (filtreret)" : "alle kunder"));

  if (customers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "ingen kunder fundet";
    el.content.appendChild(empty);
    return;
  }

  for (const c of customers) {
    const links = (c.links || []).map((it) => ({
      title: it.title,
      url: it.url,
      id: linkId("cus", c.id, it)
    }));

    const folderEl = createFolder({
      title: c.name,
      links,
      openAllLabel: `åbn alle for ${c.name}`,
      onOpenAll: async () => {
        await addRecentCustomer(c.id);
        openMany(links.map((l) => l.url));
      },
      onItemClick: async (l) => {
        await addRecentCustomer(c.id);
        openUrl(l.url);
      }
    });

    folderEl.dataset.folderId = c.id;
    el.content.appendChild(folderEl);
  }

  if (q) {
    const first = el.content.querySelector(".folder");
    if (first) first.classList.add("open");
  }
}

async function render() {
  const state = await loadState();
  const q = normalize(el.search.value);

  clearContent();
  setStatus(computeStatusText(state), "ok");

  if (currentView === VIEW.standard) {
    await renderStandard(state, q);
  } else {
    await renderCustomers(state, q);
  }
}

// -------------------- sync (remote) --------------------
async function syncGithub() {
  // keep UI responsive: set status, but don't block render usage
  setStatus("sync i gang...", "ok");

  const meta = (await getStorage([STORAGE_KEYS.meta]))[STORAGE_KEYS.meta] || {};
  const nextMeta = { ...meta };

  // standard
  try {
    const data = await fetchJson(GITHUB_STANDARD_URL, validateStandard, "standard");
    await setCache(VIEW.standard, data);
    await setCustom(VIEW.standard, null);
    nextMeta.standard = { ...(nextMeta.standard || {}), lastOkAt: nowTs(), lastError: null };
  } catch (e) {
    nextMeta.standard = { ...(nextMeta.standard || {}), lastError: String(e && e.message ? e.message : e) };
  }

  // customers
  try {
    const data = await fetchJson(GITHUB_CUSTOMERS_URL, validateCustomers, "kunder");
    await setCache(VIEW.customers, data);
    await setCustom(VIEW.customers, null);
    nextMeta.customers = { ...(nextMeta.customers || {}), lastOkAt: nowTs(), lastError: null };
  } catch (e) {
    nextMeta.customers = { ...(nextMeta.customers || {}), lastError: String(e && e.message ? e.message : e) };
  }

  await setStorage({ [STORAGE_KEYS.meta]: nextMeta });

  const anyErr = (nextMeta.standard && nextMeta.standard.lastError) || (nextMeta.customers && nextMeta.customers.lastError);
  if (anyErr) setStatus("sync færdig (med fejl). tjek sheet + json format.", "err");
  else setStatus("sync ok", "ok");

  await render();
}

// -------------------- export/import active view --------------------
async function exportActiveView() {
  const state = await loadState();
  const payload = currentView === VIEW.standard ? state.standard : state.customers;
  const json = JSON.stringify(payload, null, 2);

  showImport(true);
  el.importArea.value = json;

  try {
    await navigator.clipboard.writeText(json);
    setImportMessage("export kopieret til clipboard");
  } catch {
    setImportMessage("kunne ikke kopiere automatisk — kopier manuelt fra feltet");
  }
}

async function importActiveView() {
  showImport(true);
  el.importArea.value = "";
  setImportMessage("indsæt json og tryk indlæs");
}

async function applyImport() {
  const raw = el.importArea.value || "";
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    setImportMessage("ugyldig json", true);
    return;
  }

  if (currentView === VIEW.standard) {
    const v = validateStandard(parsed);
    if (!v.ok) return setImportMessage(v.msg, true);
    await setCustom(VIEW.standard, parsed);
    setImportMessage("import ok (standard lokal override aktiv)");
  } else {
    const v = validateCustomers(parsed);
    if (!v.ok) return setImportMessage(v.msg, true);
    await setCustom(VIEW.customers, parsed);
    setImportMessage("import ok (kunder lokal override aktiv)");
  }

  await render();
}

async function resetOverride() {
  await setCustom(currentView, null);
  setImportMessage("lokal override fjernet", false);
  await render();
}

// -------------------- events --------------------
function bindEvents() {
  el.tabStandard.addEventListener("click", async () => {
    setActiveTab(VIEW.standard);
    await render();
  });

  el.tabCustomers.addEventListener("click", async () => {
    setActiveTab(VIEW.customers);
    await render();
  });

  el.search.addEventListener("input", async () => render());

  el.btnSync.addEventListener("click", async () => syncGithub());
  el.btnExport.addEventListener("click", async () => exportActiveView());
  el.btnImport.addEventListener("click", async () => importActiveView());

  el.btnImportCancel.addEventListener("click", () => showImport(false));
  el.btnImportApply.addEventListener("click", async () => applyImport());
  el.btnResetOverride.addEventListener("click", async () => resetOverride());
}

// -------------------- init (wait for DOM) --------------------
document.addEventListener("DOMContentLoaded", async () => {
  try {
    await migrateSyncToLocalIfNeeded();

    initDom();
    bindEvents();
    setActiveTab(VIEW.standard);

    // 1) show cached content immediately (fast)
    await render();

    const urlsOk = Boolean(GITHUB_STANDARD_URL) && Boolean(GITHUB_CUSTOMERS_URL);
    if (!urlsOk) {
      const state = await loadState();
      setStatus(computeStatusText(state), "err");
      return;
    }

    // 2) soft sync in background only if needed (does not block UI)
    const state = await loadState();
    if (shouldSoftSync(state)) {
      // no await on purpose
      syncGithub();
    } else {
      setStatus(computeStatusText(state), "ok");
    }
  } catch (e) {
    console.error(e);
    setStatus(`fejl: ${e && e.message ? e.message : String(e)}`, "err");
  }
});