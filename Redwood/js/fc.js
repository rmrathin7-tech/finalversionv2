import { db, auth } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, updateDoc, serverTimestamp, onSnapshot,
  collection, setDoc, deleteDoc, addDoc, getDoc, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { loadSchema, subscribeToSchema } from "./im-core/schema-service.js";
import { renderSection as renderSectionDOM } from "./im-core/renderer.js";
import { getNestedValue, setNestedValue } from "./im-core/utils.js";

const storage = getStorage();

// ── GLOBAL STATE ──────────────────────────────────────────
let currentFcId       = null;
let currentProjectId  = null;
let currentFcData     = {};
let isPreviewMode     = false;
let unsubscribeFc     = null;
let currentSectionKey = null;
let isTyping          = false;
let typingTimer       = null;
let currentUserId     = null;
let currentUserName   = null;
let fcSchema          = [];
let unsubscribeSchema = null;
let unsubscribeComments = null;

let localCapTable           = [];
let localIndianCompetitors  = [];
let localGlobalCompetitors  = [];
let localFounders           = [];
let localBankStatements     = [];

let activeCommentTab    = "open";
let commentScopeAll     = false;
let allWorkspaceUsers   = [];
let localComments       = [];
let selectedCommentText = "";
let selectedFieldPath   = null;
let activeQuillRef      = null;
let currentLockedField  = null;
let lockHeartbeatTimer  = null;

const schemaKey = "fc";

const SaveManager = {
  pendingWrites: {},
  saveTimeout: null,
  queue(path, value) {
    if (!path) return;
    this.pendingWrites[path] = value;
    setNestedValue(currentFcData, path, value);
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => this.flush(), 800);
  },
  async flush() {
    if (!currentFcId || Object.keys(this.pendingWrites).length === 0) return;
    const payload = { updatedAt: serverTimestamp(), lastChangedBy: currentUserName };
    Object.entries(this.pendingWrites).forEach(([path, val]) => payload[path] = val);
    this.pendingWrites = {};
    try {
      await updateDoc(doc(db, "first-connect-reports", currentFcId), payload);
    } catch (err) {
      console.error("FC Save error:", err);
    }
  }
};

window.addEventListener("beforeunload", () => SaveManager.flush());

function esc(str) {
  return String(str ?? "").replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag));
}

function wireSchemaLink() {
  const link = document.getElementById("schema-btn");
  if (!link) return;
  const url = new URL(link.getAttribute("href") || "fc-settings.html", window.location.href);
  url.searchParams.set("schema", "fc");
  if (currentFcId) url.searchParams.set("fc", currentFcId);
  if (currentProjectId) url.searchParams.set("project", currentProjectId);
  link.href = url.pathname + url.search;
}

function setupSidebarToggle() {
  const btn = document.getElementById("sidebar-toggle");
  const sidebar = document.querySelector(".im-sidebar");
  if (!btn || !sidebar) return;
  btn.addEventListener("click", () => {
    sidebar.classList.toggle("collapsed");
  });
}

function persistData(path, data) {
  SaveManager.queue(path, data);
}

function findBlock(blockId) {
  for (const sec of fcSchema) {
    const blk = sec.blocks?.find(b => b.id === blockId);
    if (blk) return blk;
  }
  return null;
}

// ── EXIT BTN ──────────────────────────────────────────────
document.getElementById("exit-btn").addEventListener("click", () => {
  if (!currentProjectId) return;
  const projectName = new URLSearchParams(window.location.search).get("name");
  window.location.href = `module-hub.html?project=${currentProjectId}&name=${encodeURIComponent(projectName)}`;
});

// ── INIT ──────────────────────────────────────────────────
onAuthStateChanged(auth, user => {
  if (!user) { window.location.href = "login.html"; return; }
  currentUserId   = user.uid;
  currentUserName = user.displayName || user.email;
  registerWorkspaceUser();
  setupCommentsToggle();
  setupTextSelection();
  setupCommentBox();

  const urlParams  = new URLSearchParams(window.location.search);
  currentFcId      = urlParams.get("fc");
  currentProjectId = urlParams.get("project");
  sessionStorage.setItem("last-fc-url", window.location.href);
  wireSchemaLink();
  setupSidebarToggle();
  if (!currentFcId) { alert("No FC selected"); return; }
  loadFC();
});

// ── LOAD FC ───────────────────────────────────────────────
async function loadFC() {
  try {
    fcSchema = await loadSchema(currentFcId, schemaKey);
    buildNav();
    if (!currentSectionKey && fcSchema.length) {
      currentSectionKey = [...fcSchema].sort((a, b) => a.order - b.order)[0]?.key || null;
    }

    if (unsubscribeSchema) unsubscribeSchema();
    unsubscribeSchema = subscribeToSchema(currentFcId, (sections) => {
      fcSchema = sections || [];
      buildNav();
      if (!currentSectionKey || !fcSchema.find(s => s.key === currentSectionKey)) {
        currentSectionKey = [...fcSchema].sort((a, b) => a.order - b.order)[0]?.key || null;
      }
      if (isPreviewMode) renderPreview();
      else renderCurrentSection();
    }, schemaKey);

    const fcRef      = doc(db, "first-connect-reports", currentFcId);
    const presenceRef = doc(collection(db, "first-connect-reports", currentFcId, "presence"), currentUserId);
    await setDoc(presenceRef, {
      userId: currentUserId, userName: currentUserName,
      section: currentSectionKey || "overview", lastActive: serverTimestamp()
    });

    if (unsubscribeFc) unsubscribeFc();

    unsubscribeFc = onSnapshot(fcRef, snapshot => {
      if (!snapshot.exists()) { alert("FC not found"); return; }
      currentFcData = snapshot.data();
      document.getElementById("im-title").textContent = currentFcData.title || "Untitled FC";

      updateDoc(doc(db, "workspace-users", currentUserId), {
        currentIM: { id: currentFcId, title: currentFcData.title || "Untitled FC" },
        currentPage: "fc"
      });

      if (!isTyping) {
        renderCurrentSection();
      }
      listenToComments();
    });

    listenToPresence();
    listenToFieldLocks();
  } catch (err) {
    console.error("Error loading FC:", err);
  }
}

// ── PRESENCE ──────────────────────────────────────────────
function listenToPresence() {
  onSnapshot(collection(db, "first-connect-reports", currentFcId, "presence"), snapshot => {
    const now = Date.now(), STALE = 75000, users = [];
    snapshot.forEach(d => {
      const data = d.data();
      if (now - (data.lastActive?.toMillis?.() || 0) < STALE) users.push(data);
    });

    const list = document.getElementById("collab-list");
    if (!list) return;
    if (users.length === 0) {
      list.innerHTML = `<div class="collab-user" style="opacity:0.5;font-size:12px">Only you are here</div>`;
      return;
    }
    list.innerHTML = users.map(u => {
      const isMe          = u.userId === currentUserId;
      const isSameSection = u.section === currentSectionKey && !isMe;
      const fieldLabel    = (u.fieldPath && !isMe)
        ? u.fieldPath.split(".").pop().replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase())
        : "";
      return `<div class="collab-user ${isSameSection ? "editing-alert" : ""}">
        <span class="collab-dot ${isMe ? "dot-me" : "dot-other"}"></span>
        <span class="collab-name">${isMe ? "You" : u.userName}</span>
        ${isSameSection ? `<span class="collab-section same-section">Same section</span>` : `<span class="collab-section">${u.section}</span>`}
        ${fieldLabel && !isMe ? `<span class="collab-field">${fieldLabel}</span>` : ""}
      </div>`;
    }).join("");
    checkFieldLock(users);
    highlightActiveFields(users);
  });
}

// ── FIELD LOCK ENGINE ─────────────────────────────────────
async function acquireLock(fieldPath) {
  if (!fieldPath || !currentFcId || !currentUserId) return true;
  const lockRef = doc(db, "first-connect-reports", currentFcId, "fieldLocks", fieldPath.replace(/\./g, "_"));
  try {
    const snap = await getDoc(lockRef);
    if (snap.exists()) {
      const lock = snap.data();
      const age  = Date.now() - (lock.acquiredAt?.toMillis?.() || 0);
      if (age <= 60000 && lock.userId !== currentUserId) { showLockWarning(lock.userName, fieldPath); return false; }
    }
    await setDoc(lockRef, { userId: currentUserId, userName: currentUserName, fieldPath, acquiredAt: serverTimestamp() });
    currentLockedField = fieldPath;
    clearInterval(lockHeartbeatTimer);
    lockHeartbeatTimer = setInterval(async () => {
      if (currentLockedField) await setDoc(lockRef, { acquiredAt: serverTimestamp() }, { merge: true });
    }, 20000);
    hideLockWarning();
    return true;
  } catch { return true; }
}

async function releaseLock(fieldPath) {
  if (!fieldPath || !currentFcId) return;
  const lockRef = doc(db, "first-connect-reports", currentFcId, "fieldLocks", fieldPath.replace(/\./g, "_"));
  try {
    const snap = await getDoc(lockRef);
    if (snap.exists() && snap.data().userId === currentUserId) await deleteDoc(lockRef);
  } catch {}
  currentLockedField = null;
  clearInterval(lockHeartbeatTimer);
  hideLockWarning();
}

function showLockWarning(name) {
  let w = document.getElementById("field-lock-warning");
  if (!w) {
    w = document.createElement("div");
    w.id = "field-lock-warning"; w.className = "field-lock-banner";
    document.querySelector(".im-header")?.appendChild(w);
  }
  w.innerHTML = `<strong>${name}</strong> is currently editing this field`;
  w.style.display = "block";
}
function hideLockWarning() {
  const w = document.getElementById("field-lock-warning");
  if (w) w.style.display = "none";
}

function listenToFieldLocks() {
  if (!currentFcId) return;
  onSnapshot(collection(db, "first-connect-reports", currentFcId, "fieldLocks"), snapshot => {
    snapshot.docChanges().forEach(change => {
      if (change.type !== "removed") return;
      const fp = change.doc.data().fieldPath;
      if (!fp) return;
      const el   = document.querySelector(`[data-path="${fp}"]`);
      const qlEd = el?.querySelector?.(".ql-editor") || el?.closest?.(".quill-editor")?.querySelector(".ql-editor");
      if (qlEd?.getAttribute("data-locked") === "true") {
        const wrap = el?.closest?.(".quill-editor") || el;
        if (wrap?.__quill) { wrap.__quill.enable(); qlEd.removeAttribute("data-locked"); }
        hideLockWarning();
        showAvailableToast();
      }
    });
  });
}

