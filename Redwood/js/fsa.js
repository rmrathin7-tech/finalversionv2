import { db, auth } from "./firebase.js";
import { doc, updateDoc, getDoc, arrayUnion } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { buildFinancialModel } from "./fsa/core/engine.js";
import { formatValue } from "./fsa/utils/formatters.js";
import { initAnalysis } from "./fsa/ui/analysis.js";
import { initDataEntry } from "./fsa/ui/dataEntry.js";
import { initDashboard } from "./fsa/ui/dashboard.js";
import { initStatements } from "./fsa/ui/statements.js";
import { createFSAService } from "./fsa/services/fsaService.js";
import { fsaState } from "./fsa/state/fsaState.js";
import { setupYearSystem } from "./fsa/features/years.js";
import { setupExportImport } from "./fsa/features/exportImport.js";
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const storage = getStorage();
const fsaService = createFSAService(db);

// Dynamic schemas — built from Firestore at runtime
let configSchemas = {};
let currentProjectId = null;
let currentFsaId = null;
let dataEntryModuleRef = null;

// Temporarily hold the imported PDF file during review
let importedPdfFile = null;
// AbortController to allow cancelling an in-progress PDF extraction
let pdfImportAbortController = null;

document.getElementById("settings-btn")?.addEventListener("click", () => {
  const params = new URLSearchParams(window.location.search);
  const project = params.get("project");
  window.location.href = `settings.html?project=${project}`;
});

init();

function init() {
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            window.location.href = "login.html";
            return;
        }

        const params = new URLSearchParams(window.location.search);
        currentProjectId = params.get("project");
        currentFsaId = params.get("fsa");

        if (!currentProjectId || !currentFsaId) {
            alert("Invalid FSA");
            return;
        }

        await loadFSA();
        setupThemeToggle();
        setupProjectLabel();
        setupLogbookButton(); // INJECT LOGBOOK UI
        setupNavigation();
        setupExit();
        setupExportImport({ db, currentProjectId, currentFsaId, renderSection });
    });
}

// ── AUDIT LOGBOOK SYSTEM ──────────────────────────────────────────
async function addAuditLog(action, details) {
    if (!fsaState.currentFsaData) return;
    const user = auth.currentUser;
    const logEntry = {
        timestamp: Date.now(),
        userEmail: user ? user.email : 'Unknown User',
        action,
        details
    };

    if (!fsaState.currentFsaData.auditLogs) fsaState.currentFsaData.auditLogs = [];
    fsaState.currentFsaData.auditLogs.unshift(logEntry); // local instant update

    try {
        await updateDoc(doc(db, "projects", currentProjectId, "fsa", currentFsaId), {
            auditLogs: arrayUnion(logEntry)
        });
    } catch (e) {
        console.error("Failed to save audit log:", e);
    }
}

function setupLogbookButton() {
    const settingsBtn = document.getElementById("settings-btn");
    if (settingsBtn) {
        const logBtn = document.createElement("button");
        logBtn.id = "logbook-btn";
        logBtn.className = "btn-secondary";
        logBtn.innerHTML = "📓 Logbook";
        logBtn.style.marginRight = "10px";
        logBtn.onclick = showLogbookModal;
        settingsBtn.parentNode.insertBefore(logBtn, settingsBtn);
    }
}