function showAvailableToast() {
  document.getElementById("field-available-toast")?.remove();
  const t = document.createElement("div");
  t.id = "field-available-toast"; t.className = "field-available-toast";
  t.innerHTML = `✏️ <strong>Field is now available</strong> — click to edit`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

function checkFieldLock(users) {
  const active = getCurrentFocusedField();
  if (!active) return;
  const editor = users.find(u => u.fieldPath === active && u.userId !== currentUserId);
  let w = document.getElementById("field-lock-warning");
  if (editor) {
    if (!w) { w = document.createElement("div"); w.id = "field-lock-warning"; w.className = "section-lock-warning"; document.querySelector(".im-header")?.appendChild(w); }
    w.innerHTML = `${editor.userName} is editing this exact field`;
    w.style.display = "block";
  } else if (w) { w.style.display = "none"; }
}

function getCurrentFocusedField() {
  const a = document.activeElement;
  if (!a) return null;
  if (a.classList.contains("ql-editor")) return a.closest(".quill-editor")?.dataset.path || null;
  return a.dataset?.path || null;
}

function highlightActiveFields(users) {
  document.querySelectorAll(".field-user-highlight").forEach(el => {
    el.classList.remove("field-user-highlight");
    el.querySelector(".field-user-tag")?.remove();
  });
  users.forEach(u => {
    if (u.userId === currentUserId || !u.fieldPath) return;
    const field     = document.querySelector(`[data-path="${u.fieldPath}"]`);
    const container = field?.closest(".field-group") || field?.parentElement;
    if (!container) return;
    container.classList.add("field-user-highlight");
    if (!container.querySelector(".field-user-tag")) {
      const tag = document.createElement("span");
      tag.className = "field-user-tag"; tag.textContent = u.userName || "Someone";
      container.appendChild(tag);
    }
  });
}

// ── WORKSPACE USER ────────────────────────────────────────
async function registerWorkspaceUser() {
  const userRef = doc(db, "workspace-users", currentUserId);
  setDoc(userRef, {
    userId: currentUserId, email: currentUserName,
    isOnline: true, currentPage: "fc",
    currentIM: { id: currentFcId, title: "First Connect Report" },
    lastActive: serverTimestamp()
  }, { merge: true });
  setInterval(() => updateDoc(userRef, { lastActive: serverTimestamp() }), 30000);
  window.addEventListener("beforeunload", () => updateDoc(userRef, { isOnline: false, lastActive: serverTimestamp() }));
}

// ── AUTOSAVE (plain fields + selects) ────────────────────
function enableAutosave() {
  document.querySelectorAll(".editor-field").forEach(field => {
    autoGrowTextarea(field);
    const evtType = (field.tagName === "SELECT") ? "change" : "input";
    field.addEventListener("input", () => autoGrowTextarea(field));
    field.addEventListener(evtType, () => {
      clearTimeout(field._saveTimer);
      field._saveTimer = setTimeout(async () => {
        const path  = field.dataset.path;
        const value = (field.type === "checkbox" || field.type === "radio") ? field.checked : field.value;
        if (!currentFcId || !path) return;
        if (getNestedValue(currentFcData, path) === value) return;
        isTyping = true;
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => { isTyping = false; }, 1500);
        SaveManager.queue(path, value);
      }, 600);
    });
  });
}

function autoGrowTextarea(el) {
  if (el.tagName !== "TEXTAREA") return;
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

// ── QUILL INIT ────────────────────────────────────────────
function initQuillEditor(editorId, dataPath, initialContent) {
  const container = document.getElementById(editorId);
  if (!container) return null;

  const quill = new Quill(container, {
    theme: "snow",
    placeholder: container.dataset.placeholder || "",
    modules: {
      toolbar: [
        [{ header: [1,2,3,false] }],
        ["bold","italic","underline"],
        [{ list:"ordered" },{ list:"bullet" }],
        ["blockquote"],["link"],["clean"]
      ]
    }
  });

  quill.root.innerHTML = initialContent || "";
  container.closest(".quill-editor").__quill = quill;

  quill.on("selection-change", async range => {
    if (range) {
      activeQuillRef = quill;
      const gained = await acquireLock(dataPath);
      if (!gained) { quill.disable(); quill.root.setAttribute("data-locked","true"); return; }
      const presRef = doc(collection(db, "first-connect-reports", currentFcId, "presence"), currentUserId);
      await updateDoc(presRef, { fieldPath: dataPath, lastActive: serverTimestamp() });
    } else {
      activeQuillRef = null;
      setTimeout(async () => {
        await releaseLock(dataPath);
        const presRef = doc(collection(db, "first-connect-reports", currentFcId, "presence"), currentUserId);
        await updateDoc(presRef, { fieldPath: null, lastActive: serverTimestamp() });
      }, 300);
    }
  });

  quill.on("text-change", () => {
    clearTimeout(quill._saveTimer);
    quill._saveTimer = setTimeout(async () => {
      const html = quill.root.innerHTML;
      if (getNestedValue(currentFcData, dataPath) === html) return;
      isTyping = true;
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => { isTyping = false; }, 1500);
      SaveManager.queue(dataPath, html);
    }, 1000);
  });

  return quill;
}

// ── GUIDE BUTTONS ─────────────────────────────────────────
function attachAutoGuides() {
  document.querySelectorAll(".guide-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const box = btn.nextElementSibling;
      if (!box) return;
      box.classList.toggle("active");
      btn.textContent = box.classList.contains("active") ? "ⓘ Hide Guide" : "ⓘ Guide";
    });
  });
}

// ── THEME TOGGLE ──────────────────────────────────────────
document.getElementById("theme-toggle").addEventListener("change", e => {
  const mode = e.target.checked ? "light-mode" : "dark-mode";
  document.body.classList.remove("light-mode","dark-mode");
  document.body.classList.add(mode);
  localStorage.setItem("fc-theme", mode);
});

// sync checkbox state on load
(function syncThemeCheckbox() {
  const saved = localStorage.getItem("fc-theme") || "dark-mode";
  document.getElementById("theme-toggle").checked = (saved === "light-mode");
})();

// ── NAVIGATION (Schema-driven) ─────────────────────────────
function buildNav() {
  const nav = document.getElementById("im-nav");
  if (!nav) return;
  nav.innerHTML = "";

  const parents = [...fcSchema].filter(s => !s.parentId).sort((a, b) => a.order - b.order);
  parents.forEach(sec => {
    const children = [...fcSchema].filter(s => s.parentId === sec.id).sort((a, b) => a.order - b.order);
    if (children.length === 0) {
      const el = document.createElement("div");
      el.className = "nav-item";
      el.dataset.section = sec.key;
      el.innerHTML = `${esc(sec.navLabel || sec.heading || sec.key)}`;
      el.addEventListener("click", () => navigateTo(sec.key));
      nav.appendChild(el);
    } else {
      const wrapper = document.createElement("div");
      wrapper.className = "nav-group";
      const parentEl = document.createElement("div");
      parentEl.className = "nav-item nav-parent";
      parentEl.dataset.section = sec.key;
      parentEl.innerHTML = `<span class="nav-arrow" style="display:inline-block;margin-right:6px;transition:transform 0.2s;font-size:10px">▶</span>${esc(sec.navLabel || sec.heading || sec.key)}`;
      const childrenEl = document.createElement("div");
      childrenEl.className = "nav-children";
      childrenEl.style.display = "none";

      children.forEach(child => {
        const cel = document.createElement("div");
        cel.className = "nav-item sub-item";
        cel.dataset.section = child.key;
        cel.innerHTML = `${esc(child.navLabel || child.heading || child.key)}`;
        cel.addEventListener("click", (e) => { e.stopPropagation(); navigateTo(child.key); });
        childrenEl.appendChild(cel);
      });

      parentEl.addEventListener("click", () => {
        const isOpen = childrenEl.style.display !== "none";
        childrenEl.style.display = isOpen ? "none" : "block";
        parentEl.querySelector(".nav-arrow").style.transform = isOpen ? "rotate(0deg)" : "rotate(90deg)";
        navigateTo(sec.key);
      });

      wrapper.appendChild(parentEl);
      wrapper.appendChild(childrenEl);
      nav.appendChild(wrapper);
    }
  });

  const collabToggle = document.getElementById("collab-toggle");
  const collabList = document.getElementById("collab-list");
  if (collabToggle && collabList) {
    collabToggle.onclick = () => {
      const hidden = collabList.style.display === "none";
      collabList.style.display = hidden ? "block" : "none";
      const arrow = collabToggle.querySelector(".nav-arrow");
      if (arrow) arrow.style.transform = hidden ? "rotate(90deg)" : "rotate(0deg)";
    };
  }
}

async function navigateTo(key) {
  currentSectionKey = key;
  document.querySelectorAll("#im-nav .nav-item").forEach(el => {
    el.classList.toggle("active", el.dataset.section === key);
  });
  if (currentFcId && currentUserId) {
    const presRef = doc(collection(db, "first-connect-reports", currentFcId, "presence"), currentUserId);
    updateDoc(presRef, { section: currentSectionKey, lastActive: serverTimestamp() });
  }
  renderCurrentSection();
}

function renderCurrentSection() {
  if (isPreviewMode) { renderPreview(); return; }
  const canvas = document.getElementById("im-canvas");
  if (!canvas) return;

  if (!currentSectionKey && fcSchema.length) {
    currentSectionKey = [...fcSchema].sort((a, b) => a.order - b.order)[0]?.key || null;
  }

  const sectionSchema = fcSchema.find(s => s.key === currentSectionKey);
  if (!sectionSchema) {
    canvas.innerHTML = `<div class="im-empty-state">Section not found in schema.</div>`;
    return;
  }

  document.querySelectorAll("#im-nav .nav-item").forEach(el => {
    el.classList.toggle("active", el.dataset.section === currentSectionKey);
  });

  const quillTargets = renderSectionDOM(sectionSchema, canvas, currentFcData);
  quillTargets.forEach(({ editorId, dataPath, initialContent }) => initQuillEditor(editorId, dataPath, initialContent));
  enableAutosave();
  wireTableControls();
  attachAutoGuides();
}

// ── PREVIEW TOGGLE ────────────────────────────────────────
document.getElementById("preview-toggle").addEventListener("click", () => {
  isPreviewMode = !isPreviewMode;
  document.getElementById("preview-toggle").textContent = isPreviewMode ? "Edit" : "Preview";
  if (isPreviewMode) renderPreview();
  else renderCurrentSection();
});

function renderPreview() {
  const canvas = document.getElementById("im-canvas");
  if (!canvas) return;
  const sections = [...fcSchema].sort((a, b) => a.order - b.order);
  if (sections.length === 0) {
    canvas.innerHTML = `<div class="im-empty-state">No schema configured.</div>`;
    return;
  }

  const previewHtml = sections.map(sec => {
    const blocks = [...(sec.blocks || [])].sort((a, b) => a.order - b.order)
      .map(block => renderPreviewBlock(block))
      .join("");
    return `
      <div class="preview-wrapper">
        <h2 class="preview-section-title">${esc(sec.heading || sec.navLabel || sec.key || "Section")}</h2>
        ${blocks || '<div class="preview-narrative">No fields</div>'}
      </div>`;
  }).join("");

  canvas.innerHTML = previewHtml;
}

function renderPreviewBlock(block) {
  const value = getNestedValue(currentFcData, block.dataPath);
  let display = "";

  if (block.type === "checkbox") display = value ? "Yes" : "No";
  else if (block.type === "image" || block.type === "file") display = Array.isArray(value) ? `${value.length} item(s)` : (value ? "Attached" : "—");
  else if (Array.isArray(value)) display = value.join(", ");
  else display = value || "—";

  const label = block.label ? `<h3>${esc(block.label)}</h3>` : "";
  return `<div class="preview-narrative">${label}<div>${display}</div></div>`;
}

function wireTableControls() {
  document.querySelectorAll(".add-row-btn").forEach(btn => {
    if (btn._wired) return;
    btn._wired = true;
    btn.addEventListener("click", async () => {
      const dataPath = btn.dataset.path;
      let rows = getNestedValue(currentFcData, dataPath);
      if (!Array.isArray(rows)) rows = [];
      rows.push({});
      await persistData(dataPath, rows);
      renderCurrentSection();
    });
  });

  document.querySelectorAll(".remove-row-btn").forEach(btn => {
    if (btn._wired) return;
    btn._wired = true;
    btn.addEventListener("click", async () => {
      const dataPath = btn.dataset.path;
      const rowIdx = parseInt(btn.dataset.row, 10);
      let rows = getNestedValue(currentFcData, dataPath);
      if (!Array.isArray(rows)) rows = [];
      rows.splice(rowIdx, 1);
      await persistData(dataPath, rows);
      renderCurrentSection();
    });
  });

  document.querySelectorAll(".add-table-btn").forEach(btn => {
    if (btn._wired) return;
    btn._wired = true;
    btn.addEventListener("click", async () => {
      const dataPath = btn.dataset.path;
      const block = findBlock(btn.dataset.blockId);
      let tables = getNestedValue(currentFcData, dataPath);
      if (!Array.isArray(tables)) tables = [];
      tables.push({ rows: Array.from({ length: block?.baseRowCount || 1 }, () => ({})) });
      await persistData(dataPath, tables);
      renderCurrentSection();
    });
  });

  document.querySelectorAll(".remove-table-btn").forEach(btn => {
    if (btn._wired) return;
    btn._wired = true;
    btn.addEventListener("click", async () => {
      const dataPath = btn.dataset.path;
      const idx = parseInt(btn.dataset.index, 10);
      let tables = getNestedValue(currentFcData, dataPath);
      if (!Array.isArray(tables)) tables = [];
      tables.splice(idx, 1);
      await persistData(dataPath, tables);
      renderCurrentSection();
    });
  });
}

// ── EXPORT JSON ───────────────────────────────────────────
document.getElementById("export-json-btn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(currentFcData, null, 2)], { type: "application/json" });
  const a    = document.createElement("a");
  a.href     = URL.createObjectURL(blob);
  a.download = `${currentFcData.title || "fc"}.json`;
  a.click();
});

// ── COMMIT VERSION ────────────────────────────────────────
document.getElementById("commit-btn").addEventListener("click", async () => {
  const label = prompt("Version label (e.g. v1.0 Draft):");
  if (!label) return;
  await addDoc(collection(db, "first-connect-reports", currentFcId, "versions"), {
    label, data: currentFcData, createdAt: serverTimestamp(), createdBy: currentUserName
  });
  alert("Version committed!");
});

// ── VERSIONS ──────────────────────────────────────────────
document.getElementById("versions-btn").addEventListener("click", async () => {
  const modal = document.getElementById("versions-modal");
  const list  = document.getElementById("versions-list");
  modal.classList.remove("hidden");
  list.innerHTML = "Loading...";
  const snap = await getDocs(collection(db, "first-connect-reports", currentFcId, "versions"));
  if (snap.empty) { list.innerHTML = "No versions yet."; return; }
  list.innerHTML = "";
  [...snap.docs].reverse().forEach(d => {
    const v   = d.data();
    const div = document.createElement("div");
    div.className = "history-entry";
    div.innerHTML = `<strong>${v.label}</strong> <small>by ${v.createdBy} · ${v.createdAt?.toDate?.().toLocaleString?.() || ""}</small>`;
    list.appendChild(div);
  });
});

document.getElementById("close-versions").addEventListener("click", () => {
  document.getElementById("versions-modal").classList.add("hidden");
});

// ── EXPORT PDF ────────────────────────────────────────────
document.getElementById("export-pdf-btn").addEventListener("click", () => {
  const was = isPreviewMode;
  isPreviewMode = true;
  renderPreview();
  setTimeout(() => {
    window.print();
    if (!was) { isPreviewMode = false; renderCurrentSection(); }
  }, 300);
});