function showLogbookModal() {
    const logs = fsaState.currentFsaData.auditLogs || [];
    const existing = document.getElementById('logbook-modal');
    if (existing) existing.remove();

    const modal = document.createElement("div");
    modal.id = "logbook-modal";
    modal.style.cssText = "position:fixed; inset:0; background:rgba(0,0,0,0.8); z-index:10000; display:flex; justify-content:center; align-items:center; backdrop-filter:blur(5px);";

  function renderLogDetails(details) {
    try {
        const parsed = JSON.parse(details);
        if (Array.isArray(parsed)) {
            const keys = Object.keys(parsed[0] || {});
            const header = `<tr style="background:var(--bg-app)">${keys.map(k =>
                `<th style="padding:4px 10px;font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;font-weight:700;text-align:left">${k}</th>`
            ).join('')}</tr>`;
            const bodyRows = parsed.map(row =>
                `<tr>${keys.map(k =>
                    `<td style="padding:4px 10px;font-size:12px;color:var(--text-main);border-top:1px solid var(--border-color)">${row[k] ?? ''}</td>`
                ).join('')}</tr>`
            ).join('');
            return `<div style="overflow-x:auto;margin-top:4px"><table style="border-collapse:collapse;width:100%;background:var(--bg-input);border-radius:6px;overflow:hidden">${header}${bodyRows}</table></div>`;
        } else {
            const rowsHtml = Object.entries(parsed).map(([k, v]) =>
                `<div style="display:flex;gap:8px;padding:3px 0;border-bottom:1px solid var(--border-color)">
                    <span style="color:var(--text-muted);font-size:11px;min-width:90px;text-transform:capitalize">${k}</span>
                    <span style="color:var(--brand-primary);font-size:12px;font-weight:600">${v}</span>
                </div>`
            ).join('');
            return `<div style="background:var(--bg-input);border-radius:6px;padding:8px 12px;margin-top:4px">${rowsHtml}</div>`;
        }
    } catch {
        return `<div style="color:var(--brand-primary);font-family:monospace;font-size:12px;background:var(--bg-input);padding:8px;border-radius:6px;margin-top:4px">${details}</div>`;
    }
}

const actionColors = {
    'PDF Imported':          '#3b82f6',
    'Item Deleted':          '#ef4444',
    'Review — Mapped Field': '#f59e0b',
    'Review — Value Edited': '#a78bfa',
    'Review Completed':      '#10b981',
    'Data Entry Edit':       '#10b981',
    'Source Attached':       '#6366f1',
};

let rows = logs.map(l => {
    const color = actionColors[l.action] || 'var(--brand-primary)';
    return `
    <div style="padding:14px 16px; border-bottom:1px solid var(--border-color); font-size:13px; background:var(--bg-surface); border-radius:8px; margin-bottom:8px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px; align-items:center;">
            <strong style="color:${color}; font-size:13px; background:${color}22; padding:2px 10px; border-radius:20px; border:1px solid ${color}44;">${l.action}</strong>
            <span style="color:var(--text-muted); font-size:11px;">${new Date(l.timestamp).toLocaleString()}</span>
        </div>
        <div style="color:var(--text-muted); margin-bottom:6px; display:flex; align-items:center; gap:6px; font-size:12px;">
            👤 <span>${l.userEmail}</span>
        </div>
        ${renderLogDetails(l.details)}
    </div>`;
}).join('');


    if (!rows) rows = `<div style="padding:30px; color:var(--text-muted); text-align:center; font-size:14px;">No activity logged yet.</div>`;

    modal.innerHTML = `
        <div class="fsa-card" style="width:650px; max-height:85vh; display:flex; flex-direction:column; padding:0; overflow:hidden;">
            <div style="padding:20px 24px; border-bottom:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:center; background:var(--bg-app);">
                <h3 style="margin:0; color:var(--text-main); display:flex; align-items:center; gap:8px;">📓 Audit Logbook</h3>
                <button id="close-logbook" style="background:var(--bg-input); border:none; color:var(--text-muted); font-size:20px; width:32px; height:32px; border-radius:50%; cursor:pointer; display:flex; align-items:center; justify-content:center;">×</button>
            </div>
            <div style="flex:1; overflow-y:auto; padding:20px; background:var(--bg-app);">
                ${rows}
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('close-logbook').onclick = () => modal.remove();
    modal.onclick = (e) => { if(e.target === modal) modal.remove(); };
}

// ── HELPER: Local slugify ──────────────────────────────────────────
function slugifyKey(str) {
    if (!str) return '';
    return str.trim()
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .split(/\s+/)
        .filter(Boolean)
        .map((w, i) => i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())
        .join('');
}

// ── LOAD ENTERPRISE SCHEMA (6-LEVEL) ──────────────────────────────────
async function loadFSA() {
    const fsaRef = doc(db, "projects", currentProjectId, "fsa", currentFsaId);
    const snapshot = await getDoc(fsaRef);

    if (!snapshot.exists()) {
        alert("FSA not found");
        return;
    }

    fsaState.currentFsaData = snapshot.data();
    if (!fsaState.currentFsaData.data) fsaState.currentFsaData.data = {};
    if (!fsaState.currentFsaData.years) fsaState.currentFsaData.years = [];

    console.log("FSA Data loaded:", fsaState.currentFsaData);

    // Fetch Global Configurations
    const [domSnap, entSnap, analysisSnap, engineSnap, dashSnap] = await Promise.all([
        getDoc(doc(db, 'workspace-config', 'domainTemplates')),
        getDoc(doc(db, 'workspace-config', 'entityTypes')),
        getDoc(doc(db, 'workspace-config', 'analysisConfig')),
        getDoc(doc(db, 'workspace-config', 'engineConfig')),
        getDoc(doc(db, 'workspace-config', 'dashboardConfig'))
    ]);

    const domData = domSnap.data() || {};
    const fsaDomainId = fsaState.currentFsaData.domain || 'shared';

    // ── NORMALISE: read CoA with Array.isArray() guards ───────────────
    const rawCoa = domData.chartOfAccounts || {};
    const coa = {};
    for (const [dKey, dVal] of Object.entries(rawCoa)) {
      coa[dKey] = {};
      if (dVal && typeof dVal === 'object') {
        for (const [docKey, docVal] of Object.entries(dVal)) {
          coa[dKey][docKey] = Array.isArray(docVal)
            ? docVal
            : (docVal && typeof docVal === 'object' ? Object.values(docVal) : []);
        }
      }
    }

    // Helper: resolve chart of accounts sections for a document definition.
    // Accepts the full docDef object (preferred) or a plain id string.
    // Strategy: try id-based lookup first across all domain keys, then fall
    // back to key-based lookup so old/migrated data is always found.
    function getCoaSections(docDef) {
      const lookupId  = typeof docDef === 'string' ? docDef : (docDef.id  || '');
      const lookupKey = typeof docDef === 'object'  ? (docDef.key || '') : '';

      // Returns the first non-empty sections array found for a given lookup string.
      function tryLookup(lookup) {
        if (!lookup) return null;
        // Try the FSA's own domain, then 'shared', then top-level coa keys
        const candidates = [
          coa[fsaDomainId]?.[lookup],
          coa['shared']?.[lookup],
          coa[lookup],
        ];
        for (const arr of candidates) {
          if (Array.isArray(arr) && arr.length > 0) return arr;
        }
        // Broader search across all domain keys
        for (const dk of Object.keys(coa)) {
          if (Array.isArray(coa[dk][lookup]) && coa[dk][lookup].length > 0) return coa[dk][lookup];
        }
        return null;
      }

      const idResult  = lookupId ? tryLookup(lookupId) : null;
      const keyResult = (lookupKey && lookupKey !== lookupId) ? tryLookup(lookupKey) : null;

      // If the id-based result exists but every section has empty items,
      // merge line items from the key-based result (recovers items stored
      // under the old key-keyed format before the id migration ran).
      if (idResult && idResult.length > 0) {
        const hasAnyItems = idResult.some(
          s => Array.isArray(s.items) && s.items.length > 0
        );
        if (!hasAnyItems && keyResult && keyResult.length > 0) {
          const keyItemsMap = {};
          keyResult.forEach(s => { if (s.key) keyItemsMap[s.key] = s.items || []; });
          return idResult.map(s => {
            if (s.key && Array.isArray(keyItemsMap[s.key]) && keyItemsMap[s.key].length > 0 &&
                (!Array.isArray(s.items) || s.items.length === 0)) {
              return { ...s, items: keyItemsMap[s.key] };
            }
            return s;
          });
        }
        return idResult;
      }

      return keyResult || [];
    }

    // 🚀 ASSEMBLE 6-LEVEL ARCHITECTURE
    configSchemas = {
      domains: Array.isArray(domData.domains) ? domData.domains : [],
      documents: (Array.isArray(domData.documents) ? domData.documents : []).map(docDef => {
        const sections = getCoaSections(docDef);
        return {
          id:    docDef.id,
          key:   docDef.key,
          title: docDef.title,
          structure: sections.map(sectionData => {
            if (!sectionData || typeof sectionData !== 'object') return sectionData;
            
            // Normalize items array
            const rawItems = Array.isArray(sectionData.items)
              ? sectionData.items
              : (sectionData.items && typeof sectionData.items === 'object' ? Object.values(sectionData.items) : []);
            
            const items = rawItems.map(iObj => {
              if (typeof iObj === 'string') {
                return { name: iObj, dataKey: slugifyKey(iObj), subItems: [] };
              }
              const rawSub = Array.isArray(iObj.subItems)
                ? iObj.subItems
                : (iObj.subItems && typeof iObj.subItems === 'object' ? Object.values(iObj.subItems) : []);
              return {
                name:     iObj.name    || '',
                dataKey:  iObj.dataKey || slugifyKey(iObj.name || ''),
                subItems: rawSub.map(sub =>
                  typeof sub === 'string' 
                    ? { name: sub, dataKey: slugifyKey(sub) } 
                    : { name: sub.name || '', dataKey: sub.dataKey || slugifyKey(sub.name || '') }
                )
              };
            });
            
            // Normalize inline section totals
            const rawTotals = Array.isArray(sectionData.totals)
              ? sectionData.totals
              : (sectionData.totals && typeof sectionData.totals === 'object' ? Object.values(sectionData.totals) : []);

            // FIX: Auto-flag any equity section as dynamic to tell dataEntry/statements to pull from Master Entities
            const isEquitySection = sectionData.key === 'equity' || (sectionData.title || '').toLowerCase().includes('equity');

            return {
              ...sectionData,
              type:    sectionData.type  || 'section',
              key:     sectionData.key,
              title:   sectionData.title,
              dynamic: !!sectionData.dynamic || isEquitySection, 
              color:   sectionData.color ?? null,
              bg:      sectionData.bg    ?? null,
              items,
              totals:  rawTotals.map(t => ({
                title:   t.title   || '',
                key:     t.key     || '',
                formula: t.formula || '',
                color:   t.color   || '#6366f1',
                bg:      t.bg      || 'rgba(99,102,241,0.10)'
              }))
            };
          })
        };
      }),
      crossDocLinks:         Array.isArray(engineSnap.data()?.crossDocLinks) ? engineSnap.data().crossDocLinks : [],
      confidenceThresholds:  engineSnap.data()?.confidenceThresholds  || { high: 85, medium: 60 },
      customRatios:          Array.isArray(analysisSnap.data()?.customRatios) ? analysisSnap.data().customRatios : [],
      metricsFormulas:       Array.isArray(engineSnap.data()?.metrics) ? engineSnap.data().metrics : [],
      dashboardConfig:       dashSnap.data()                          || { kpis: [], charts: [] },
      entityTypes:           (Array.isArray(entSnap.data()?.types) ? entSnap.data().types : []).reduce((acc, et) => { acc[et.key] = et; return acc; }, {})
    };

    // 🌟 GLOBAL RESOLUTION: Determine exactly which Equity Items belong to THIS specific FSA
    // We look up the entity chosen in Module Hub (e.g. 'pvtLtd') and grab its Master Entity array.
    const fsaEntityKey = fsaState.currentFsaData.entityType;
    const activeEntityDef = configSchemas.entityTypes[fsaEntityKey] || Object.values(configSchemas.entityTypes)[0];
    configSchemas.activeEquityItems = activeEntityDef ? (activeEntityDef.equityItems || []) : [];

    console.log(`🏦 Entity Assigned: ${activeEntityDef?.label || 'Unknown'} | Active Equity Items:`, configSchemas.activeEquityItems);

    // Fallbacks to prevent crashes if Settings are empty
    if (configSchemas.documents.length === 0) {
        configSchemas.documents = [
            { id: 'pnl', key: 'pnl', title: 'Profit & Loss', structure: [] },
            { id: 'bs', key: 'bs', title: 'Balance Sheet', structure: [] }
        ];
    }

    // ── ENSURE EQUITY SECTION EXISTS IN BS (SMARTER FALLBACK) ──────────
    // Matches the document by key 'bs' or if the title implies it is a Balance Sheet
    const bsDoc = configSchemas.documents.find(d => d.key === 'bs' || d.title.toLowerCase().includes('balance sheet'));
    if (bsDoc) {
        const hasEquity = bsDoc.structure.some(s => s.key === 'equity' || s.dynamic || (s.title || '').toLowerCase().includes('equity'));
        if (!hasEquity) {
            console.log("📝 Adding equity section fallback to BS structure");
            bsDoc.structure.push({
                type: 'section',
                key: 'equity',
                title: 'Equity',
                dynamic: true, // Native dynamic fallback
                color: null,
                bg: null,
                items: []
            });
        }
    }
    
    // Backward compatibility references
    configSchemas.pnlSchema = configSchemas.documents.find(d => d.key === 'pnl') || configSchemas.documents[0];
    configSchemas.bsSchema = configSchemas.documents.find(d => d.key === 'bs') || configSchemas.documents[1];

    if (!fsaState.currentSection) fsaState.currentSection = "dataEntry";

    if (!window.hasRendered) {
        window.hasRendered = true;
        renderSection(fsaState.currentSection);
    }
}

// ── NAVIGATION & SETUP ────────────────────────────────────────────────
function setupNavigation() {
    document.querySelectorAll(".fsa-nav-btn").forEach(tab => {
        tab.addEventListener("click", () => {
            document.querySelectorAll(".fsa-nav-btn").forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            fsaState.currentSection = tab.dataset.target;
            renderSection(fsaState.currentSection);
        });
    });
}

function setupExit() {
    document.getElementById("back-btn")?.addEventListener("click", () => {
        const params = new URLSearchParams(window.location.search);
        const name = params.get("name");
        window.location.href = `module-hub.html?project=${currentProjectId}&name=${encodeURIComponent(name)}`;
    });
}

function setupThemeToggle() {
    const saved = localStorage.getItem("redwood-theme") || "dark";
    document.documentElement.setAttribute("data-theme", saved);
    const btn = document.getElementById("theme-toggle-btn");
    if (!btn) return;
    
    const lightIcon = btn.querySelector('.light-icon');
    const darkIcon = btn.querySelector('.dark-icon');
    
    if(saved === 'light') {
        if(lightIcon) lightIcon.style.display = 'block';
        if(darkIcon) darkIcon.style.display = 'none';
    } else {
        if(lightIcon) lightIcon.style.display = 'none';
        if(darkIcon) darkIcon.style.display = 'block';
    }
}

function setupProjectLabel() {
    const params = new URLSearchParams(window.location.search);
    const name = params.get("name") || "FSA";
    const display = document.getElementById("company-name-display");
    if (!display) return;

    const fsaTitle    = fsaState.currentFsaData?.title || '';
    const domainId    = fsaState.currentFsaData?.domain;
    const entityKey   = fsaState.currentFsaData?.entityType;

    const domainLabel = configSchemas.domains?.find(d => d.id === domainId)?.label || '';
    const entityLabel = configSchemas.entityTypes?.[entityKey]?.label || '';

    const mainText = fsaTitle
        ? `${decodeURIComponent(name)} — ${fsaTitle}`
        : `${decodeURIComponent(name)} — Financial Statement Analysis`;

    const tagStyle = `display:inline-block; font-size:10px; font-weight:700; padding:2px 8px;
        border-radius:12px; margin-left:8px; vertical-align:middle; letter-spacing:0.5px;`;
    let tags = '';
    if (domainLabel) tags += `<span style="${tagStyle} background:rgba(99,102,241,0.15); color:#a5b4fc; border:1px solid rgba(99,102,241,0.3);">🏢 ${domainLabel}</span>`;
    if (entityLabel) tags += `<span style="${tagStyle} background:rgba(16,185,129,0.12); color:#6ee7b7; border:1px solid rgba(16,185,129,0.25);">⚖️ ${entityLabel}</span>`;

    display.innerHTML = mainText + tags;
}

// ── SECTION RENDERER ──────────────────────────────────────────────────
function renderSection(section) {
    if (!fsaState.currentFsaData) return;
    const canvas = document.getElementById("canvas");

    if (section === "dashboard") {
        const dashboardModule = initDashboard({
            currentFsaData: fsaState.currentFsaData,
            reclassMap: fsaState.reclassMap,
            configSchemas
        });
        if(dashboardModule.renderDashboard) dashboardModule.renderDashboard(canvas);
    }

    if (section === "dataEntry") {
        // 🚀 DYNAMIC TABS GENERATION
        const docButtonsHtml = configSchemas.documents.map((doc, index) => 
            `<button class="fsa-btn doc-tab-btn" data-doc-key="${doc.key}" style="${index === 0 ? 'background:var(--brand-primary); border-color:var(--brand-primary); color:white;' : ''}">${doc.title}</button>`
        ).join("");

        canvas.innerHTML = `
            <div class="fsa-card">
                <h2>Data Entry</h2>

                <div style="margin-bottom:20px;">
                    <button id="add-year-btn" class="btn-secondary">+ Add Year</button>
                    <button id="manage-years-btn" class="btn-secondary" style="background:transparent; border:1px solid var(--border-color); color:var(--text-muted);">Manage Years</button>
                    <div id="year-container" style="margin-top:15px;"></div>
                </div>

                <div style="margin-top:30px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                    <div id="doc-tabs-container" style="display:flex; gap:8px;">
                        ${docButtonsHtml}
                    </div>
                    <div style="margin-left:auto; display:flex; gap:8px; align-items:center;">
                        <button id="import-pdf-btn" class="btn-primary">📥 Import PDF</button>
                        <button id="attach-source-btn" class="btn-secondary">📎 Attach Source</button>
                        <button id="review-mode-btn" class="btn-secondary" style="background:rgba(16,185,129,0.1); color:#10b981; border-color:rgba(16,185,129,0.3); display:none;">📋 Review Mode</button>
                    </div>
                </div>
                
                <input type="file" id="pdf-import-input" accept=".pdf" style="display:none" />
                <input type="file" id="pdf-source-input" accept=".pdf" multiple style="display:none" />

                <div id="data-entry-area" style="margin-top:30px;"></div>

                <div id="pdf-notes-area" style="display:none; margin-top:24px; padding:16px; background:var(--bg-input); border:1px solid var(--border-color); border-radius:10px;">
                    <div style="font-size:13px; font-weight:700; color:var(--text-muted); margin-bottom:10px;">📋 Notes from PDF</div>
                    <ul id="pdf-notes-list" style="margin:0; padding-left:18px; color:var(--text-main); font-size:13px; line-height:1.8;"></ul>
                </div>
            </div>
        `;

        // Wrapper to track Data Entry cell modifications
        const _auditPending = new Map();
        const _auditTimers  = new Map();

        // Wrapper to track Data Entry cell modifications
        // dataEntry.js calls: scheduleFieldSave(projectId, fsaId, 'data.docKey.sectionKey.period.item', value)
        const trackingScheduleFieldSave = (projectId, fsaId, path, value) => {
            const parts = path.split('.');
            // path format: "data.{docKey}.{sectionKey}.{period}.{itemName}"
            if (parts.length >= 5 && parts[0] === 'data') {
                const [, docKey, sectionKey, period, itemName] = parts;

                // Capture original value only on the FIRST keystroke for this path
                if (!_auditPending.has(path)) {
                    const originalVal = fsaState.currentFsaData?.data?.[docKey]?.[sectionKey]?.[period]?.[itemName] ?? 0;
                    _auditPending.set(path, { originalVal, docKey, sectionKey, period, itemName });
                }

                // Always update the latest typed value
                _auditPending.get(path).currentVal = value;

                // Debounce: reset timer on each keystroke, fire only after 1.5s of inactivity
                if (_auditTimers.has(path)) clearTimeout(_auditTimers.get(path));
                _auditTimers.set(path, setTimeout(() => {
                    const entry = _auditPending.get(path);
                    if (entry && Number(entry.originalVal) !== Number(entry.currentVal)) {
                        addAuditLog('Data Entry Edit', JSON.stringify({
                            field:    entry.itemName,
                            year:     entry.period,
                            document: entry.docKey.toUpperCase(),
                            section:  entry.sectionKey,
                            from:     entry.originalVal,
                            to:       entry.currentVal
                        }));
                    }
                    _auditPending.delete(path);
                    _auditTimers.delete(path);
                }, 1500));
            }
            fsaService.scheduleFieldSave(projectId, fsaId, path, value);
        };


        dataEntryModuleRef = initDataEntry({
            currentFsaData: fsaState.currentFsaData,
            reclassMap: fsaState.reclassMap,
            updateDocRef: updateDoc,
            projectId: currentProjectId,
            fsaId: currentFsaId,
            db,
            updatePnLTotals,
            updateBSTotals,
            scheduleFieldSave: trackingScheduleFieldSave, // INJECT WRAPPER
            configSchemas
        });

        setupYearSystem({
            db,
            currentProjectId,
            currentFsaId,
            dataEntryModuleRef,
            pnlSchema: configSchemas.documents[0] 
        });

        // Dynamic Tab Listeners
        document.querySelectorAll('.doc-tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.doc-tab-btn').forEach(b => {
                    b.style.background = 'var(--bg-surface-solid)';
                    b.style.borderColor = 'var(--border-color)';
                    b.style.color = 'var(--text-main)';
                });
                e.target.style.background = 'var(--brand-primary)';
                e.target.style.borderColor = 'var(--brand-primary)';
                e.target.style.color = 'white';
                
                const docKey = e.target.dataset.docKey;
                const docConfig = configSchemas.documents.find(d => d.key === docKey);
                if (docConfig && dataEntryModuleRef) {
                    dataEntryModuleRef.safeRender(docConfig, docKey);
                    renderNotesPanel();
                }
            });
        });

        const firstBtn = document.querySelector('.doc-tab-btn');
        if (firstBtn) firstBtn.click();

        renderNotesPanel();

// PDF IMPORT LOGIC
document.getElementById('import-pdf-btn').addEventListener('click', () => {
    document.getElementById('pdf-import-input').click();
});

// ✅ REPLACED: Added AbortController signal + 5-min timeout + better status hint
document.getElementById('pdf-import-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    importedPdfFile = file;

    const btn = document.getElementById('import-pdf-btn');
    btn.textContent = 'Extracting... 0s';
    btn.disabled = true;

    let elapsed = 0;
    const timer = setInterval(() => {
        elapsed++;
        const hint = elapsed > 15 ? ' (processing, please wait...)' : '';
        btn.textContent = `Extracting... ${elapsed}s${hint}`;
    }, 1000);

    pdfImportAbortController = new AbortController();
    const timeoutId = setTimeout(() => pdfImportAbortController.abort(), 300000); // 5 min

    try {
        const formData = new FormData();
        formData.append('file', file);
        configSchemas.documents.forEach(docDef => {
            const sections = docDef.structure.map(s => ({ key: s.key, title: s.title, subitems: s.items }));
            formData.append(`${docDef.key}_schema`, JSON.stringify(sections));
        });

        const res = await fetch(`https://YOUR-APP-NAME.onrender.com/analyze-pipeline`, {
    method: 'POST',
    body: formData,
    signal: pdfImportAbortController.signal
});

        clearTimeout(timeoutId);

        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`API Error ${res.status} - ${errorText}`);
        }

        const result = await res.json();
        console.log('Extraction successful', result);

        // ✅ Keep ALL your existing success handling below exactly as-is:
        addAuditLog('PDF Imported', `Extracted data from ${file.name}`);
        if (result.mapped.companytype) {
            fsaState.currentFsaData.companyType = result.mapped.companytype;
            console.log('Company Type Detected:', result.mapped.companytype);
        }
        const allPeriods = result.mapped.allperiods || result.mapped.period;
        const existingYears = fsaState.currentFsaData.years;
        const conflicts = allPeriods.filter(p => existingYears.includes(p));
        if (conflicts.length > 0) {
            showConflictModal(conflicts, allPeriods, result.mapped, result.raw, result.confidence);
        } else {
            showImportValidationModal(result.mapped, result.raw, result.confidence, allPeriods);
        }

    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            alert('Extraction timed out after 5 minutes. The server may be cold-starting — try again in 30 seconds.');
        } else {
            console.error('Extraction error', err);
            alert('Extraction failed: ' + err.message);
        }
        importedPdfFile = null;
    } finally {
        clearInterval(timer);
        btn.textContent = 'Import PDF';
        btn.disabled = false;
        e.target.value = '';
    }
});

        // ── ATTACH SOURCE PDF ────────────────────────────────────────────────
        document.getElementById("attach-source-btn").addEventListener("click", () => {
            document.getElementById("pdf-source-input").click();
        });

        document.getElementById("pdf-source-input").addEventListener("change", async (e) => {
            const files = Array.from(e.target.files);
            if (files.length === 0) return;

            const btn = document.getElementById("attach-source-btn");
            btn.textContent = "⏳ Uploading...";
            btn.disabled = true;

            try {
                for (const file of files) {
                    const name = file.name.replace(/\.pdf$/i, '');
                    const storageRef = ref(storage, `fsa-sources/${currentProjectId}/${currentFsaId}/${Date.now()}_${file.name}`);
                    await uploadBytes(storageRef, file);
                    const url = await getDownloadURL(storageRef);

                    const docs = fsaState.currentFsaData.sourceDocuments || [];
                    docs.push({ name, url, uploadedAt: Date.now() });
                    fsaState.currentFsaData.sourceDocuments = docs;
                    
                    addAuditLog("Source Attached", `Attached supplementary document: ${file.name}`);
                }

                await updateDoc(
                    doc(db, "projects", currentProjectId, "fsa", currentFsaId),
                    { sourceDocuments: fsaState.currentFsaData.sourceDocuments }
                );

                renderDocumentList();
                document.getElementById("review-mode-btn").style.display = "inline-flex";
                btn.textContent = "📎 Attach Source";
            } catch (err) {
                alert("Upload failed: " + err.message);
                btn.textContent = "📎 Attach Source";
            } finally {
                btn.disabled = false;
                e.target.value = "";
            }
        });

        function renderDocumentList() {
            const docs = fsaState.currentFsaData.sourceDocuments || [];
            let existing = document.getElementById("source-doc-list");
            if (!existing) {
                existing = document.createElement("div");
                existing.id = "source-doc-list";
                existing.style.cssText = "margin-top:16px; display:flex; gap:8px; flex-wrap:wrap;";
                document.getElementById("attach-source-btn").insertAdjacentElement("afterend", existing);
            }
            existing.innerHTML = docs.map((d, i) => `
                <span style="background:var(--bg-input); border:1px solid var(--border-color); border-radius:6px; padding:6px 12px; font-size:12px; color:var(--text-muted); cursor:pointer; transition:all 0.2s;"
                    onmouseover="this.style.borderColor='var(--brand-primary)'; this.style.color='var(--text-main)';"
                    onmouseout="this.style.borderColor='var(--border-color)'; this.style.color='var(--text-muted)';"
                    onclick="setActiveReviewDoc(${i})" title="Click to preview">
                    📄 ${d.name}
                </span>
            `).join("");
        }

        window.activeReviewDocIndex = 0;
        window.setActiveReviewDoc = (i) => {
            window.activeReviewDocIndex = i;
            const iframe = document.getElementById("review-iframe");
            if (iframe) {
                const docs = fsaState.currentFsaData.sourceDocuments || [];
                iframe.src = docs[i]?.url || "";
            }
        };

        let reviewModeActive = false;
        document.getElementById("review-mode-btn").addEventListener("click", () => {
            reviewModeActive = !reviewModeActive;
            const reviewBtn = document.getElementById("review-mode-btn");
            const canvas = document.getElementById("canvas");
            const fsaMain = document.querySelector(".fsa-main");

            if (reviewModeActive) {
                reviewBtn.textContent = "✕ Exit Review";
                reviewBtn.style.background = "var(--danger-bg)";
                reviewBtn.style.color = "var(--status-danger)";
                reviewBtn.style.borderColor = "rgba(239, 68, 68, 0.3)";

                const docs = fsaState.currentFsaData.sourceDocuments || [];
                const activeDoc = docs[window.activeReviewDocIndex] || docs[0];

                const docTabs = docs.map((d, i) => `
                    <span onclick="setActiveReviewDoc(${i})"
                        style="cursor:pointer; padding:6px 12px; border-radius:6px; font-size:12px; font-weight:600; transition:all 0.2s;
                        background:${i === window.activeReviewDocIndex ? 'var(--brand-primary)' : 'var(--bg-input)'};
                        color:${i === window.activeReviewDocIndex ? 'white' : 'var(--text-main)'};
                        border:1px solid ${i === window.activeReviewDocIndex ? 'var(--brand-primary)' : 'var(--border-color)'};">
                        ${d.name}
                    </span>
                `).join("");

                const pdfPane = document.createElement("div");
                pdfPane.id = "review-pdf-pane";
                pdfPane.style.cssText = `
                    width: 45vw; height: 100%;
                    background: var(--bg-app); z-index: 90; border-right: 1px solid var(--border-color);
                    display: flex; flex-direction: column; flex-shrink: 0; box-shadow: 10px 0 30px rgba(0,0,0,0.1);
                `;
                
                pdfPane.innerHTML = `
                    <div style="padding:12px 16px; background:var(--bg-surface); border-bottom:1px solid var(--border-color); display:flex; gap:10px; align-items:center; flex-wrap:wrap; overflow-x:auto;">
                        <span style="font-size:14px; color:var(--text-muted); margin-right:4px;">📄</span>
                        ${docTabs}
                    </div>
                    <iframe id="review-iframe" src="${activeDoc?.url || ''}"
                        style="flex:1; border:none; width:100%;">
                    </iframe>
                `;
                
                fsaMain.style.display = "flex";
                fsaMain.style.padding = "0";
                fsaMain.style.overflow = "hidden";
                
                canvas.style.flex = "1";
                canvas.style.overflowX = "auto";
                canvas.style.overflowY = "auto";
                canvas.style.padding = "32px 40px";
                
                fsaMain.insertBefore(pdfPane, canvas);

            } else {
                reviewBtn.textContent = "📋 Review Mode";
                reviewBtn.style.background = "rgba(16,185,129,0.1)";
                reviewBtn.style.color = "#10b981";
                reviewBtn.style.borderColor = "rgba(16,185,129,0.3)";
                
                fsaMain.style.display = "";
                fsaMain.style.padding = "";
                fsaMain.style.overflow = "";
                
                canvas.style.flex = "";
                canvas.style.overflowX = "";
                canvas.style.overflowY = "";
                canvas.style.padding = "";
                canvas.style.marginLeft = "";
                
                document.getElementById("review-pdf-pane")?.remove();
            }
        });

        if (fsaState.currentFsaData?.sourceDocuments?.length) {
            document.getElementById("review-mode-btn").style.display = "inline-flex";
            renderDocumentList();
        }
    }

    if (section === "statements") {
        const statementsModule = initStatements({
            currentFsaData: fsaState.currentFsaData,
            reclassMap: fsaState.reclassMap,
            configSchemas 
        });
        if(statementsModule.renderStatements) statementsModule.renderStatements(canvas);
    }

    if (section === "analysis") {
        const analysisModule = initAnalysis({
            currentFsaData: fsaState.currentFsaData,
            reclassMap: fsaState.reclassMap,
            updateDocRef: updateDoc,
            projectId: currentProjectId,
            fsaId: currentFsaId,
            pnlSchema: configSchemas.documents.find(d => d.key === 'pnl') || configSchemas.documents[0],
            balanceSheetSchema: configSchemas.documents.find(d => d.key === 'bs') || configSchemas.documents[1],
            customRatios: configSchemas.customRatios,
            configSchemas 
        });

        if (analysisModule && analysisModule.getHtmlTemplate) {
            canvas.innerHTML = analysisModule.getHtmlTemplate();
            analysisModule.initializeAnalysisWorkbench();
        }
    }
}