/*// ════════════════════════════════════════════════════════
// RENDER SECTION
// ════════════════════════════════════════════════════════
function renderSection(sectionKey, data) {
  const canvas = document.getElementById("im-canvas");
  const cd     = data.companyDetails || {};

  // ── SECTION 1: Company Details ──────────────────────────
  if (sectionKey === "companyDetails") {

    // helper: dropdown with optional custom input
    function dropdownWithCustom(path, options, currentVal) {
      const isCustom = currentVal && !options.includes(currentVal);
      return `
        <select class="editor-field cd-select" data-path="${path}" style="width:100%;margin-bottom:4px">
          <option value="">-- Select --</option>
          ${options.map(o => `<option value="${o}" ${currentVal === o ? "selected" : ""}>${o}</option>`).join("")}
          <option value="__custom__" ${isCustom ? "selected" : ""}>Custom...</option>
        </select>
        <input type="text" class="editor-field cd-custom-input" data-path="${path}"
          placeholder="Type custom value..."
          style="width:100%;display:${isCustom ? "block" : "none"}"
          value="${isCustom ? currentVal : ""}"/>`;
    }

    // helper: simple Yes/No dropdown
    function yesNoSelect(path, currentVal) {
      return `<select class="editor-field" data-path="${path}" style="width:100%">
        <option value="">-- Select --</option>
        <option value="Yes" ${currentVal === "Yes" ? "selected" : ""}>Yes</option>
        <option value="No"  ${currentVal === "No"  ? "selected" : ""}>No</option>
      </select>`;
    }

    const rows = [
      {
        sno: 1, label: "Company Brand",
        cell: `<textarea class="editor-field" data-path="companyDetails.companyBrand" rows="1">${cd.companyBrand || ""}</textarea>`
      },
      {
        sno: 2, label: "Registered Name of the Company",
        cell: `<textarea class="editor-field" data-path="companyDetails.registeredName" rows="1">${cd.registeredName || ""}</textarea>`
      },
      {
        sno: 3, label: "Nature of the Company",
        cell: dropdownWithCustom("companyDetails.nature", ["Pvt Ltd","LLP","Partnership","Proprietorship"], cd.nature)
      },
      {
        sno: 4, label: "Address",
        cell: `
          <div style="display:flex;flex-direction:column;gap:8px">
            <div>
              <label style="font-size:11px;font-weight:600;color:var(--text-muted)">Registered Address</label>
              <textarea class="editor-field" data-path="companyDetails.addressRegistered" rows="2" placeholder="Registered Address">${cd.addressRegistered || ""}</textarea>
            </div>
            <div>
              <label style="font-size:11px;font-weight:600;color:var(--text-muted)">Communication Address</label>
              <textarea class="editor-field" data-path="companyDetails.addressCommunication" rows="2" placeholder="Communication Address">${cd.addressCommunication || ""}</textarea>
            </div>
          </div>`
      },
      {
        sno: 5, label: "Email / Phone Number",
        cell: `<textarea class="editor-field" data-path="companyDetails.contact" rows="1">${cd.contact || ""}</textarea>`
      },
      {
        sno: 6, label: "Website",
        cell: `<textarea class="editor-field" data-path="companyDetails.website" rows="1">${cd.website || ""}</textarea>`
      },
      {
        sno: 7, label: "Name of the Promoters / Founders & Indicate which founder(s) hold the Community Certificate",
        cell: `<textarea class="editor-field" data-path="companyDetails.founders" rows="3" placeholder="List founders and indicate who holds Community Certificate">${cd.founders || ""}</textarea>`
      },
      {
        sno: 8, label: "Date of Incorporation",
        cell: `<input type="date" class="editor-field" data-path="companyDetails.incorporationDate" value="${cd.incorporationDate || ""}" style="width:100%"/>`
      },
      {
        sno: 9, label: "CIN No / LLPIN",
        cell: `<textarea class="editor-field" data-path="companyDetails.cin" rows="1">${cd.cin || ""}</textarea>`
      },
      {
        sno: 10, label: "Company Stage",
        cell: dropdownWithCustom("companyDetails.stage", ["Idea","Prototype","MVP","Revenue Stage"], cd.stage)
      },
      {
        sno: 11, label: "Business Model",
        cell: dropdownWithCustom("companyDetails.businessModel", ["B2B","B2C","B2G","B2B2C"], cd.businessModel)
      },
      {
        sno: 12, label: "Business Type",
        cell: dropdownWithCustom("companyDetails.businessType", ["Product","Service","Both"], cd.businessType)
      },
      {
        sno: 13, label: "Registered State",
        cell: `<textarea class="editor-field" data-path="companyDetails.state" rows="1">${cd.state || ""}</textarea>`
      },
      {
        sno: 14, label: "Registered Country",
        cell: `<textarea class="editor-field" data-path="companyDetails.country" rows="1">${cd.country || ""}</textarea>`
      },
      {
        sno: 15, label: "Patents and Certifications?",
        cell: yesNoSelect("companyDetails.patents", cd.patents)
      },
      {
        sno: 16, label: "Incubation?",
        cell: yesNoSelect("companyDetails.incubation", cd.incubation)
      },
      {
        sno: 17, label: "Revenue (last completed financial year in ₹)",
        cell: `<textarea class="editor-field" data-path="companyDetails.revenueLast" rows="2" placeholder="Mention the FY for the revenue given. Not Applicable for non-revenue making companies.">${cd.revenueLast || ""}</textarea>`
      },
      {
        sno: 18, label: "Revenue YTD (Current financial year in ₹)",
        cell: `<textarea class="editor-field" data-path="companyDetails.revenueYTD" rows="2" placeholder="Mention the FY for the revenue given. Not Applicable for non-revenue making companies.">${cd.revenueYTD || ""}</textarea>`
      },
      {
        sno: 19, label: "Registered with Startup India?",
        cell: `<textarea class="editor-field" data-path="companyDetails.startupIndia" rows="1" placeholder="Yes/No (DPIIT Number)">${cd.startupIndia || ""}</textarea>`
      },
      {
        sno: 20, label: "Domain",
        cell: `<textarea class="editor-field" data-path="companyDetails.domain" rows="1">${cd.domain || ""}</textarea>`
      },
      {
        sno: 21, label: "Proposed Fund Ask",
        cell: `<textarea class="editor-field" data-path="companyDetails.fundAsk" rows="1">${cd.fundAsk || ""}</textarea>`
      },
      {
        sno: 22, label: "Proposed Fund Utilization",
        cell: `<textarea class="editor-field" data-path="companyDetails.fundUtilization" rows="2">${cd.fundUtilization || ""}</textarea>`
      },
      {
        sno: 23, label: "Employees (as of last completed FY)",
        cell: `<textarea class="editor-field" data-path="companyDetails.employees" rows="2" placeholder="Mention the month and FY for the number of employees. Not Applicable for non-revenue making companies.">${cd.employees || ""}</textarea>`
      },
      {
        sno: 24, label: "Mode of Investment Required",
        cell: dropdownWithCustom("companyDetails.investmentMode", ["Debt","Equity","Grant"], cd.investmentMode)
      },
      {
        sno: 25, label: "Are there any current investors? If yes, how much was raised?",
        cell: `<textarea class="editor-field" data-path="companyDetails.currentInvestors" rows="2">${cd.currentInvestors || ""}</textarea>`
      },
    ];

    const rowsHtml = rows.map(r => `
      <tr>
        <td style="width:36px;text-align:center;font-weight:600;color:var(--text-muted)">${r.sno}</td>
        <td style="width:38%;font-weight:500;vertical-align:top;padding-top:10px">${r.label}</td>
        <td style="vertical-align:top;padding:6px 8px">${r.cell}</td>
      </tr>`).join("");

    canvas.innerHTML = `
      <div class="memo-section">
        <h2>1. Company Details</h2>
        <table class="im-table" style="width:100%;border-collapse:collapse">
          <thead>
            <tr>
              <th style="width:36px">#</th>
              <th>Section</th>
              <th>Particulars</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>`;

    enableAutosave();

    // Wire up custom dropdown toggle
    document.querySelectorAll(".cd-select").forEach(sel => {
      const customInput = sel.nextElementSibling;
      sel.addEventListener("change", () => {
        if (sel.value === "__custom__") {
          customInput.style.display = "block";
          customInput.focus();
        } else {
          customInput.style.display = "none";
          customInput.value = "";
        }
      });
    });

    document.querySelectorAll(".cd-custom-input").forEach(inp => {
      inp.addEventListener("input", () => {
        clearTimeout(inp._saveTimer);
        inp._saveTimer = setTimeout(async () => {
          const path  = inp.dataset.path;
          const value = inp.value.trim();
          if (!currentFcId || !path || !value) return;
          isTyping = true;
          clearTimeout(typingTimer);
          typingTimer = setTimeout(() => { isTyping = false; }, 1500);
          await updateDoc(doc(db, "first-connect-reports", currentFcId), { [path]: value, updatedAt: serverTimestamp() });
          setNestedValue(currentFcData, path, value);
        }, 600);
      });
    });
  }

  // ── SECTION 2: Cap Table ────────────────────────────────
  else if (sectionKey === "capTable") {
    localCapTable = data.capTable || [];
    renderCapTableSection(canvas);
  }

  // ── SECTION 3: Problem Statement ───────────────────────
  else if (sectionKey === "problemStatement") {
    canvas.innerHTML = `
      <div class="memo-section">
        <h2>3. Problem Statement</h2>
        <div class="field-group">
          <label>Problem in Brief</label>
          <div class="quill-editor" id="prob-brief-editor" data-path="problemStatement.brief"
            data-placeholder="Describe the core problem being solved in brief..."></div>
        </div>
        <div class="field-group" style="margin-top:24px">
          <label>Challenges in Addressing the Problem Thus Far</label>
          <div class="quill-editor" id="prob-challenges-editor" data-path="problemStatement.challenges"
            data-placeholder="Describe the challenges encountered so far..."></div>
        </div>
      </div>`;
    enableAutosave();
    initQuillEditor("prob-brief-editor",      "problemStatement.brief",      data.problemStatement?.brief);
    initQuillEditor("prob-challenges-editor", "problemStatement.challenges", data.problemStatement?.challenges);
    attachAutoGuides();
  }

  // ── SECTION 4: Solution Overview ───────────────────────
  else if (sectionKey === "solutionOverview") {
    canvas.innerHTML = `
      <div class="memo-section">
        <h2>4. Solution Overview</h2>
        <div class="field-group">
          <label>Background to How the Solution Came About</label>
          <div class="quill-editor" id="sol-background-editor" data-path="solutionOverview.background"
            data-placeholder="Explain the background and genesis of the solution..."></div>
        </div>
        <div class="field-group" style="margin-top:24px">
          <label>Solution</label>
          <div class="quill-editor" id="sol-main-editor" data-path="solutionOverview.solution"
            data-placeholder="Describe the solution in detail..."></div>
        </div>
      </div>`;
    enableAutosave();
    initQuillEditor("sol-background-editor", "solutionOverview.background", data.solutionOverview?.background);
    initQuillEditor("sol-main-editor",       "solutionOverview.solution",   data.solutionOverview?.solution);
    attachAutoGuides();
  }

  // ── SECTION 5: Current Stage ────────────────────────────
  else if (sectionKey === "currentStage") {
    canvas.innerHTML = `
      <div class="memo-section">
        <h2>5. Current Stage</h2>
        <div class="field-group">
          <label>Ø Prototyping Effort and Release / Market Presence</label>
          <div class="quill-editor" id="stage-proto-editor" data-path="currentStage.prototyping"
            data-placeholder="(Details of the product development progress, prototyping status etc)"></div>
        </div>
        <div class="field-group" style="margin-top:24px">
          <label>Ø Customer Testing / Customer Reach</label>
          <div class="quill-editor" id="stage-customer-editor" data-path="currentStage.customerTesting"
            data-placeholder="(Insights from early customer interactions, pilots, or feedback from testing the prototype)"></div>
        </div>
        <div class="field-group" style="margin-top:24px">
          <label>Ø Influencers and Customers</label>
          <div class="quill-editor" id="stage-influencers-editor" data-path="currentStage.influencers"
            data-placeholder="(Influencers and customers for the solution as envisaged by the founder)"></div>
        </div>
        <div class="field-group" style="margin-top:24px">
          <label>Ø Team Composition and Cost</label>
          <div class="quill-editor" id="stage-team-editor" data-path="currentStage.teamComposition"
            data-placeholder="(Current team size, roles, and associated costs)"></div>
        </div>
        <div class="field-group" style="margin-top:24px">
          <label>Ø Investment Raised (Internal and External)</label>
          <div class="quill-editor" id="stage-investment-editor" data-path="currentStage.investmentRaised"
            data-placeholder="(Breakdown of funding raised so far)"></div>
        </div>
      </div>`;
    enableAutosave();
    initQuillEditor("stage-proto-editor",       "currentStage.prototyping",      data.currentStage?.prototyping);
    initQuillEditor("stage-customer-editor",    "currentStage.customerTesting",  data.currentStage?.customerTesting);
    initQuillEditor("stage-influencers-editor", "currentStage.influencers",      data.currentStage?.influencers);
    initQuillEditor("stage-team-editor",        "currentStage.teamComposition",  data.currentStage?.teamComposition);
    initQuillEditor("stage-investment-editor",  "currentStage.investmentRaised", data.currentStage?.investmentRaised);
    attachAutoGuides();
  }

  // ── SECTION 6: Future Lines of Business ─────────────────
  else if (sectionKey === "futureLines") {
    canvas.innerHTML = `
      <div class="memo-section">
        <h2>6. Future Line of Business</h2>
        <div class="field-group">
          <div class="quill-editor" id="future-editor" data-path="futureLines"
            data-placeholder="Describe planned future lines of business..."></div>
        </div>
      </div>`;
    enableAutosave();
    initQuillEditor("future-editor", "futureLines", data.futureLines);
    attachAutoGuides();
  }

  // ── SECTION 7.1: Indian Market ──────────────────────────
  else if (sectionKey === "market-indian") {
    canvas.innerHTML = `
      <div class="memo-section">
        <h2>7.1 Indian Market</h2>
        <div class="field-group">
          <div class="quill-editor" id="market-indian-editor" data-path="marketOverview.indian"
            data-placeholder="Describe the Indian market landscape, size, trends and opportunities..."></div>
        </div>
      </div>`;
    enableAutosave();
    initQuillEditor("market-indian-editor", "marketOverview.indian", data.marketOverview?.indian);
    attachAutoGuides();
  }

  // ── SECTION 7.2: Global Market ──────────────────────────
  else if (sectionKey === "market-global") {
    canvas.innerHTML = `
      <div class="memo-section">
        <h2>7.2 Global Market</h2>
        <div class="field-group">
          <div class="quill-editor" id="market-global-editor" data-path="marketOverview.global"
            data-placeholder="Describe the global market landscape, size, trends and opportunities..."></div>
        </div>
      </div>`;
    enableAutosave();
    initQuillEditor("market-global-editor", "marketOverview.global", data.marketOverview?.global);
    attachAutoGuides();
  }

  // ── SECTION 8.1 & 8.2: Competition ──────────────────────
  else if (sectionKey === "competition-indian") {
    localIndianCompetitors = data.competition?.indian || [];
    renderCompetitionSection(canvas, "indian", "8.1 Indian Competitors");
  }
  else if (sectionKey === "competition-global") {
    localGlobalCompetitors = data.competition?.global || [];
    renderCompetitionSection(canvas, "global", "8.2 Global Competitors");
  }

  // ── SECTION 9: Ideal Customer Profile ───────────────────
  else if (sectionKey === "idealCustomer") {
    canvas.innerHTML = `
      <div class="memo-section">
        <h2>9. Ideal Customer Profile</h2>
        <div class="field-group">
          <div class="quill-editor" id="icp-editor" data-path="idealCustomer"
            data-placeholder="Points Explaining the Following&#10;1. Customer Base & Segmentation"></div>
        </div>
      </div>`;
    enableAutosave();
    initQuillEditor("icp-editor", "idealCustomer", data.idealCustomer);
    attachAutoGuides();
  }

  // ── SECTION 10: Business Model ───────────────────────────
  else if (sectionKey === "businessModel") {
    canvas.innerHTML = `
      <div class="memo-section">
        <h2>10. Business Model</h2>
        <div class="field-group">
          <div class="quill-editor" id="bm-editor" data-path="businessModel"
            data-placeholder="Points Explaining the Following&#10;1. Revenue stage companies – Revenue Streams&#10;2. For non-revenue stage companies – this will be NA"></div>
        </div>
      </div>`;
    enableAutosave();
    initQuillEditor("bm-editor", "businessModel", data.businessModel);
    attachAutoGuides();
  }

  // ── SECTION 11: Founders Background ─────────────────────
  else if (sectionKey === "foundersBackground") {
    localFounders = data.foundersBackground || [];
    renderFoundersSection(canvas);
  }

  // ── SECTION 12: SME Validation ───────────────────────────
  else if (sectionKey === "smeValidation") {
    renderSMESection(canvas, data);
  }

  // ── SECTION 13: Financial Insights ──────────────────────
  else if (sectionKey === "financialInsights") {
    renderFinancialInsightsSection(canvas, data);
  }

  // ── SECTION 14: Remarks ──────────────────────────────────
  else if (sectionKey === "remarks") {
    canvas.innerHTML = `
      <div class="memo-section">
        <h2>14. Remarks</h2>
        <div class="field-group">
          <label>1. Entrepreneur's Commitment to the Business</label>
          <div class="quill-editor" id="remarks-commitment-editor" data-path="remarks.commitment"
            data-placeholder="Describe the entrepreneur's commitment, drive and dedication..."></div>
        </div>
        <div class="field-group" style="margin-top:24px">
          <label>2. Possible Suggestions Include</label>
          <div class="quill-editor" id="remarks-suggestions-editor" data-path="remarks.suggestions"
            data-placeholder="List suggestions for the company/founders..."></div>
        </div>
        <div class="field-group" style="margin-top:24px">
          <label>3. Preliminary Observation Based on Current Information & Model</label>
          <div class="quill-editor" id="remarks-observation-editor" data-path="remarks.observation"
            data-placeholder="Share preliminary observations based on the information gathered..."></div>
        </div>
      </div>`;
    enableAutosave();
    initQuillEditor("remarks-commitment-editor",  "remarks.commitment",  data.remarks?.commitment);
    initQuillEditor("remarks-suggestions-editor", "remarks.suggestions", data.remarks?.suggestions);
    initQuillEditor("remarks-observation-editor", "remarks.observation", data.remarks?.observation);
    attachAutoGuides();
  }
}

// ── CAP TABLE ─────────────────────────────────────────────
function renderCapTableSection(canvas) {
  const rowsHtml = localCapTable.map((r, i) => `
    <tr>
      <td><input class="editor-field cap-field" data-index="${i}" data-field="name"        value="${r.name        || ""}"/></td>
      <td><input class="editor-field cap-field" data-index="${i}" data-field="designation" value="${r.designation || ""}"/></td>
      <td><input class="editor-field cap-field" data-index="${i}" data-field="shares"      value="${r.shares      || ""}"/></td>
      <td><input class="editor-field cap-field" data-index="${i}" data-field="percentage"  value="${r.percentage  || ""}"/></td>
      <td><input class="editor-field cap-field" data-index="${i}" data-field="amountPaid"  value="${r.amountPaid  || ""}"/></td>
      <td>${i > 0 ? `<button class="small-btn remove-cap-row" data-index="${i}">Remove</button>` : ""}</td>
    </tr>`).join("");

  canvas.innerHTML = `
    <div class="memo-section">
      <h2>2. Cap Table / Partnership Split</h2>
      <table class="im-table" style="width:100%;border-collapse:collapse">
        <thead>
          <tr><th>Name</th><th>Designation</th><th>No. of Shares</th><th>%</th><th>Amount Paid (₹)</th><th></th></tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <button class="small-btn" id="add-cap-row" style="margin-top:12px">+ Add Row</button>
    </div>`;

  document.getElementById("add-cap-row").addEventListener("click", async () => {
    localCapTable.push({ name:"", designation:"", shares:"", percentage:"", amountPaid:"" });
    await saveCapTable();
    renderCapTableSection(canvas);
  });

  document.querySelectorAll(".remove-cap-row").forEach(btn => {
    btn.addEventListener("click", async () => {
      localCapTable.splice(parseInt(btn.dataset.index), 1);
      await saveCapTable();
      renderCapTableSection(canvas);
    });
  });

  document.querySelectorAll(".cap-field").forEach(field => {
    field.addEventListener("input", () => {
      localCapTable[parseInt(field.dataset.index)][field.dataset.field] = field.value;
      clearTimeout(field._saveTimer);
      field._saveTimer = setTimeout(() => saveCapTable(), 1000);
    });
  });
}

async function saveCapTable() {
  await updateDoc(doc(db, "first-connect-reports", currentFcId), {
    capTable: localCapTable, updatedAt: serverTimestamp()
  });
}

// ── COMPETITION ───────────────────────────────────────────
function renderCompetitionSection(canvas, type, title) {
  const localArr  = type === "indian" ? localIndianCompetitors : localGlobalCompetitors;
  const guideText = `<<Following Points must be considered:
1. Competitor Profiling by service/product and by Similar technology
2. Identification of Direct Competitors
3. Comparison of Pricing Models with Competitors>>`;

  const blocksHtml = localArr.map((block, bi) => `
    <div class="comp-block" data-bi="${bi}" style="margin-bottom:28px;padding:16px;border:1px solid var(--border-subtle);border-radius:10px">
      <div class="field-group">
        <label>Company Name</label>
        <input class="editor-field comp-name-field" data-bi="${bi}" value="${block.companyName || ""}" placeholder="Enter competitor name"/>
      </div>
      <div class="field-group" style="margin-top:12px">
        <label>Insights</label>
        <div class="quill-editor" id="comp-${type}-${bi}-editor" data-bi="${bi}"
          data-placeholder="Analyse this competitor..."></div>
      </div>
      <button class="small-btn remove-comp-block" data-bi="${bi}" style="margin-top:8px">Remove Competitor</button>
    </div>`).join("");

  canvas.innerHTML = `
    <div class="memo-section">
      <h2>${title}</h2>
      <span class="guide-toggle">ⓘ Guide</span>
      <div class="guide-box"><pre style="white-space:pre-wrap;font-size:12px;font-family:inherit">${guideText}</pre></div>
      <div id="comp-blocks-${type}">${blocksHtml}</div>
      <button class="small-btn" id="add-comp-${type}" style="margin-top:12px">+ Add Competitor</button>
    </div>`;

  // ✅ Safe quill init — no bracket paths, saves whole array
  localArr.forEach((block, bi) => {
    const container = document.getElementById(`comp-${type}-${bi}-editor`);
    if (!container) return;
    const quill = new Quill(container, {
      theme: "snow",
      placeholder: "Analyse this competitor...",
      modules: { toolbar: [["bold","italic","underline"],[{ list:"ordered" },{ list:"bullet" }],["link"],["clean"]] }
    });
    quill.root.innerHTML = block.insights || "";
    container.closest(".quill-editor").__quill = quill;
    quill.on("text-change", () => {
      clearTimeout(quill._saveTimer);
      quill._saveTimer = setTimeout(() => {
        if (type === "indian") localIndianCompetitors[bi].insights = quill.root.innerHTML;
        else localGlobalCompetitors[bi].insights = quill.root.innerHTML;
        saveCompetitors(type);
      }, 1000);
    });
  });

  document.getElementById(`add-comp-${type}`).addEventListener("click", async () => {
    if (type === "indian") localIndianCompetitors.push({ companyName:"", insights:"" });
    else localGlobalCompetitors.push({ companyName:"", insights:"" });
    await saveCompetitors(type);
    renderCompetitionSection(canvas, type, title);
  });

  document.querySelectorAll(".remove-comp-block").forEach(btn => {
    btn.addEventListener("click", async () => {
      const bi = parseInt(btn.dataset.bi);
      if (type === "indian") localIndianCompetitors.splice(bi, 1);
      else localGlobalCompetitors.splice(bi, 1);
      await saveCompetitors(type);
      renderCompetitionSection(canvas, type, title);
    });
  });

  document.querySelectorAll(".comp-name-field").forEach(field => {
    field.addEventListener("input", () => {
      const bi = parseInt(field.dataset.bi);
      if (type === "indian") localIndianCompetitors[bi].companyName = field.value;
      else localGlobalCompetitors[bi].companyName = field.value;
      clearTimeout(field._saveTimer);
      field._saveTimer = setTimeout(() => saveCompetitors(type), 1000);
    });
  });

  attachAutoGuides();
}

async function saveCompetitors(type) {
  await updateDoc(doc(db, "first-connect-reports", currentFcId), {
    [`competition.${type}`]: type === "indian" ? localIndianCompetitors : localGlobalCompetitors,
    updatedAt: serverTimestamp()
  });
}

// ── FOUNDERS BACKGROUND ───────────────────────────────────
function renderFoundersSection(canvas) {
  const blocksHtml = localFounders.map((f, fi) => `
    <div class="founder-block" style="margin-bottom:28px;padding:16px;border:1px solid var(--border-subtle);border-radius:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <strong style="color:var(--accent)">Founder ${fi + 1}</strong>
        ${fi > 0 ? `<button class="small-btn remove-founder" data-fi="${fi}">Remove</button>` : ""}
      </div>
      <div class="field-group">
        <div class="quill-editor" id="founder-${fi}-editor"
          data-placeholder="Founder ${fi + 1} — Name, Role&#10;Education, Work experience, key achievements..."></div>
      </div>
    </div>`).join("");

  canvas.innerHTML = `
    <div class="memo-section">
      <h2>11. Founders Background / Team Strength</h2>
      <div id="founders-container">${blocksHtml}</div>
      <button class="small-btn" id="add-founder-btn" style="margin-top:12px">+ Add Founder</button>
    </div>`;

  localFounders.forEach((f, fi) => {
    const container = document.getElementById(`founder-${fi}-editor`);
    if (!container) return;
    const quill = new Quill(container, {
      theme: "snow",
      placeholder: container.dataset.placeholder || "",
      modules: { toolbar: [["bold","italic","underline"],[{ list:"ordered" },{ list:"bullet" }],["link"],["clean"]] }
    });
    quill.root.innerHTML = f.content || "";
    container.closest(".quill-editor").__quill = quill;

    quill.on("text-change", () => {
      // mark typing so snapshot does NOT re-render and destroy editors
      isTyping = true;
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => { isTyping = false; }, 2000);

      clearTimeout(quill._saveTimer);
      quill._saveTimer = setTimeout(() => {
        localFounders[fi].content = quill.root.innerHTML;
        saveFounders();
      }, 1000);
    });

    // stop typing guard when editor loses focus
    quill.on("selection-change", range => {
      if (!range) {
        clearTimeout(typingTimer);
        isTyping = false;
      }
    });
  });

  document.getElementById("add-founder-btn").addEventListener("click", async () => {
    localFounders.push({ content: "" });
    // do NOT save to Firestore here — just re-render locally
    // saving an empty founder would trigger snapshot → re-render → glitch
    renderFoundersSection(canvas);
    // save after render so new empty block is stable
    await saveFounders();
  });

  document.querySelectorAll(".remove-founder").forEach(btn => {
    btn.addEventListener("click", async () => {
      localFounders.splice(parseInt(btn.dataset.fi), 1);
      await saveFounders();
      renderFoundersSection(canvas);
    });
  });
}

async function saveFounders() {
  await updateDoc(doc(db, "first-connect-reports", currentFcId), {
    foundersBackground: localFounders, updatedAt: serverTimestamp()
  });
}

// ── SME VALIDATION ────────────────────────────────────────
function renderSMESection(canvas, data) {
  const sme   = data.smeValidation || {};
  const isYes = sme.applicable === "yes";

  canvas.innerHTML = `
    <div class="memo-section">
      <h2>12. SME Validation</h2>
      <div class="field-group">
        <label>SME Validation Available?</label>
        <select class="editor-field" id="sme-yn-select" style="width:auto">
          <option value="">-- Select --</option>
          <option value="yes" ${isYes ? "selected" : ""}>Yes</option>
          <option value="no"  ${sme.applicable === "no" ? "selected" : ""}>No</option>
        </select>
      </div>
      <div id="sme-fields" style="${isYes ? "" : "display:none"}">
        <div class="field-group" style="margin-top:24px">
          <label>12.1 Understanding of Domain</label>
          <div class="quill-editor" id="sme-domain-editor" data-path="smeValidation.domain"
            data-placeholder="Assess the founder's understanding of the domain..."></div>
        </div>
        <div class="field-group" style="margin-top:24px">
          <label>12.2 Tech Capability</label>
          <div class="quill-editor" id="sme-tech-editor" data-path="smeValidation.tech"
            data-placeholder="Evaluate the technical capability of the team..."></div>
        </div>
        <div class="field-group" style="margin-top:24px">
          <label>12.3 Intellectual Property Value</label>
          <div class="quill-editor" id="sme-ip-editor" data-path="smeValidation.ip"
            data-placeholder="Describe any IP, patents or proprietary technology..."></div>
        </div>
        <div class="field-group" style="margin-top:24px">
          <label>12.4 Commercial Viability</label>
          <div class="quill-editor" id="sme-commercial-editor" data-path="smeValidation.commercial"
            data-placeholder="Assess the commercial viability of the business..."></div>
        </div>
      </div>
      <div id="sme-na" style="${sme.applicable === "no" ? "" : "display:none"};color:var(--text-muted);font-size:13px;margin-top:12px">NA</div>
    </div>`;

  if (isYes) {
    initQuillEditor("sme-domain-editor",     "smeValidation.domain",     sme.domain);
    initQuillEditor("sme-tech-editor",       "smeValidation.tech",       sme.tech);
    initQuillEditor("sme-ip-editor",         "smeValidation.ip",         sme.ip);
    initQuillEditor("sme-commercial-editor", "smeValidation.commercial", sme.commercial);
  }

  document.getElementById("sme-yn-select").addEventListener("change", async e => {
    const val = e.target.value;
    await updateDoc(doc(db, "first-connect-reports", currentFcId), {
      "smeValidation.applicable": val, updatedAt: serverTimestamp()
    });
    setNestedValue(currentFcData, "smeValidation.applicable", val);
    renderSMESection(canvas, currentFcData);
  });
}

// ── FINANCIAL INSIGHTS ────────────────────────────────────
function renderFinancialInsightsSection(canvas, data) {
  const fi    = data.financialInsights || {};
  const isYes = fi.applicable === "yes";
  localBankStatements = fi.bankStatements || [{ label: "", content: "" }];

  const bankBlocksHtml = localBankStatements.map((b, bi) => `
    <div class="bank-block" data-bi="${bi}" style="margin-bottom:20px;padding:12px;border:1px solid var(--border-subtle);border-radius:8px">
      <div class="field-group">
        <label style="font-size:12px">
          <input class="inline-year bank-label-field" data-bi="${bi}"
            value="${b.label || ""}" placeholder="______" style="width:200px"/>
          bank accounts were identified and reviewed as part of the financial analysis:
        </label>
      </div>
      <div class="field-group" style="margin-top:8px">
        <div class="quill-editor" id="bank-${bi}-editor" data-bi="${bi}"
          data-placeholder="Insights from this bank statement..."></div>
      </div>
      ${bi > 0 ? `<button class="small-btn remove-bank-block" data-bi="${bi}" style="margin-top:6px">Remove</button>` : ""}
    </div>`).join("");

  canvas.innerHTML = `
    <div class="memo-section">
      <h2>13. Insights from Financial Statements</h2>
      <div class="field-group">
        <label>Financial Statements Available?</label>
        <select class="editor-field" id="fi-yn-select" style="width:auto">
          <option value="">-- Select --</option>
          <option value="yes" ${isYes ? "selected" : ""}>Yes</option>
          <option value="no"  ${fi.applicable === "no" ? "selected" : ""}>No</option>
        </select>
      </div>
      <div id="fi-na" style="${fi.applicable === "no" ? "" : "display:none"};color:var(--text-muted);font-size:13px;margin-top:12px">
        Not Applicable for companies that are not making revenue.
      </div>
      <div id="fi-fields" style="${isYes ? "" : "display:none"}">
        <div class="field-group" style="margin-top:28px">
          <h3 style="font-size:14px;font-weight:700;color:var(--accent);margin-bottom:8px">Insights from Profit and Loss Statement</h3>
          <p style="font-size:13px;margin-bottom:10px">
            Audited financials have been provided for FY
            <input class="inline-year editor-field" data-path="financialInsights.plFY1" value="${fi.plFY1 || ""}" placeholder="______" style="width:80px"/>
            and FY
            <input class="inline-year editor-field" data-path="financialInsights.plFY2" value="${fi.plFY2 || ""}" placeholder="______" style="width:80px"/>;
            provisional statements are available for FY
            <input class="inline-year editor-field" data-path="financialInsights.plFYProvisional" value="${fi.plFYProvisional || ""}" placeholder="______" style="width:80px"/>.
          </p>
          <div class="quill-editor" id="fi-pl-editor" data-path="financialInsights.pl"
            data-placeholder="Insights from the Profit & Loss statement..."></div>
        </div>
        <div class="field-group" style="margin-top:28px">
          <h3 style="font-size:14px;font-weight:700;color:var(--accent);margin-bottom:8px">Insights from Balance Sheet</h3>
          <p style="font-size:13px;margin-bottom:10px">
            Balance sheets for FY
            <input class="inline-year editor-field" data-path="financialInsights.bsFYFrom" value="${fi.bsFYFrom || ""}" placeholder="______" style="width:80px"/>
            to FY
            <input class="inline-year editor-field" data-path="financialInsights.bsFYTo" value="${fi.bsFYTo || ""}" placeholder="______" style="width:80px"/>
            were reviewed in detail.
          </p>
          <div class="quill-editor" id="fi-bs-editor" data-path="financialInsights.bs"
            data-placeholder="Insights from the Balance Sheet..."></div>
        </div>
        <div class="field-group" style="margin-top:28px">
          <h3 style="font-size:14px;font-weight:700;color:var(--accent);margin-bottom:8px">Insights from Bank Statement</h3>
          <div id="bank-blocks-container">${bankBlocksHtml}</div>
          <button class="small-btn" id="add-bank-block-btn" style="margin-top:10px">+ Add Bank Statement</button>
        </div>
      </div>
    </div>`;

  if (isYes) {
    initQuillEditor("fi-pl-editor", "financialInsights.pl", fi.pl);
    initQuillEditor("fi-bs-editor", "financialInsights.bs", fi.bs);

    // ✅ Safe bank quill init — no bracket paths
    localBankStatements.forEach((b, bi) => {
      const container = document.getElementById(`bank-${bi}-editor`);
      if (!container) return;
      const quill = new Quill(container, {
        theme: "snow",
        placeholder: "Insights from this bank statement...",
        modules: { toolbar: [["bold","italic","underline"],[{ list:"ordered" },{ list:"bullet" }],["link"],["clean"]] }
      });
      quill.root.innerHTML = b.content || "";
      container.closest(".quill-editor").__quill = quill;
      quill.on("text-change", () => {
        clearTimeout(quill._saveTimer);
        quill._saveTimer = setTimeout(() => {
          localBankStatements[bi].content = quill.root.innerHTML;
          saveBankStatements();
        }, 1000);
      });
    });
  }

  enableAutosave();

  document.querySelectorAll(".bank-label-field").forEach(field => {
    field.addEventListener("input", () => {
      localBankStatements[parseInt(field.dataset.bi)].label = field.value;
      clearTimeout(field._saveTimer);
      field._saveTimer = setTimeout(() => saveBankStatements(), 1000);
    });
  });

  document.getElementById("add-bank-block-btn")?.addEventListener("click", async () => {
    localBankStatements.push({ label: "", content: "" });
    await saveBankStatements();
    renderFinancialInsightsSection(canvas, currentFcData);
  });

  document.querySelectorAll(".remove-bank-block").forEach(btn => {
    btn.addEventListener("click", async () => {
      localBankStatements.splice(parseInt(btn.dataset.bi), 1);
      await saveBankStatements();
      renderFinancialInsightsSection(canvas, currentFcData);
    });
  });

  document.getElementById("fi-yn-select").addEventListener("change", async e => {
    const val = e.target.value;
    await updateDoc(doc(db, "first-connect-reports", currentFcId), {
      "financialInsights.applicable": val, updatedAt: serverTimestamp()
    });
    setNestedValue(currentFcData, "financialInsights.applicable", val);
    renderFinancialInsightsSection(canvas, currentFcData);
  });
}

async function saveBankStatements() {
  await updateDoc(doc(db, "first-connect-reports", currentFcId), {
    "financialInsights.bankStatements": localBankStatements, updatedAt: serverTimestamp()
  });
}

// ════════════════════════════════════════════════════════
// PREVIEW
// ════════════════════════════════════════════════════════
function renderPreview() {
  const canvas = document.getElementById("im-canvas");
  const d      = currentFcData;
  const cd     = d.companyDetails || {};

  const companyRows = [
    ["Company Brand", cd.companyBrand],
    ["Registered Name", cd.registeredName],
    ["Nature", cd.nature],
    ["Registered Address", cd.addressRegistered],
    ["Communication Address", cd.addressCommunication],
    ["Email/Phone", cd.contact],
    ["Website", cd.website],
    ["Founders & Community Cert", cd.founders],
    ["Date of Incorporation", cd.incorporationDate],
    ["CIN/LLPIN", cd.cin],
    ["Company Stage", cd.stage],
    ["Business Model", cd.businessModel],
    ["Business Type", cd.businessType],
    ["Registered State", cd.state],
    ["Registered Country", cd.country],
    ["Patents & Certifications", cd.patents],
    ["Incubation", cd.incubation],
    ["Revenue (Last FY)", cd.revenueLast],
    ["Revenue YTD", cd.revenueYTD],
    ["Startup India", cd.startupIndia],
    ["Domain", cd.domain],
    ["Proposed Fund Ask", cd.fundAsk],
    ["Proposed Fund Utilization", cd.fundUtilization],
    ["Employees", cd.employees],
    ["Mode of Investment", cd.investmentMode],
    ["Current Investors", cd.currentInvestors],
  ].map((r, i) => `<tr><td style="width:36px;text-align:center">${i+1}</td><td>${r[0]}</td><td>${r[1] || "—"}</td></tr>`).join("");

  const capRows = (d.capTable || []).map(r =>
    `<tr><td>${r.name||"—"}</td><td>${r.designation||"—"}</td><td>${r.shares||"—"}</td><td>${r.percentage||"—"}%</td><td>₹${r.amountPaid||"—"}</td></tr>`
  ).join("") || `<tr><td colspan="5">—</td></tr>`;

  const renderComp = arr => (arr || []).map(c =>
    `<div style="margin-bottom:16px"><strong>${c.companyName || "Unnamed"}</strong><div>${c.insights || ""}</div></div>`
  ).join("") || "—";

  const renderFoundersPrev = arr => (arr || []).map((f, i) =>
    `<div style="margin-bottom:16px"><strong>Founder ${i+1}</strong><div>${f.content || ""}</div></div>`
  ).join("") || "—";

  const fi      = d.financialInsights || {};
  const bankHtml = (fi.bankStatements || []).map(b =>
    `<div style="margin-bottom:12px"><em>${b.label || "______"} bank accounts were identified and reviewed:</em><div>${b.content || ""}</div></div>`
  ).join("") || "—";

  canvas.innerHTML = `
    <div class="preview-wrapper">
      <h2 class="preview-title">${d.title || "First Connect Report"}</h2>
      <p style="font-size:12px;color:#6b7280;margin-bottom:32px">First Connect Report</p>

      <div class="preview-section-title">1. Company Details</div>
      <table class="memo-table" style="width:100%;border-collapse:collapse">
        <thead><tr><th>#</th><th>Section</th><th>Particulars</th></tr></thead>
        <tbody>${companyRows}</tbody>
      </table>

      <div class="preview-section-title">2. Cap Table / Partnership Split</div>
      <table class="memo-table" style="width:100%;border-collapse:collapse">
        <thead><tr><th>Name</th><th>Designation</th><th>Shares</th><th>%</th><th>Amount Paid</th></tr></thead>
        <tbody>${capRows}</tbody>
      </table>

      <div class="preview-section-title">3. Problem Statement</div>
      <div class="preview-narrative"><h3>Problem in Brief</h3><div>${d.problemStatement?.brief || "—"}</div></div>
      <div class="preview-narrative"><h3>Challenges Thus Far</h3><div>${d.problemStatement?.challenges || "—"}</div></div>

      <div class="preview-section-title">4. Solution Overview</div>
      <div class="preview-narrative"><h3>Background</h3><div>${d.solutionOverview?.background || "—"}</div></div>
      <div class="preview-narrative"><h3>Solution</h3><div>${d.solutionOverview?.solution || "—"}</div></div>

      <div class="preview-section-title">5. Current Stage</div>
      <div class="preview-narrative"><h3>Ø Prototyping Effort</h3><div>${d.currentStage?.prototyping || "—"}</div></div>
      <div class="preview-narrative"><h3>Ø Customer Testing</h3><div>${d.currentStage?.customerTesting || "—"}</div></div>
      <div class="preview-narrative"><h3>Ø Influencers and Customers</h3><div>${d.currentStage?.influencers || "—"}</div></div>
      <div class="preview-narrative"><h3>Ø Team Composition and Cost</h3><div>${d.currentStage?.teamComposition || "—"}</div></div>
      <div class="preview-narrative"><h3>Ø Investment Raised</h3><div>${d.currentStage?.investmentRaised || "—"}</div></div>

      <div class="preview-section-title">6. Future Line of Business</div>
      <div>${d.futureLines || "—"}</div>

      <div class="preview-section-title">7.1 Indian Market</div>
      <div>${d.marketOverview?.indian || "—"}</div>

      <div class="preview-section-title">7.2 Global Market</div>
      <div>${d.marketOverview?.global || "—"}</div>

      <div class="preview-section-title">8.1 Indian Competitors</div>
      ${renderComp(d.competition?.indian)}

      <div class="preview-section-title">8.2 Global Competitors</div>
      ${renderComp(d.competition?.global)}

      <div class="preview-section-title">9. Ideal Customer Profile</div>
      <div>${d.idealCustomer || "—"}</div>

      <div class="preview-section-title">10. Business Model</div>
      <div>${d.businessModel || "—"}</div>

      <div class="preview-section-title">11. Founders Background / Team Strength</div>
      ${renderFoundersPrev(d.foundersBackground)}

      <div class="preview-section-title">12. SME Validation</div>
      ${d.smeValidation?.applicable === "no" ? "<p>NA</p>" : `
        <div class="preview-narrative"><h3>12.1 Understanding of Domain</h3><div>${d.smeValidation?.domain || "—"}</div></div>
        <div class="preview-narrative"><h3>12.2 Tech Capability</h3><div>${d.smeValidation?.tech || "—"}</div></div>
        <div class="preview-narrative"><h3>12.3 Intellectual Property Value</h3><div>${d.smeValidation?.ip || "—"}</div></div>
        <div class="preview-narrative"><h3>12.4 Commercial Viability</h3><div>${d.smeValidation?.commercial || "—"}</div></div>
      `}

      <div class="preview-section-title">13. Insights from Financial Statements</div>
      ${fi.applicable === "no" ? "<p>Not Applicable for companies that are not making revenue.</p>" : `
        <div class="preview-narrative">
          <h3>Insights from Profit and Loss Statement</h3>
          <p style="font-size:13px;margin-bottom:8px">Audited financials for FY ${fi.plFY1 || "______"} and FY ${fi.plFY2 || "______"}; provisional for FY ${fi.plFYProvisional || "______"}.</p>
          <div>${fi.pl || "—"}</div>
        </div>
        <div class="preview-narrative">
          <h3>Insights from Balance Sheet</h3>
          <p style="font-size:13px;margin-bottom:8px">Balance sheets for FY ${fi.bsFYFrom || "______"} to FY ${fi.bsFYTo || "______"} reviewed.</p>
          <div>${fi.bs || "—"}</div>
        </div>
        <div class="preview-narrative">
          <h3>Insights from Bank Statement</h3>
          ${bankHtml}
        </div>
      `}

      <div class="preview-section-title">14. Remarks</div>
      <div class="preview-narrative"><h3>1. Entrepreneur's Commitment</h3><div>${d.remarks?.commitment || "—"}</div></div>
      <div class="preview-narrative"><h3>2. Possible Suggestions</h3><div>${d.remarks?.suggestions || "—"}</div></div>
      <div class="preview-narrative"><h3>3. Preliminary Observation</h3><div>${d.remarks?.observation || "—"}</div></div>
    </div>`;
}

*/
// ════════════════════════════════════════════════════════
// COMMENTS
// ════════════════════════════════════════════════════════





function buildCommentEl(c) {
  const repliesHtml = (c.replies || []).map(r => `
    <div style="padding:6px 8px;background:rgba(0,0,0,0.04);border-radius:6px;margin-top:4px;font-size:11px">
      <strong>${r.author}</strong> ${r.text}
    </div>`).join("");

  return `
    <div class="comment-item" data-id="${c.id}" data-section="${c.section || ''}"
      style="padding:10px;margin-bottom:10px;border:1px solid var(--border-subtle);
        border-radius:8px;font-size:12px;cursor:pointer;transition:background 0.15s"
      onmouseenter="this.style.background='var(--bg-input)'"
      onmouseleave="this.style.background=''">

      <div style="font-weight:600;margin-bottom:4px">${c.authorName || c.author || "Unknown"}</div>

      ${c.selectedText
        ? `<div style="background:rgba(255,210,0,0.2);padding:4px 6px;border-radius:4px;
            margin-bottom:6px;font-size:11px;font-style:italic">"${c.selectedText}"</div>`
        : ""}

      <div style="margin-bottom:8px">${c.text || c.comment}</div>

      ${repliesHtml}

      <!-- Row 1: reply -->
      <div style="margin-top:8px;display:flex;gap:4px;align-items:center" onclick="event.stopPropagation()">
        <input type="text" placeholder="Reply..."
          style="flex:1;font-size:11px;padding:4px 8px;border-radius:6px;
            border:1px solid var(--border-subtle);background:var(--bg-input);
            color:var(--text-main);min-width:0">
        <button class="small-btn reply-submit-btn" data-id="${c.id}"
          style="padding:4px 8px;font-size:11px;flex-shrink:0">Reply</button>
      </div>

      <!-- Row 2: resolve / delete -->
      <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:6px" onclick="event.stopPropagation()">
        ${c.status !== "resolved"
          ? `<button class="small-btn resolve-comment-btn" data-id="${c.id}"
              style="font-size:10px;color:#22c55e;border-color:rgba(34,197,94,0.4)">✓ Resolve</button>`
          : ""}
        <button class="small-btn delete-comment-btn" data-id="${c.id}"
          style="font-size:10px;color:#ef4444;border-color:rgba(239,68,68,0.4)">🗑 Delete</button>
      </div>
    </div>`;
}


// ── COMMENTS TOGGLE ───────────────────────────────────────


// ── TEXT SELECTION → FLOAT BTN ────────────────────────────
function setupTextSelection() {
  document.addEventListener("mouseup", () => {
    const selection = window.getSelection();
    const btn = document.getElementById("comment-float-btn");
    if (!btn) return;

    if (!selection || selection.rangeCount === 0) { btn.style.display = "none"; return; }
    const text = selection.toString().trim();
    if (text.length < 3) { btn.style.display = "none"; return; }

    selectedCommentText = text;

    const activeEl = document.activeElement;
    if (activeEl?.classList?.contains("ql-editor")) {
      selectedFieldPath = activeEl.closest(".quill-editor")?.dataset?.path || "section";
    } else if (activeEl?.dataset?.path) {
      selectedFieldPath = activeEl.dataset.path;
    } else {
      selectedFieldPath = "section";
    }

    const rect = selection.getRangeAt(0).getBoundingClientRect();
    btn.style.left    = rect.left + "px";
    btn.style.top     = (rect.top - 40) + "px";
    btn.style.display = "block";
  });
}

// ── COMMENT BOX SETUP ─────────────────────────────────────
function setupCommentBox() {
  const floatBtn  = document.getElementById("comment-float-btn");
  const box       = document.getElementById("comment-box");
  const cancelBtn = document.getElementById("comment-cancel-btn");
  const sendBtn   = document.getElementById("comment-send-btn");
  if (!floatBtn || !box || !cancelBtn || !sendBtn) return;

  floatBtn.addEventListener("click", () => {
    box.style.left    = floatBtn.style.left;
    box.style.top     = (parseInt(floatBtn.style.top) + 40) + "px";
    box.style.display = "block";
    floatBtn.style.display = "none";
    loadUsersForAssignment();
  });

  cancelBtn.addEventListener("click", () => {
    box.style.display = "none";
    selectedCommentText = "";
  });

  sendBtn.addEventListener("click", saveComment);
}

// ── LOAD USERS FOR ASSIGN LIST ────────────────────────────
async function loadUsersForAssignment() {
  const assignList = document.getElementById("assign-users-list");
  if (!assignList) return;
  try {
    const snap = await getDocs(collection(db, "workspace-users"));
    allWorkspaceUsers = snap.docs.map(d => d.data());
    if (!allWorkspaceUsers.length) {
      assignList.innerHTML = `<div style="font-size:12px;opacity:0.4">No users found</div>`;
      return;
    }
    assignList.innerHTML = allWorkspaceUsers.map(u => `
      <label class="assign-user-check-label" style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
        <input type="checkbox" class="assign-user-check" value="${u.userId}" data-email="${u.email || u.userName || ""}">
        ${u.email || u.userName || u.userId}
      </label>`).join("");
  } catch (err) {
    console.error("loadUsersForAssignment error", err);
  }
}

// ── SAVE COMMENT ──────────────────────────────────────────
async function saveComment() {
  const input = document.getElementById("comment-input");
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  const checked = [...document.querySelectorAll(".assign-user-check:checked")];
  const assignedUsers = checked.map(cb => ({ uid: cb.value, email: cb.dataset.email }));

  try {
    await addDoc(collection(db, "first-connect-reports", currentFcId, "comments"), {
      comment:       text,
      selectedText:  selectedCommentText || "",
      fieldPath:     selectedFieldPath   || "section",
      section:       currentSectionKey,
      authorId:      currentUserId,
      authorName:    currentUserName,
      assignedUsers: assignedUsers,
      status:        "open",
      replies:       [],
      createdAt:     serverTimestamp()
    });

    input.value            = "";
    selectedCommentText    = "";
    selectedFieldPath      = "section";
    document.getElementById("comment-box").style.display = "none";
  } catch (err) {
    console.error("saveComment error", err);
    alert("Failed to save comment: " + err.message);
  }
}

// ── LISTEN TO COMMENTS ────────────────────────────────────
function listenToComments() {
  if (unsubscribeComments) return;
  unsubscribeComments = onSnapshot(collection(db, "first-connect-reports", currentFcId, "comments"), snap => {
    localComments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderCommentsList(document.getElementById("comments-list"));
  });
}

function renderCommentsList(panel) {
  if (!panel) return;

  const filtered = commentScopeAll
    ? localComments
    : localComments.filter(c => c.fieldPath === selectedFieldPath || !selectedFieldPath);

  const open   = filtered.filter(c => c.status !== "resolved");
  const closed = filtered.filter(c => c.status === "resolved");
  const list   = activeCommentTab === "open" ? open : closed;

  panel.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:12px;padding:0 4px">
      <button class="small-btn ${activeCommentTab==="open"?"active-tab":""}" id="tab-open">Open ${open.length}</button>
      <button class="small-btn ${activeCommentTab==="resolved"?"active-tab":""}" id="tab-resolved">Resolved ${closed.length}</button>
      <button class="small-btn" id="scope-toggle" style="margin-left:auto;font-size:10px">${commentScopeAll ? "This Field" : "All Comments"}</button>
    </div>
    ${list.length === 0
      ? `<div style="opacity:0.5;font-size:12px;padding:8px">No comments</div>`
      : list.map(c => buildCommentEl(c)).join("")}`;

  document.getElementById("tab-open").addEventListener("click", () => { activeCommentTab = "open";  renderCommentsList(panel); });
  document.getElementById("tab-resolved").addEventListener("click", () => { activeCommentTab = "resolved"; renderCommentsList(panel); });
  document.getElementById("scope-toggle").addEventListener("click", () => { commentScopeAll = !commentScopeAll; renderCommentsList(panel); });

  panel.querySelectorAll(".resolve-comment-btn").forEach(btn =>
    btn.addEventListener("click", async () => {
      await updateDoc(doc(db, "first-connect-reports", currentFcId, "comments", btn.dataset.id), { status: "resolved" });
    }));

  panel.querySelectorAll(".delete-comment-btn").forEach(btn =>
    btn.addEventListener("click", async () => {
      if (!confirm("Delete comment?")) return;
      await deleteDoc(doc(db, "first-connect-reports", currentFcId, "comments", btn.dataset.id));
    }));

  panel.querySelectorAll(".reply-submit-btn").forEach(btn =>
    btn.addEventListener("click", async () => {
      const input = btn.previousElementSibling;
      const text = input.value.trim();
      if (!text) return;
      const comment = localComments.find(c => c.id === btn.dataset.id);
      if (!comment) return;
      const replies = comment.replies || [];
      replies.push({ text, author: currentUserName, createdAt: new Date().toISOString() });
      await updateDoc(doc(db, "first-connect-reports", currentFcId, "comments", btn.dataset.id), { replies });
      input.value = "";
    }));

  // ── Wire up navigate-to-field on card click ──────────────────────────────
  panel.querySelectorAll(".comment-item").forEach(card =>
    card.addEventListener("click", (e) => {
      if (e.target.closest("button") || e.target.tagName === "INPUT") return;
      window.navigateToComment(e, card.dataset.id, card.dataset.section);
    }));

  // ── Draw highlights + threads after render ────────────────────────────────
  setTimeout(highlightCommentedText, 80);
}