// ── CONFLICT RESOLUTION MODAL ───────────────────────────────────
function showConflictModal(conflicts, allPeriods, mapped, raw, confidence) {
    const existing = document.getElementById("conflict-modal");
    if (existing) existing.remove();

    const rows = conflicts.map(p => `
        <div style="display:flex; justify-content:space-between; align-items:center;
                    padding:12px 16px; background:var(--bg-input); border:1px solid var(--border-color); border-radius:8px; margin-bottom:8px;">
            <span style="color:var(--text-main); font-size:14px; font-weight:600;">${p}</span>
            <div style="display:flex; gap:10px;">
                <button data-period="${p}" data-action="replace"
                    style="background:var(--status-danger); color:#fff; border:none; border-radius:6px;
                           padding:6px 16px; font-size:13px; cursor:pointer; font-weight:600; transition:all 0.2s;">
                    Replace
                </button>
                <button data-period="${p}" data-action="skip" class="btn-secondary"
                    style="padding:6px 16px; font-size:13px;">
                    Skip
                </button>
            </div>
        </div>
    `).join("");

    const modal = document.createElement("div");
    modal.id = "conflict-modal";
    modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:10000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(5px);";
    modal.innerHTML = `
        <div class="fsa-card" style="width:500px; padding:32px;">
            <div style="font-size:18px; font-weight:700; color:var(--text-main); margin-bottom:8px; display:flex; align-items:center; gap:8px;">
                <span style="color:#f59e0b;">⚠️</span> Existing Data Detected
            </div>
            <div style="font-size:13px; color:var(--text-muted); margin-bottom:24px; line-height:1.5;">
                The following years already have data in this FSA. Choose to physically overwrite them or skip the import for that year:
            </div>
            ${rows}
            <div style="display:flex; gap:12px; margin-top:28px; justify-content:flex-end;">
                <button id="conflict-cancel" class="btn-secondary">Cancel Import</button>
                <button id="conflict-proceed" class="btn-primary">Continue →</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const decisions = {};
    conflicts.forEach(p => decisions[p] = "skip");

    modal.querySelectorAll("button[data-period]").forEach(btn => {
        btn.addEventListener("click", () => {
            const period = btn.dataset.period;
            const action = btn.dataset.action;
            decisions[period] = action;
            const pair = modal.querySelectorAll(`button[data-period="${period}"]`);
            pair.forEach(b => {
                if (b.dataset.action === action) {
                    b.style.opacity = "1";
                    if (action === 'replace') b.style.boxShadow = "0 0 0 2px rgba(239,68,68,0.4)";
                    else b.style.boxShadow = "0 0 0 2px rgba(255,255,255,0.2)";
                } else {
                    b.style.opacity = "0.4";
                    b.style.boxShadow = "none";
                }
            });
        });
    });

    document.getElementById("conflict-cancel").onclick = () => modal.remove();

    document.getElementById("conflict-proceed").onclick = () => {
        modal.remove();
        const nonConflicting = allPeriods.filter(p => !conflicts.includes(p));
        const replacePeriods = conflicts.filter(p => decisions[p] === "replace");
        const periodsToImport = [...nonConflicting, ...replacePeriods];

        if (periodsToImport.length === 0) {
            alert("All years skipped. Nothing imported.");
            return;
        }
        showImportValidationModal(mapped, raw, confidence, periodsToImport);
    };
}

// ── AI SCHEMA MAPPING + AUTOMATION + SAVED TEMPLATES ──
window.showImportValidationModal = function(mapped, raw, confidence, periodsToShow = null) {
    const existing = document.getElementById('import-modal');
    if (existing) existing.remove();

    const savePeriods = periodsToShow ?? mapped.allperiods ?? [mapped.period];
    const allPeriods = mapped.allperiods ?? savePeriods;

    const savedMapping = fsaState.currentFsaData.mappingTemplate || {};

     function getConfidenceInfo(itemName) {
        // 1. Pull the thresholds DIRECTLY from the settings loaded from Firebase
        const thresholds = configSchemas.confidenceThresholds;
        
        // 2. Get the score from the AI result
        let score = confidence[itemName];
        
        // Fuzzy lookup if casing is different
        if (score == null) {
            const lower = itemName.toLowerCase();
            const match = Object.keys(confidence).find(k => k.toLowerCase() === lower);
            if (match) score = confidence[match];
        }
        
        // 3. Handle cases where AI didn't provide a score
        if (score == null) return { color: 'var(--text-muted)', label: '—', score: null };
        
        // 4. Color Logic strictly using your dynamic Settings:
        if (score >= thresholds.high) {
            return { color: '#10b981', label: 'High', score }; // Green
        } 
        if (score >= thresholds.medium) {
            return { color: '#f59e0b', label: 'Med',  score }; // Amber
        }
        
        // Everything below 'medium' threshold is Red
        return { color: '#ef4444', label: 'Low',  score }; // Red
    }


    function getValidLineItems(docKey, sectionKey) {
        const docSchema = configSchemas.documents.find(d => d.key === docKey);
        const sectionDef = docSchema?.structure.find(s => s.key === sectionKey);
        let items = new Set();
        
        (sectionDef?.items || []).forEach(itemObj => {
            if (typeof itemObj === 'string') {
                items.add(itemObj);
            } else {
                if (itemObj.name) items.add(itemObj.name);
                (itemObj.subItems || []).forEach(sub => {
                    if (typeof sub === 'string') items.add(sub);
                    else if (sub && sub.name) items.add(sub.name);
                });
            }
        });

        const existingData = fsaState.currentFsaData.data?.[docKey]?.[sectionKey];
        if (existingData) {
            Object.values(existingData).forEach(yearData => {
                Object.keys(yearData).forEach(i => items.add(i));
            });
        }
        return Array.from(items);
    }

    function findBestMatch(extractedName, validItems, docKey, sectionKey) {
        if (savedMapping[docKey]?.[sectionKey]?.[extractedName]) {
            const priorChoice = savedMapping[docKey][sectionKey][extractedName];
            if (validItems.includes(priorChoice)) return priorChoice; 
        }
        
        const clean = str => {
            if (!str || typeof str !== 'string') return '';
            return str.toLowerCase().replace(/[^a-z0-9]/g, '');
        };
        const target = clean(extractedName);
        
        let match = validItems.find(item => clean(item) === target);
        if (match) return match;
        
        match = validItems.find(item => target.includes(clean(item)) || clean(item).includes(target));
        if (match) return match;
        
        return null;
    }

    let rows = "";

    function buildTableRows(docData, docTypeLabel) {
        let html = "";
        for (const [section, periodMap] of Object.entries(docData)) {
            const uniqueItems = new Set();
            for (const period of allPeriods) {
                if (periodMap[period]) {
                    Object.keys(periodMap[period]).forEach(item => uniqueItems.add(item));
                }
            }
            if (uniqueItems.size === 0) continue;

            // We changed colspan from +1 to +2 to accommodate the new Status column
            html += `<tr><td colspan="${allPeriods.length + 2}" style="background:var(--table-header-bg); color:var(--text-muted); font-size:11px; padding:12px; font-weight:700; text-transform:uppercase; letter-spacing:1px; margin-top:8px;">${section} (${docTypeLabel.toUpperCase()})</td></tr>`;
            
            for (const item of uniqueItems) {
                const validItems = getValidLineItems(docTypeLabel, section);
                const bestMatch = findBestMatch(item, validItems, docTypeLabel, section);
                            
                let optionsHtml = `<option value="__NEW__" ${!bestMatch ? 'selected' : ''} style="color:var(--status-danger);">+ Save as Custom Item: "${item}"</option>`;
                validItems.forEach(vi => {
                    const isSelected = (vi === bestMatch) ? 'selected' : '';
                    optionsHtml += `<option value="${vi}" ${isSelected}>✓ Map to: ${vi}</option>`;
                });

                html += `<tr>
                    <td style="padding:14px; border-bottom:1px solid var(--glass-border); width:45%;">
                        <div style="font-weight:600; font-size:13px; color:var(--text-main); margin-bottom:8px;">Extracted: ${item}</div>
                        <select class="map-select enterprise-input" data-original="${item}" data-section="${docTypeLabel}" data-key="${section}" style="width:100%; cursor:pointer; font-size:12px;">
                            ${optionsHtml}
                        </select>
                    </td>`;
                
                // ONLY ONE LOOP FOR PERIODS
                for (const period of allPeriods) {
                    const rawVal = periodMap[period]?.[item] ?? 0;
                    const val = Number(rawVal).toFixed(2);
                    const conf = getConfidenceInfo(item);
                    const badge = conf.score !== null
                        ? `<div style="font-size:9px; font-weight:700; color:${conf.color};
                                    background:${conf.color}22; padding:1px 6px; border-radius:4px;
                                    display:inline-block; margin-bottom:4px; letter-spacing:0.5px;">
                            ${conf.label} ${conf.score}%
                        </div>`
                        : '';
                  html += `
                        <td style="padding:10px 8px; border-bottom:1px solid var(--border); vertical-align:bottom; min-width:120px; text-align:center;">
                        ${badge}
                        <input type="number" class="enterprise-input" value="${val}"
                            data-section="${docTypeLabel}" data-key="${section}" data-item="${item}" data-period="${period}"
                            style="width:130px; margin:0 auto; display:block; color:${conf.color}; font-weight:700; text-align:right;" />
                        </td>`;
                }
                
                // ADDED: The Review Toggle Button & Delete Button Column
                html += `
                        <td style="padding:10px 16px; border-bottom:1px solid var(--border); vertical-align:middle; text-align:center;">
                            <div style="display:flex; justify-content:center; align-items:center; gap:8px;">
                                <button class="btn-secondary review-toggle-btn" style="padding:6px 12px; border-radius:20px; font-size:11px; transition:all 0.2s; white-space:nowrap;">
                                    <span class="unreviewed-text">◯ Review</span>
                                    <span class="reviewed-text" style="display:none; color:#10b981;">✅ Reviewed</span>
                                </button>
                                <button class="row-delete-btn" style="display:none; padding:6px 10px; border-radius:20px; font-size:11px; background:rgba(239,68,68,0.1); color:#ef4444; border:1px solid rgba(239,68,68,0.3); cursor:pointer;" title="Delete this extracted item">🗑️ Delete</button>
                            </div>
                        </td>`;
                
                html += `</tr>`;
            }
        }
        return html;
    }

    Object.keys(mapped.data || {}).forEach(docKey => {
        rows += buildTableRows(mapped.data[docKey], docKey);
    });

    const periodHeaders = allPeriods.map(p => `<th style="padding:12px 8px; font-size:12px; color:var(--text-muted); text-align:center;">${p}</th>`).join("");
    const pdfBlobUrl = importedPdfFile ? URL.createObjectURL(importedPdfFile) : null;
    const hasPdf     = !!pdfBlobUrl;

    const modal = document.createElement("div");
    modal.id = "import-modal";
    modal.style.cssText = "position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:9999; display:flex; backdrop-filter:blur(8px);";
    
    // 1. UPDATED HTML TEMPLATE: Added pane IDs and toggle buttons
    modal.innerHTML = `
        ${hasPdf ? `
        <div id="import-pdf-pane" style="width:42%; border-right:1px solid var(--border-color); display:flex; flex-direction:column; background:var(--bg-app); transition: width 0.3s ease;">
            <div style="padding:12px 16px; background:var(--bg-surface); border-bottom:1px solid var(--border-color); font-size:13px; font-weight:600; color:var(--text-muted); display:flex; justify-content:space-between; align-items:center;">
                <span>📄 Imported PDF</span>
                <button id="expand-pdf-btn" class="btn-secondary" style="padding:4px 10px; font-size:11px;">⛶ Expand PDF</button>
            </div>
            <iframe src="${pdfBlobUrl}" style="flex:1; border:none; width:100%;"></iframe>
        </div>
        ` : ''}
        <div id="import-data-pane" style="flex:1; overflow-y:auto; padding:36px; background:var(--bg-app);">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:28px; padding-bottom:24px; border-bottom:1px solid var(--glass-border);">
                <div>
                    <div style="font-size:22px; font-weight:700; color:var(--text-main); display:flex; align-items:center; gap:12px; letter-spacing:-0.5px;">
                        <span style="background:var(--brand-gradient); padding:8px 12px; border-radius:10px; font-size:16px; color:white; box-shadow:0 4px 12px rgba(59,130,246,0.3);">🧠</span>
                        AI Schema Mapping Review
                    </div>
                    <div style="font-size:14px; color:var(--text-muted); margin-top:10px;">${mapped.companyname || mapped.company_name || 'Company'} — Mapping ${allPeriods.join(', ')}</div>
                </div>
                <div style="display:flex; flex-direction:column; align-items:flex-end; gap:12px;">
                    ${hasPdf ? `<button id="expand-data-btn" class="btn-secondary" style="padding:6px 12px; font-size:11px;">⛶ Expand Data View</button>` : ''}
                    <div style="display:flex; gap:16px; font-size:12px; font-weight:600; background:var(--bg-input); padding:12px 20px; border-radius:10px; border:1px solid var(--border-color); box-shadow:inset 0 2px 4px rgba(0,0,0,0.1);">
                        <span style="color:#10b981; display:flex; align-items:center; gap:6px;">● High Confidence</span>
                        <span style="color:#f59e0b; display:flex; align-items:center; gap:6px;">● Medium</span>
                        <span style="color:#ef4444; display:flex; align-items:center; gap:6px;">● Low / Review</span>
                    </div>
                </div>
            </div>
            <table>
                <thead><tr>
                    <th style="font-size:12px;">Standardized Data Mapping</th>
                    ${periodHeaders}
                    <th style="font-size:12px; text-align:center; padding:12px 16px;">Status</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
            <div style="display:flex; gap:16px; margin-top:36px; justify-content:flex-end;">
                <button id="cancel-import" class="btn-secondary" style="font-size:14px; padding:10px 24px;">Cancel</button>
                <button id="confirm-import" class="btn-primary" style="font-size:14px; padding:10px 24px;">✓ Confirm & Save</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // 2. ADDED TOGGLE LOGIC: Allows expanding/restoring panes
    if (hasPdf) {
        const pdfPane = document.getElementById("import-pdf-pane");
        const dataPane = document.getElementById("import-data-pane");
        const btnPdf = document.getElementById("expand-pdf-btn");
        const btnData = document.getElementById("expand-data-btn");

        let pdfExpanded = false;
        let dataExpanded = false;

        btnPdf.addEventListener("click", () => {
            if (pdfExpanded) {
                dataPane.style.display = ""; // Reset display
                pdfPane.style.width = "42%";
                btnPdf.textContent = "⛶ Expand PDF";
                pdfExpanded = false;
            } else {
                dataPane.style.display = "none";
                pdfPane.style.width = "100%";
                btnPdf.textContent = "◩ Restore Split View";
                pdfExpanded = true;
            }
        });

        btnData.addEventListener("click", () => {
            if (dataExpanded) {
                pdfPane.style.display = "flex";
                btnData.textContent = "⛶ Expand Data View";
                dataExpanded = false;
            } else {
                pdfPane.style.display = "none";
                btnData.textContent = "◩ Restore Split View";
                dataExpanded = true;
            }
        });
    }

    // 3. CANCEL IMPORT LOGIC 
    modal.querySelector("#cancel-import").onclick = () => {
        if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl);
        importedPdfFile = null; 
        modal.remove(); 
    };

    // 4. INTERACTIVE REVIEW & DELETE LOGIC
    modal.querySelectorAll('.review-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tr = btn.closest('tr');
            const isReviewed = tr.classList.contains('is-reviewed');
            const delBtn = tr.querySelector('.row-delete-btn');
            
            if (isReviewed) {
                // Mark Unreviewed
                tr.classList.remove('is-reviewed');
                tr.style.opacity = "1";
                tr.style.backgroundColor = "transparent";
                btn.querySelector('.unreviewed-text').style.display = "inline";
                btn.querySelector('.reviewed-text').style.display = "none";
                btn.style.borderColor = "var(--border-color)";
                btn.style.background = "var(--bg-input)";
                if(delBtn) delBtn.style.display = "none";
            } else {
                // Mark Reviewed
                tr.classList.add('is-reviewed');
                tr.style.opacity = "0.7";
                tr.style.backgroundColor = "rgba(16,185,129,0.05)"; 
                btn.querySelector('.unreviewed-text').style.display = "none";
                btn.querySelector('.reviewed-text').style.display = "inline";
                btn.style.borderColor = "#10b981"; 
                btn.style.background = "rgba(16,185,129,0.1)"; 
                if(delBtn) delBtn.style.display = "inline-block";
            }
        });
    });

    modal.querySelectorAll('.row-delete-btn').forEach(delBtn => {
    delBtn.addEventListener('click', () => {
        if (confirm('Are you sure you want to delete this extracted item? It will not be imported.')) {
            const tr = delBtn.closest('tr');
            const itemInput = tr.querySelector('input[data-item]');
            const itemName    = itemInput?.dataset?.item    ?? 'Unknown Field';
            const sectionKey  = itemInput?.dataset?.key     ?? '';
            const docType     = itemInput?.dataset?.section ?? '';

            // Collect all year values from this row
            const yearValues = {};
            tr.querySelectorAll('input[data-period]').forEach(inp => {
                yearValues[inp.dataset.period] = parseFloat(inp.value) || 0;
            });
            const yearsCount  = Object.keys(yearValues).length;
            const valuesSummary = Object.entries(yearValues)
                .map(([yr, v]) => `${yr}: ${v}`)
                .join(' | ');

            addAuditLog('Item Deleted', JSON.stringify({
                field:     itemName,
                document:  docType.toUpperCase(),
                section:   sectionKey,
                years:     yearsCount,
                values:    valuesSummary
            }));
            tr.remove();
        }
    });
});


    // 5. VALIDATION INTERCEPTOR for "Confirm & Save"
    modal.querySelector('#confirm-import').onclick = async () => {
        const allToggles = modal.querySelectorAll('.review-toggle-btn');
        const reviewedToggles = modal.querySelectorAll('.review-toggle-btn.is-reviewed');
        
        // If there are unreviewed items, trigger the warning
        if (reviewedToggles.length < allToggles.length) {
            const unreviewedCount = allToggles.length - reviewedToggles.length;
            const proceed = confirm(`⚠️ You have ${unreviewedCount} unreviewed item(s).\n\nAre you sure you want to save without reviewing them?`);
            if (!proceed) return; 
        }

        const btn = modal.querySelector('#confirm-import');
        btn.disabled = true;
        btn.textContent = 'Saving...';
        await confirmImport(modal, mapped, savePeriods, pdfBlobUrl);
    };
}
async function confirmImport(modal, mapped, periodsToSave, pdfBlobUrl = null) {
    const mappingDict   = {};
    const mappingChanges = [];  // { originalName, mappedTo, document, section }
    const valueChanges   = [];  // { field, year, from, to, document, section }

    // ── STEP 1: Process mapping selects ──────────────────────────────────
    modal.querySelectorAll('select.map-select').forEach(select => {
        const docType      = select.dataset.section;
        const sectionKey   = select.dataset.key;
        const originalItem = select.dataset.original;
        const mappedTo     = select.value === '__NEW__' ? originalItem : select.value;

        // Build mappingDict (needed for data writing below)
        if (!mappingDict[docType])             mappingDict[docType]             = {};
        if (!mappingDict[docType][sectionKey]) mappingDict[docType][sectionKey] = {};
        mappingDict[docType][sectionKey][originalItem] = mappedTo;

        // Record mapping changes for audit log
        if (mappedTo !== originalItem) {
            mappingChanges.push({
                originalName: originalItem,
                mappedTo:     mappedTo,
                document:     docType.toUpperCase(),
                section:      sectionKey
            });
        }
    });

    // ── STEP 2: Process value inputs & write data ─────────────────────────
    modal.querySelectorAll('input[data-item]').forEach(input => {
        const { section, key, item, period } = input.dataset;
        if (!periodsToSave.includes(period)) return;

        const originalVal = input.getAttribute('value');
        const val         = parseFloat(input.value) || 0;

        // Record value changes for audit log
        if (Number(originalVal) !== Number(val)) {
            valueChanges.push({
                field:    item,
                year:     period,
                from:     originalVal,
                to:       val,
                document: section.toUpperCase(),
                section:  key
            });
        }

        // Write data into fsaState
        const finalItemName = mappingDict[section]?.[key]?.[item];
        if (!finalItemName) return;

        if (!fsaState.currentFsaData.data[section])             fsaState.currentFsaData.data[section]             = {};
        if (!fsaState.currentFsaData.data[section][key])        fsaState.currentFsaData.data[section][key]        = {};
        if (!fsaState.currentFsaData.data[section][key][period]) fsaState.currentFsaData.data[section][key][period] = {};

        const existingVal = fsaState.currentFsaData.data[section][key][period][finalItemName] || 0;
        fsaState.currentFsaData.data[section][key][period][finalItemName] = existingVal + val;
    });

    // ── STEP 3: Fire structured audit logs ───────────────────────────────
    if (mappingChanges.length > 0) {
        // One log entry per mapped field — easier to read in logbook
        mappingChanges.forEach(m => {
            addAuditLog('Review — Mapped Field', JSON.stringify({
                'Original Name': m.originalName,
                'Mapped To':     m.mappedTo,
                'Document':      m.document,
                'Section':       m.section
            }));
        });
    }

    if (valueChanges.length > 0) {
        // One log entry per edited value
        valueChanges.forEach(v => {
            addAuditLog('Review — Value Edited', JSON.stringify({
                'Field':    v.field,
                'Year':     v.year,
                'From':     v.from,
                'To':       v.to,
                'Document': v.document,
                'Section':  v.section
            }));
        });
    }

    if (mappingChanges.length === 0 && valueChanges.length === 0) {
        addAuditLog('Review Completed', JSON.stringify({
            'File':    importedPdfFile?.name ?? 'unknown',
            'Periods': periodsToSave.join(', '),
            'Note':    'No manual mappings or value edits made'
        }));
    }

    // ── STEP 4: Update years list ─────────────────────────────────────────
    if (!fsaState.currentFsaData.years) fsaState.currentFsaData.years = [];
    periodsToSave.forEach(p => {
        if (!fsaState.currentFsaData.years.includes(p)) fsaState.currentFsaData.years.push(p);
    });

    // ── STEP 5: Save mapping template ────────────────────────────────────
    if (!fsaState.currentFsaData.mappingTemplate) fsaState.currentFsaData.mappingTemplate = {};
    Object.keys(mappingDict).forEach(docType => {
        if (!fsaState.currentFsaData.mappingTemplate[docType]) fsaState.currentFsaData.mappingTemplate[docType] = {};
        Object.keys(mappingDict[docType]).forEach(sectionKey => {
            if (!fsaState.currentFsaData.mappingTemplate[docType][sectionKey]) fsaState.currentFsaData.mappingTemplate[docType][sectionKey] = {};
            Object.keys(mappingDict[docType][sectionKey]).forEach(extractedItem => {
                const mappedTo = mappingDict[docType][sectionKey][extractedItem];
                if (mappedTo !== extractedItem) {
                    fsaState.currentFsaData.mappingTemplate[docType][sectionKey][extractedItem] = mappedTo;
                }
            });
        });
    });

    // ── STEP 6: Persist to Firestore ──────────────────────────────────────
    try {
        await updateDoc(
            doc(db, 'projects', currentProjectId, 'fsa', currentFsaId),
            {
                years:           fsaState.currentFsaData.years,
                data:            fsaState.currentFsaData.data,
                mappingTemplate: fsaState.currentFsaData.mappingTemplate
            }
        );
    } catch (e) {
        alert('Save failed: ' + e.message);
        return;
    }

    modal.remove();

    // ── STEP 7: Auto-save imported PDF as attachment ──────────────────────
    if (importedPdfFile) {
        const defaultName = importedPdfFile.name.replace(/\.pdf$/i, '');
        const name = prompt('Save this PDF as an attachment. Enter a name:', defaultName);
        if (name?.trim()) {
            try {
                const storageRef = ref(storage, `fsa-sources/${currentProjectId}/${currentFsaId}/${Date.now()}_${importedPdfFile.name}`);
                await uploadBytes(storageRef, importedPdfFile);
                const url = await getDownloadURL(storageRef);

                const docs = fsaState.currentFsaData.sourceDocuments || [];
                docs.push({ name: name.trim(), url, uploadedAt: Date.now() });
                fsaState.currentFsaData.sourceDocuments = docs;

                await updateDoc(
                    doc(db, 'projects', currentProjectId, 'fsa', currentFsaId),
                    { sourceDocuments: docs }
                );

                const reviewBtn = document.getElementById('review-mode-btn');
                if (reviewBtn) reviewBtn.style.display = 'inline-flex';
                if (typeof renderDocumentList === 'function') renderDocumentList();
            } catch (uploadErr) {
                console.warn('PDF attachment upload failed:', uploadErr.message);
            }
        }
        if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl);
        importedPdfFile = null;
    }

    // ── STEP 8: Re-render data entry tab ─────────────────────────────────
    const activeBtn = document.querySelector('.doc-tab-btn[style*="var(--brand-primary)"]') || document.querySelector('.doc-tab-btn');
    if (activeBtn) activeBtn.click();

    if (typeof renderNotesPanel === 'function') renderNotesPanel();
}