// ── RENDER COMMENTS ───────────────────────────────────────
function renderComments() {
  const list = document.getElementById("comments-list");
  if (!list) return;

  const pool         = commentScopeAll ? localComments : localComments.filter(c => c.section === currentSectionKey);
  const openComments = pool.filter(c => c.status !== "resolved");
  const closedComments = pool.filter(c => c.status === "resolved");
  const filtered     = activeCommentTab === "open" ? openComments : closedComments;

  const scopeBar = `
    <div style="display:flex;gap:6px;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--border-subtle)">
      <button onclick="window.setCommentScope(false)" style="flex:1;padding:5px;border-radius:6px;border:1px solid var(--border-subtle);cursor:pointer;font-size:11px;font-weight:600;
        background:${!commentScopeAll ? "var(--accent)" : "transparent"};color:${!commentScopeAll ? "#fff" : "var(--text-muted)"}">This Section</button>
      <button onclick="window.setCommentScope(true)" style="flex:1;padding:5px;border-radius:6px;border:1px solid var(--border-subtle);cursor:pointer;font-size:11px;font-weight:600;
        background:${commentScopeAll ? "var(--accent)" : "transparent"};color:${commentScopeAll ? "#fff" : "var(--text-muted)"}">All Sections</button>
    </div>`;

  const tabsHTML = `
    <div style="display:flex;gap:0;margin-bottom:12px;border-bottom:2px solid var(--border-subtle)">
      <button onclick="window.setCommentTab('open')" style="flex:1;padding:8px;border:none;cursor:pointer;font-weight:600;font-size:13px;background:none;margin-bottom:-2px;
        border-bottom:${activeCommentTab==="open"?"2px solid var(--accent)":"2px solid transparent"};color:${activeCommentTab==="open"?"var(--accent)":"var(--text-muted)"}">
        Open <span style="background:${openComments.length>0?"#e74c3c":"var(--bg-input)"};color:${openComments.length>0?"#fff":"var(--text-muted)"};border-radius:12px;padding:1px 7px;font-size:11px;margin-left:4px">${openComments.length}</span>
      </button>
      <button onclick="window.setCommentTab('resolved')" style="flex:1;padding:8px;border:none;cursor:pointer;font-weight:600;font-size:13px;background:none;margin-bottom:-2px;
        border-bottom:${activeCommentTab==="resolved"?"2px solid var(--accent)":"2px solid transparent"};color:${activeCommentTab==="resolved"?"var(--accent)":"var(--text-muted)"}">
        Resolved <span style="background:var(--bg-input);color:var(--text-muted);border-radius:12px;padding:1px 7px;font-size:11px;margin-left:4px">${closedComments.length}</span>
      </button>
    </div>`;

  if (filtered.length === 0) {
    list.innerHTML = scopeBar + tabsHTML + `<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:20px 0">No ${activeCommentTab} comments${!commentScopeAll ? " in this section" : ""}</div>`;
    return;
  }

  list.innerHTML = scopeBar + tabsHTML + filtered.map(c => buildCommentCard(c)).join("");

  // Wire up resolve / delete / reply buttons
  list.querySelectorAll(".resolve-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      await updateDoc(doc(db, "first-connect-reports", currentFcId, "comments", btn.dataset.id), { status: "resolved" });
    });
  });
  list.querySelectorAll(".reopen-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      await updateDoc(doc(db, "first-connect-reports", currentFcId, "comments", btn.dataset.id), { status: "open" });
    });
  });
  list.querySelectorAll(".delete-comment-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this comment?")) return;
      await deleteDoc(doc(db, "first-connect-reports", currentFcId, "comments", btn.dataset.id));
    });
  });
  list.querySelectorAll(".reply-submit-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const input   = btn.previousElementSibling;
      const replyTx = input.value.trim();
      if (!replyTx) return;
      const comment = localComments.find(c => c.id === btn.dataset.id);
      if (!comment) return;
      const replies = [...(comment.replies || [])];
      replies.push({ text: replyTx, author: currentUserName, createdAt: new Date().toISOString() });
      await updateDoc(doc(db, "first-connect-reports", currentFcId, "comments", btn.dataset.id), { replies });
      input.value = "";
    });
  });
}

// ── BUILD ONE COMMENT CARD ─────────────────────────────────
function buildCommentCard(c) {
  const repliesHtml = (c.replies || []).map(r => `
    <div style="padding:6px 8px;background:rgba(0,0,0,0.04);border-radius:6px;margin-top:4px;font-size:11px">
      <strong>${r.author}</strong>&nbsp;${r.text}
    </div>`).join("");

  const isResolved = c.status === "resolved";
  const isOwner    = c.authorId === currentUserId;

  return `
    <div class="comment-item" data-id="${c.id}"
      style="padding:12px;margin-bottom:10px;border:1px solid var(--border-subtle);border-radius:8px;font-size:12px">

      <!-- Author + timestamp -->
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-weight:600;color:var(--text-main)">${c.authorName || c.user || "Unknown"}</span>
        ${isResolved
          ? `<span style="font-size:10px;color:#22c55e;background:rgba(34,197,94,0.1);padding:2px 7px;border-radius:10px">✓ Resolved</span>`
          : `<span style="font-size:10px;color:var(--text-muted)">${currentSectionKey}</span>`}
      </div>

      <!-- Highlighted text -->
      ${c.selectedText
        ? `<div style="background:rgba(255,210,0,0.2);padding:4px 8px;border-radius:4px;margin-bottom:6px;font-size:11px;font-style:italic">"${c.selectedText}"</div>`
        : ""}

      <!-- Comment body -->
      <div style="margin-bottom:8px;line-height:1.5;color:var(--text-main)">${c.comment}</div>

      <!-- Replies -->
      ${repliesHtml
        ? `<div style="margin-bottom:8px">${repliesHtml}</div>`
        : ""}

      <!-- Row 1: Reply input + send -->
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
        <input
          type="text"
          placeholder="Write a reply..."
          style="flex:1;font-size:11px;padding:5px 8px;border-radius:6px;
            border:1px solid var(--border-subtle);background:var(--bg-input);
            color:var(--text-main);min-width:0">
        <button class="small-btn reply-submit-btn" data-id="${c.id}"
          style="padding:4px 10px;font-size:11px;white-space:nowrap;flex-shrink:0">
          Reply
        </button>
      </div>

      <!-- Row 2: Resolve + Delete -->
      <div style="display:flex;gap:6px;justify-content:flex-end">
        ${!isResolved
          ? `<button class="small-btn resolve-btn" data-id="${c.id}"
              style="font-size:11px;padding:4px 10px;color:#22c55e;
                border-color:rgba(34,197,94,0.4);white-space:nowrap">
              ✓ Resolve
            </button>`
          : `<button class="small-btn reopen-btn" data-id="${c.id}"
              style="font-size:11px;padding:4px 10px;white-space:nowrap">
              ↩ Reopen
            </button>`}
        ${isOwner
          ? `<button class="small-btn delete-comment-btn" data-id="${c.id}"
              style="font-size:11px;padding:4px 10px;color:#ef4444;
                border-color:rgba(239,68,68,0.4);white-space:nowrap">
              🗑 Delete
            </button>`
          : ""}
      </div>
    </div>`;
}