// ── NOTES PANEL ───────────────────────────────────────────────────────
function renderNotesPanel() {
    const area = document.getElementById("pdf-notes-area");
    const list = document.getElementById("pdf-notes-list");
    if (!area || !list) return;

    const allNoteGroups = fsaState.currentFsaData?.pdfNotes || [];
    if (allNoteGroups.length === 0) {
        area.style.display = "none";
        return;
    }

    let html = "";
    allNoteGroups.forEach(group => {
        if (!group.points || group.points.length === 0) return;
        html += `<li style="color:var(--text-muted); font-size:11px; margin-bottom:6px; list-style:none; margin-left:-18px; font-weight:600;">${group.source} (${(group.periods || []).join(", ")})</li>`;
        group.points.forEach(point => {
            html += `<li style="margin-bottom:8px; line-height:1.6; color:var(--text-main);">${point}</li>`;
        });
    });

    list.innerHTML = html;
    area.style.display = "block";
}

// ── CALCULATION WRAPPERS ──────────────────────────────────────────────
function updatePnLTotals() {
    (fsaState.currentFsaData.years || []).forEach(year => {
        const model = buildFinancialModel(fsaState.currentFsaData.data, year, fsaState.reclassMap, configSchemas);
        document.querySelectorAll(`[data-total-key][data-year="${year}"]`).forEach(el => {
            el.innerText = formatValue(el.dataset.totalKey, model[el.dataset.totalKey], configSchemas);
        });
    });
}

// Alias — both point to same logic
const updateBSTotals = updatePnLTotals;