// ── WINDOW HELPERS (called from inline onclick) ────────────
window.setCommentTab = (tab) => { activeCommentTab = tab; renderComments(); };
window.setCommentScope = (all) => { commentScopeAll = all; renderComments(); };
window.navigateToComment = (e, id, section) => {
  e.stopPropagation();
  if (section !== currentSectionKey) {
    navigateTo(section);
  }
  const card = document.querySelector(`.comment-item[data-id="${id}"]`);
  if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
};
// ── NAVIGATE TO FIELD ON COMMENT CLICK ────────────────────────────────────
window.navigateToComment = function(e, commentId, section) {
  if (section && section !== currentSectionKey) {
    currentSectionKey = section;
    document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
    document.querySelector(`.nav-item[data-section="${section}"]`)?.classList.add("active");
    renderCurrentSection();
  }

  // After section renders, find and scroll to the highlighted text
  setTimeout(() => {
    const comment = localComments.find(c => c.id === commentId);
    if (!comment?.selectedText) return;

    const range = findTextRangeInEditors(comment.selectedText);
    if (range) {
      const el = range.startContainer.parentElement;
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      // Flash highlight
      const orig = el.style.background;
      el.style.background = "rgba(255,210,0,0.45)";
      el.style.transition = "background 0.6s";
      setTimeout(() => { el.style.background = orig; }, 1200);
    }
  }, 350);
};

// ── HIGHLIGHT COMMENTED TEXT AS YELLOW OVERLAY ────────────────────────────
function highlightCommentedText() {
  document.querySelectorAll(".comment-highlight-overlay").forEach(el => el.remove());
  const svg = document.getElementById("comment-threads-svg");
  if (svg) svg.innerHTML = "";

  const panel = document.getElementById("comments-panel");
  if (!panel?.classList.contains("open")) return;

  const activeComments = localComments.filter(c =>
    (!c.section || c.section === currentSectionKey) &&
    c.selectedText &&
    c.status !== "resolved"
  );

  activeComments.forEach(comment => {
    const range = findTextRangeInEditors(comment.selectedText);
    if (!range) return;
    const rect = range.getBoundingClientRect();
    if (!rect || rect.width === 0) return;

    // Floating overlay — appended to body so it never breaks Quill layout
    const overlay = document.createElement("div");
    overlay.className = "comment-highlight-overlay";
    overlay.dataset.commentId = comment.id;
    overlay.style.cssText = `
      position:fixed;
      left:${rect.left}px;top:${rect.top}px;
      width:${rect.width}px;height:${rect.height + 2}px;
      background:rgba(255,210,0,0.22);
      border-bottom:2px solid rgba(255,170,0,0.7);
      border-radius:2px;pointer-events:none;z-index:197`;
    document.body.appendChild(overlay);

    drawThreadLine(rect, comment.id);
  });
}

// ── FIND TEXT IN EDITOR NODES (no DOM mutation) ───────────────────────────
function findTextRangeInEditors(searchText) {
  for (const editor of document.querySelectorAll(".ql-editor, [contenteditable='true'], textarea, input[type='text']")) {
    if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") {
      const idx = editor.value.indexOf(searchText);
      if (idx !== -1) {
        // For non-contenteditable, just return its bounding rect wrapped in a fake range-like object
        const rect = editor.getBoundingClientRect();
        return { getBoundingClientRect: () => rect, startContainer: { parentElement: editor } };
      }
      continue;
    }
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const idx = node.textContent.indexOf(searchText);
      if (idx !== -1) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + searchText.length);
        return range;
      }
    }
  }
  return null;
}

// ── DRAW BEZIER THREAD LINE FROM HIGHLIGHT → CARD ─────────────────────────
function drawThreadLine(highlightRect, commentId) {
  let svg = document.getElementById("comment-threads-svg");
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = "comment-threads-svg";
    svg.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:198";
    document.body.appendChild(svg);
  }

  const card = document.querySelector(`.comment-item[data-id="${commentId}"]`);
  if (!card) return;

  const c  = card.getBoundingClientRect();
  const x1 = highlightRect.right + 4;
  const y1 = highlightRect.top + highlightRect.height / 2;
  const x2 = c.left;
  const y2 = c.top + 20;
  const cx = (x1 + x2) / 2;

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", `M${x1} ${y1} C${cx} ${y1},${cx} ${y2},${x2} ${y2}`);
  path.setAttribute("stroke", "rgba(255,180,0,0.5)");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke-dasharray", "5 3");
  svg.appendChild(path);
}
function setupCommentsToggle() {
  document.getElementById("comments-toggle-btn").addEventListener("click", () => {
    const panel  = document.getElementById("comments-panel");
    const layout = document.querySelector(".im-layout");
    const isOpen = panel.classList.toggle("open");
    layout.classList.toggle("comments-open", isOpen);

    if (!isOpen) {
      // Clean up overlays and thread lines when panel closes
      document.querySelectorAll(".comment-highlight-overlay").forEach(el => el.remove());
      const svg = document.getElementById("comment-threads-svg");
      if (svg) svg.innerHTML = "";
    } else {
      setTimeout(highlightCommentedText, 100);
    }
  });

  const closeBtn = document.getElementById("close-comments-btn");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      const panel  = document.getElementById("comments-panel");
      const layout = document.querySelector(".im-layout");
      panel.classList.remove("open");
      layout?.classList.remove("comments-open");
      document.querySelectorAll(".comment-highlight-overlay").forEach(el => el.remove());
      const svg = document.getElementById("comment-threads-svg");
      if (svg) svg.innerHTML = "";
    });
  }

  // Redraw on scroll — fc canvas scrolls inside .im-main
  document.querySelector(".im-main")?.addEventListener("scroll", () => {
    setTimeout(highlightCommentedText, 30);
  });
  document.getElementById("fc-canvas")?.addEventListener("scroll", () => {
    setTimeout(highlightCommentedText, 30);
  });
}
