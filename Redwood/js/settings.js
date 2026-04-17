// settings.js
import { db, auth } from "./firebase.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
console.log("Enterprise settings.js loaded", db, auth);

// ── FIRESTORE HELPERS ─────────────────────────────────────────────
// Recursively removes undefined/NaN values and prevents nested arrays
// (Firestore rejects any array whose element is itself an array).
function sanitizeForFirestore(data) {
  if (Array.isArray(data)) {
    return data
      .map(el => sanitizeForFirestore(el))
      // Firestore does NOT support arrays as direct array elements.
      // Any element that is still an array after processing is corrupt
      // data — drop it rather than letting setDoc() throw.
      .filter(el => !Array.isArray(el));
  }
  if (data !== null && typeof data === 'object') {
    const result = {};
    for (const [key, val] of Object.entries(data)) {
      if (val !== undefined) result[key] = sanitizeForFirestore(val);
    }
    return result;
  }
  // Coerce NaN / Infinity to null so Firestore doesn't reject them.
  if (typeof data === 'number' && !isFinite(data)) return null;
  return data ?? null;
}

// Normalizes any value that should be an array: handles Object.values()
// fallback for Firestore documents that stored arrays as maps.
function normalizeArray(val) {
  if (Array.isArray(val)) return val;
  if (val && typeof val === 'object') return Object.values(val);
  return [];
}

// Convert a display name to a camelCase dataKey slug.
function slugify(str) {
  if (!str) return '';
  return str.trim()
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

// ── CORE STATE ────────────────────────────────────────────────────
let masterDomains    = [];
let entityTypes      = [];
let masterDocuments  = [];
let chartOfAccounts  = {};
let metricsFormulas  = [];
let dashboardConfig  = { kpis: [], charts: [] };
let customRatios     = [];

// ── NEW: Confidence Thresholds (saved to engineConfig) ────────────
let confidenceThresholds = { high: 85, medium: 60 };

// ── SINGLE SHARED TEMPLATE KEY ───────────────────────────────────
const SHARED_DOMAIN_ID = 'shared';

// UI State for Schema Builder
let currentDomainId           = SHARED_DOMAIN_ID;  // ← FIXED: was null
let currentDocId              = null;
let expandedSchemaSections    = new Set();
let schemaDragSrcIdx          = null;

// ── AUTH GUARD ───────────────────────────────────────────────────
let buttonsReady = false;

// ── SCHEMA BUILDER COLOR PALETTE (module-level constant) ─────────
const TOTAL_COLORS = [
  { color: '#10b981', bg: 'rgba(16,185,129,0.10)', label: 'Green'  },
  { color: '#6366f1', bg: 'rgba(99,102,241,0.10)',  label: 'Indigo' },
  { color: '#f59e0b', bg: 'rgba(245,158,11,0.10)',  label: 'Amber'  },
  { color: '#22c55e', bg: 'rgba(34,197,94,0.10)',   label: 'Lime'   },
  { color: '#3b82f6', bg: 'rgba(59,130,246,0.10)',  label: 'Blue'   },
  { color: '#a855f7', bg: 'rgba(168,85,247,0.10)',  label: 'Purple' },
  { color: '#ef4444', bg: 'rgba(239,68,68,0.10)',   label: 'Red'    },
  { color: '#06b6d4', bg: 'rgba(6,182,212,0.10)',   label: 'Cyan'   },
];

// ── TAB NAVIGATION ───────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.settings-panel-page').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const target = document.getElementById(btn.dataset.tab);
    if (target) target.classList.add('active');
  });
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    setTimeout(() => { if (!auth.currentUser) window.location.href = "login.html"; }, 2000);
    return;
  }
  if (buttonsReady) return;
  buttonsReady = true;
  await loadAll();
  setupButtons();
});

// ── DYNAMIC METRICS GENERATOR ────────────────────────────────────
function getAvailableMetrics() {
  let opts = [];
  Object.values(chartOfAccounts).forEach(domainDocs => {
    Object.values(domainDocs).forEach(sections => {
      if (!Array.isArray(sections)) return;
      sections.forEach(s => {
        if (s.key && !opts.find(o => o.key === s.key))
          opts.push({ key: s.key, label: s.title || s.key });
        // Also include inline section total keys
        if (s.type === 'section' && Array.isArray(s.totals)) {
          s.totals.forEach(t => {
            if (t.key && !opts.find(o => o.key === t.key))
              opts.push({ key: t.key, label: t.title || t.key });
          });
        }
      });
    });
  });

  const standard = [
    { key: "revenue",     label: "Revenue" },
    { key: "directCosts", label: "Direct Costs" },
    { key: "grossProfit", label: "Gross Profit" },
    { key: "ebitda",      label: "EBITDA" },
    { key: "eat",         label: "EAT (Net Profit)" },
    { key: "totalAssets", label: "Total Assets" },
    { key: "equity",      label: "Equity" },
    { key: "totalLE",     label: "Total Liab. & Equity" }
  ];
  standard.forEach(std => { if (!opts.find(o => o.key === std.key)) opts.push(std); });
  metricsFormulas.forEach(m => { if (m.key) opts.push({ key: m.key, label: m.label }); });
  customRatios.forEach(r => {
    if (r.key) opts.push({ key: r.key.startsWith('cr__') ? r.key : `cr__${r.key}`, label: r.label });
  });
  return opts;
}

// ── LOAD & MIGRATE ───────────────────────────────────────────────
async function loadAll() {
  const [domSnap, entSnap, engineSnap, dashSnap, analysisSnap] = await Promise.all([
    getDoc(doc(db, "workspace-config", "domainTemplates")),
    getDoc(doc(db, "workspace-config", "entityTypes")),
    getDoc(doc(db, "workspace-config", "engineConfig")),
    getDoc(doc(db, "workspace-config", "dashboardConfig")),
    getDoc(doc(db, "workspace-config", "analysisConfig"))
  ]);

  const domData = domSnap.data();

  if (domData && domData.templates && !domData.domains) {
    console.log("Migrating old schema to Enterprise architecture...");
    masterDomains   = domData.templates.map((t, i) => ({ id: t.key || `dom_${i}`, label: t.label }));
    masterDocuments = [
      { id: 'pnl',      title: 'Profit & Loss',  key: 'pnl'      },
      { id: 'bs',       title: 'Balance Sheet',   key: 'bs'       },
      { id: 'cashflow', title: 'Cash Flow',        key: 'cashflow' }
    ];
    chartOfAccounts = {};
    domData.templates.forEach((t, i) => {
      const dId = masterDomains[i].id;
      chartOfAccounts[dId] = { pnl: t.pnl || [], bs: t.bs || [], cashflow: t.cf || [] };
    });
  } else if (domData) {
    masterDomains   = domData.domains         || [];
    masterDocuments = domData.documents       || [];
    chartOfAccounts = domData.chartOfAccounts || {};
  }

  // ── FIXED: Single-template normalization — ensure 'shared' key always exists ──
  if (!chartOfAccounts[SHARED_DOMAIN_ID]) {
    // Migrate data from the first existing domain key into 'shared' if present
    const firstKey = Object.keys(chartOfAccounts).find(k => k !== SHARED_DOMAIN_ID);
    chartOfAccounts[SHARED_DOMAIN_ID] = firstKey ? chartOfAccounts[firstKey] : {};
  }
  // Ensure every document type has an array under 'shared', migrating from
  // key-based or other-domain storage to id-based storage where necessary
  // so the schema builder and fsa.js always find data via the document's id.
  masterDocuments.forEach(d => {
    const idEntry  = chartOfAccounts[SHARED_DOMAIN_ID][d.id];
    const keyEntry = (d.key && d.key !== d.id)
      ? chartOfAccounts[SHARED_DOMAIN_ID][d.key]
      : null;

    // Guard: treat idEntry as "empty" when it is falsy, not an array, or an
    // empty array — all mean "no usable data is stored here yet".
    if (!idEntry || !(Array.isArray(idEntry) && idEntry.length > 0)) {
      // 1. Prefer key-based data in the shared domain (id≠key migration case)
      if (Array.isArray(keyEntry) && keyEntry.length > 0) {
        chartOfAccounts[SHARED_DOMAIN_ID][d.id] = keyEntry;
      } else {
        // 2. Search ALL other domain buckets for any non-empty data for this
        //    document (by id or by key) — recovers data from old-format saves
        //    where chartOfAccounts was keyed by domain rather than 'shared'.
        let found = null;
        for (const domainKey of Object.keys(chartOfAccounts)) {
          if (domainKey === SHARED_DOMAIN_ID) continue;
          const domBucket = chartOfAccounts[domainKey];
          if (!domBucket || typeof domBucket !== 'object') continue;
          if (Array.isArray(domBucket[d.id]) && domBucket[d.id].length > 0) {
            found = domBucket[d.id]; break;
          }
          if (d.key && Array.isArray(domBucket[d.key]) && domBucket[d.key].length > 0) {
            found = domBucket[d.key]; break;
          }
        }
        if (found) {
          chartOfAccounts[SHARED_DOMAIN_ID][d.id] = found;
        } else if (!idEntry) {
          // Only create an empty placeholder when there is NO entry at all
          // (not when it is already an empty array — avoid double-init).
          chartOfAccounts[SHARED_DOMAIN_ID][d.id] = [];
        }
      }
    } else if (Array.isArray(keyEntry) && keyEntry.length > 0) {
      // idEntry has sections but check if all items are empty — if so, merge
      // line items from the key-based entry (items stored under the old key).
      const hasAnyItems = idEntry.some(s => Array.isArray(s.items) && s.items.length > 0);
      if (!hasAnyItems) {
        const keyItemsMap = {};
        keyEntry.forEach(s => { if (s.key) keyItemsMap[s.key] = s.items || []; });
        idEntry.forEach(s => {
          if (s.key && Array.isArray(keyItemsMap[s.key]) && keyItemsMap[s.key].length > 0 &&
              (!Array.isArray(s.items) || s.items.length === 0)) {
            s.items = keyItemsMap[s.key];
          }
        });
      }
    }
  });
  currentDomainId = SHARED_DOMAIN_ID;

  // Deep migration: normalize to full 3-level structure
  // section → items[{ name, dataKey, subItems[{ name, dataKey }] }] + totals[]
  Object.keys(chartOfAccounts).forEach(dId => {
    const domainDoc = chartOfAccounts[dId];
    if (!domainDoc || typeof domainDoc !== 'object') return;
    Object.keys(domainDoc).forEach(docId => {
      const raw = domainDoc[docId];
      // Handle object-as-array from Firestore
      const sections = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
      domainDoc[docId] = sections
        // Skip any element that is itself an array (corrupt / nested-array data from
        // a previous merge-based save) — returning it would produce a nested array
        // that Firestore rejects.
        .filter(section => section && typeof section === 'object' && !Array.isArray(section))
        .map(section => {

          if (!section.type) section.type = 'section';

          if (section.type === 'section') {
            // Ensure items array
            const rawItems = Array.isArray(section.items)
              ? section.items
              : (section.items && typeof section.items === 'object' ? Object.values(section.items) : []);

            section.items = rawItems
              .filter(iObj => iObj !== null && iObj !== undefined)
              .map(iObj => {
                // Flat string → item object
                if (typeof iObj === 'string') return { name: iObj, dataKey: slugify(iObj), subItems: [] };

                // Skip corrupt array items
                if (Array.isArray(iObj)) return null;

                // Normalize subItems
                const rawSub = Array.isArray(iObj.subItems)
                  ? iObj.subItems
                  : (iObj.subItems && typeof iObj.subItems === 'object' ? Object.values(iObj.subItems) : []);

                const subItems = rawSub
                  .filter(sub => sub !== null && sub !== undefined && !Array.isArray(sub))
                  .map(sub => {
                    if (typeof sub === 'string') return { name: sub, dataKey: slugify(sub) };
                    return { name: sub.name || '', dataKey: sub.dataKey || slugify(sub.name || '') };
                  });

                return {
                  name:    iObj.name    || '',
                  dataKey: iObj.dataKey || slugify(iObj.name || ''),
                  subItems
                };
              })
              .filter(Boolean); // remove nulls produced by skipped corrupt items

            // Ensure inline totals array
            const rawTotals = Array.isArray(section.totals)
              ? section.totals
              : (section.totals && typeof section.totals === 'object' ? Object.values(section.totals) : []);

            section.totals = rawTotals
              .filter(t => t && typeof t === 'object' && !Array.isArray(t))
              .map(t => ({
                title:   t.title   || '',
                key:     t.key     || '',
                formula: t.formula || '',
                color:   t.color   || '#6366f1',
                bg:      t.bg      || 'rgba(99,102,241,0.10)'
              }));
          }

          return section;
        });
    });
  });

  // All list state is normalised through normalizeArray() to handle the case
  // where Firestore stored an array as a keyed object (due to old merge: true saves).
  entityTypes      = normalizeArray(entSnap.data()?.types);
  metricsFormulas  = normalizeArray(engineSnap.data()?.metrics);
  dashboardConfig  = dashSnap.data()                   || { kpis: [], charts: [] };
  customRatios     = normalizeArray(analysisSnap.data()?.customRatios);
  confidenceThresholds = engineSnap.data()?.confidenceThresholds || { high: 85, medium: 60 };
  masterDomains    = normalizeArray(masterDomains);
  masterDocuments  = normalizeArray(masterDocuments);

  renderMasterDomains();
  renderMasterEntities();
  renderMasterDocuments();
  updateSchemaDropdowns();
  renderSchemaBuilder();
  renderMetricsFormulas();
  renderConfidenceThresholds();
  renderDashboardConfig();
  renderCustomRatios();
}

// ── 1. MASTER DOMAINS ─────────────────────────────────────────────
function renderMasterDomains() {
  const container = document.getElementById("master-domains-container");
  container.innerHTML = masterDomains.map((d, i) => `
    <div class="enterprise-row">
      <div style="flex:1;">
        <input class="enterprise-input" value="${d.label}"
               placeholder="Domain Name (e.g., Manufacturing)"
               oninput="updateDomainLabel(${i}, this.value)" />
      </div>
      <button class="btn-danger" onclick="removeDomain(${i})">✕ Delete</button>
    </div>
  `).join("") || '<div class="field-description">No domains added yet.</div>';
}

window.addDomain         = () => { masterDomains.push({ id: `dom_${Date.now()}`, label: "New Domain" }); renderMasterDomains(); updateSchemaDropdowns(); };
window.updateDomainLabel = (i, val) => { masterDomains[i].label = val; updateSchemaDropdowns(); };
window.removeDomain      = (i) => { const dId = masterDomains[i].id; delete chartOfAccounts[dId]; masterDomains.splice(i, 1); renderMasterDomains(); updateSchemaDropdowns(); };

// ── 2. MASTER ENTITIES ────────────────────────────────────────────
function renderMasterEntities() {
  const container = document.getElementById("master-entities-container");
  container.innerHTML = entityTypes.map((e, ei) => `
    <div class="settings-section" style="background:rgba(0,0,0,0.2); border:1px solid var(--border-subtle); margin-bottom:16px;">
      <div style="padding:16px; border-bottom:1px solid var(--border-subtle); display:flex; gap:12px; align-items:center;">
        <input class="enterprise-input" value="${e.label}" placeholder="Entity Label (e.g., LLC)"
               oninput="updateEntityLabel(${ei},this.value)" style="max-width:300px;" />
        <button class="btn-danger" onclick="removeEntity(${ei})">✕ Delete Entity</button>
      </div>
      <div style="padding:16px;">
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:1px; margin-bottom:12px; font-weight:700;">Specific Equity Line Items</div>
        ${e.equityItems.map((item, ii) => `
          <div style="display:flex; gap:8px; margin-bottom:8px;">
            <input class="enterprise-input" value="${item}" placeholder="Equity Item (e.g., Retained Earnings)"
                   oninput="updateEquityItem(${ei},${ii},this.value)" />
            <button class="btn-danger" onclick="removeEquityItem(${ei},${ii})">✕</button>
          </div>
        `).join("")}
        <button class="btn-secondary" style="margin-top:8px; font-size:11px; padding:6px 12px;"
                onclick="addEquityItem(${ei})">+ Add Equity Item</button>
      </div>
    </div>
  `).join("") || '<div class="field-description">No entities added yet.</div>';
}

window.addEntity         = () => { entityTypes.push({ key: `ent_${Date.now()}`, label: "New Entity", equityItems: [] }); renderMasterEntities(); };
window.updateEntityLabel = (ei, val) => { entityTypes[ei].label = val; };
window.removeEntity      = (ei) => { entityTypes.splice(ei, 1); renderMasterEntities(); };
window.addEquityItem     = (ei) => { entityTypes[ei].equityItems.push(""); renderMasterEntities(); };
window.updateEquityItem  = (ei, ii, val) => { entityTypes[ei].equityItems[ii] = val; };
window.removeEquityItem  = (ei, ii) => { entityTypes[ei].equityItems.splice(ii, 1); renderMasterEntities(); };

// ── 3. MASTER DOCUMENTS ───────────────────────────────────────────
function renderMasterDocuments() {
  const container = document.getElementById("master-documents-container");
  container.innerHTML = masterDocuments.map((doc, i) => `
    <div class="enterprise-row">
      <div style="flex:2;">
        <input class="enterprise-input" value="${doc.title}" placeholder="Document Title (e.g., Cash Flow)"
               oninput="updateDocumentTitle(${i}, this.value)" />
      </div>
      <div style="flex:1;">
        <input class="enterprise-input" value="${doc.key}" placeholder="Data Key (e.g., cashflow)"
               style="font-family:monospace;" oninput="updateDocumentKey(${i}, this.value)" />
      </div>
      <button class="btn-danger" onclick="removeDocument(${i})">✕ Delete</button>
    </div>
  `).join("") || '<div class="field-description">No documents added yet.</div>';
}

window.addDocumentType     = () => { masterDocuments.push({ id: `doc_${Date.now()}`, title: "New Document", key: "new_doc" }); renderMasterDocuments(); updateSchemaDropdowns(); };
window.updateDocumentTitle = (i, val) => { masterDocuments[i].title = val; updateSchemaDropdowns(); };
window.updateDocumentKey   = (i, val) => { masterDocuments[i].key = val; };
window.removeDocument      = (i) => {
  const d = masterDocuments[i];
  Object.keys(chartOfAccounts).forEach(dKey => {
    delete chartOfAccounts[dKey][d.id];
    // Also remove any legacy key-based entry so stale data doesn't linger
    if (d.key && d.key !== d.id) delete chartOfAccounts[dKey][d.key];
  });
  masterDocuments.splice(i, 1);
  renderMasterDocuments();
  updateSchemaDropdowns();
};

// ── 4. CHART OF ACCOUNTS BUILDER ─────────────────────────────────
// FIXED: removed domain-select dependency — single shared template
function updateSchemaDropdowns() {
  const docSel = document.getElementById("schema-document-select");
  if (!docSel) return;
  const prevDoc = docSel.value;

  docSel.innerHTML = masterDocuments.length
    ? masterDocuments.map(d => `<option value="${d.id}">${d.title}</option>`).join("")
    : '<option value="">Add a Document First</option>';

  if (masterDocuments.find(d => d.id === prevDoc)) docSel.value = prevDoc;

  handleSchemaDropdownChange();
}

// FIXED: always uses SHARED_DOMAIN_ID — no domain dropdown needed
function handleSchemaDropdownChange() {
  currentDomainId = SHARED_DOMAIN_ID;
  currentDocId    = document.getElementById("schema-document-select")?.value || '';
  expandedSchemaSections.clear();

  if (currentDocId) {
    if (!chartOfAccounts[currentDomainId]) chartOfAccounts[currentDomainId] = {};

    const docDef  = masterDocuments.find(d => d.id === currentDocId);
    const idEntry = chartOfAccounts[currentDomainId][currentDocId];

    if (!idEntry || !(Array.isArray(idEntry) && idEntry.length > 0)) {
      // 1. Try key-based entry in the shared domain (id≠key case)
      if (docDef && docDef.key && docDef.key !== currentDocId) {
        const keyEntry = chartOfAccounts[currentDomainId][docDef.key];
        if (Array.isArray(keyEntry) && keyEntry.length > 0) {
          chartOfAccounts[currentDomainId][currentDocId] = keyEntry;
        }
      }
      // 2. If still empty/absent, search all other domain buckets
      const cur = chartOfAccounts[currentDomainId][currentDocId];
      if (!cur || !(Array.isArray(cur) && cur.length > 0)) {
        for (const domainKey of Object.keys(chartOfAccounts)) {
          if (domainKey === currentDomainId) continue;
          const domBucket = chartOfAccounts[domainKey];
          if (!domBucket || typeof domBucket !== 'object') continue;
          if (Array.isArray(domBucket[currentDocId]) && domBucket[currentDocId].length > 0) {
            chartOfAccounts[currentDomainId][currentDocId] = domBucket[currentDocId]; break;
          }
          if (docDef && docDef.key &&
              Array.isArray(domBucket[docDef.key]) && domBucket[docDef.key].length > 0) {
            chartOfAccounts[currentDomainId][currentDocId] = domBucket[docDef.key]; break;
          }
        }
      }
    } else if (docDef && docDef.key && docDef.key !== currentDocId) {
      // idEntry has sections — check if all items are empty and key-based entry has items.
      const keyEntry = chartOfAccounts[currentDomainId][docDef.key];
      if (Array.isArray(keyEntry) && keyEntry.length > 0) {
        const hasAnyItems = idEntry.some(s => Array.isArray(s.items) && s.items.length > 0);
        if (!hasAnyItems) {
          const keyItemsMap = {};
          keyEntry.forEach(s => { if (s.key) keyItemsMap[s.key] = s.items || []; });
          idEntry.forEach(s => {
            if (s.key && Array.isArray(keyItemsMap[s.key]) && keyItemsMap[s.key].length > 0 &&
                (!Array.isArray(s.items) || s.items.length === 0)) {
              s.items = keyItemsMap[s.key];
            }
          });
        }
      }
    }

    if (!chartOfAccounts[currentDomainId][currentDocId]) {
      chartOfAccounts[currentDomainId][currentDocId] = [];
    }
  }
  renderSchemaBuilder();
}

function renderSchemaBuilder() {
  const container = document.getElementById("schema-builder-container");

  // FIXED: only check currentDocId now — currentDomainId is always valid
  if (!currentDocId) {
    container.innerHTML = '<div class="field-description" style="color:var(--status-danger);">Please select a Document Type above.</div>';
    return;
  }

  const sections = chartOfAccounts[currentDomainId][currentDocId];

  if (!sections.length) {
    container.innerHTML = '<div class="field-description">No elements defined for this Chart of Accounts yet. Use the buttons below to add a Section or a Total Row.</div>';
    return;
  }

  const totalColors = TOTAL_COLORS;

  container.innerHTML = sections.map((s, si) => {
    const isTotal  = s.type === 'total';
    const expanded = expandedSchemaSections.has(si);
    const cardBorder = isTotal
      ? `border-left: 4px solid ${s.color || '#6366f1'}; border-color: ${s.color || '#6366f1'}40;`
      : 'border-left: 4px solid #334155;';
    const cardBg = isTotal
      ? `background: ${s.bg || 'rgba(99,102,241,0.06)'};`
      : 'background: rgba(15,23,42,0.4);';

    return `
    <div class="sb-card" data-si="${si}" draggable="true"
         style="${cardBg} ${cardBorder} border-top:1px solid var(--border-subtle);
                border-right:1px solid var(--border-subtle); border-bottom:1px solid var(--border-subtle);
                border-radius:8px; margin-bottom:12px; padding:14px 16px;
                transition: opacity 0.15s, transform 0.15s; cursor:default;"
         ondragstart="schemaDragStart(event,${si})"
         ondragover="schemaDragOver(event)"
         ondrop="schemaDrop(event,${si})"
         ondragend="schemaDragEnd(event)">

      <div style="display:flex; gap:10px; align-items:center;">
        <span style="cursor:grab; color:var(--text-muted); font-size:16px; padding:0 4px; user-select:none;"
              title="Drag to reorder">⠿</span>

        <span style="font-size:10px; font-weight:800; letter-spacing:1px; padding:3px 8px; border-radius:20px;
                     ${isTotal
                       ? `background:${s.color || '#6366f1'}22; color:${s.color || '#6366f1'}; border:1px solid ${s.color || '#6366f1'}44;`
                       : 'background:rgba(255,255,255,0.05); color:var(--text-muted); border:1px solid var(--border-subtle);'}">
          ${isTotal ? '∑ TOTAL' : '§ SECTION'}
        </span>

        <input class="enterprise-input" value="${escHtml(s.title)}" placeholder="${isTotal ? 'Total Name (e.g. Gross Profit)' : 'Section Name (e.g. Revenue)'}"
               style="flex:2; font-weight:${isTotal ? '700' : '600'}; ${isTotal ? `color:${s.color || '#a5b4fc'};` : ''}"
               oninput="updateSchemaSectionTitle(${si}, this.value)" />

        <input class="enterprise-input" value="${escHtml(s.key)}" placeholder="key (e.g. grossProfit)"
               style="flex:1; font-family:monospace; font-size:12px;"
               oninput="updateSchemaSectionKey(${si}, this.value)" />

        ${!isTotal ? `
        <button class="btn-secondary" onclick="toggleSchemaItems(${si})"
                style="padding:8px 12px; font-size:11px; white-space:nowrap;">
          ${expanded ? 'Items ▴' : 'Items ▾'}
        </button>` : ''}

        <button class="btn-secondary"
                onclick="toggleSectionType(${si})"
                style="padding:8px 12px; font-size:11px; white-space:nowrap;"
                title="${isTotal ? 'Convert to Section (data entry)' : 'Convert to Total Row (calculated)'}">
          ${isTotal ? '→ Section' : '→ Total'}
        </button>

        <button class="btn-danger" onclick="removeSchemaSection(${si})" style="padding:8px 12px;">✕</button>
      </div>

      ${isTotal ? `
      <div style="margin-top:12px; padding:12px; background:rgba(0,0,0,0.2);
                  border:1px solid var(--border-subtle); border-radius:8px;">
        <div style="display:flex; gap:12px; align-items:flex-start; flex-wrap:wrap;">
          <div style="flex:2; min-width:220px;">
            <label style="font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:1px;
                           color:var(--text-muted); display:block; margin-bottom:6px;">
              Formula <span style="color:#6366f1; font-style:normal;">— use section keys e.g. revenue - directCosts</span>
            </label>
            <input class="enterprise-input"
                   value="${escHtml(s.formula || '')}"
                   placeholder="e.g. revenue - directCosts"
                   style="font-family:monospace; color:#a5b4fc;"
                   oninput="updateSchemaTotalFormula(${si}, this.value)" />
            <div style="font-size:10px; color:var(--text-muted); margin-top:6px;">
              Use section keys (camelCase). Operators: + − * /
              <br>Examples: <code style="color:#a5b4fc;">revenue - directCosts</code> &nbsp;
              <code style="color:#a5b4fc;">grossProfit - employeeCosts - otherIndirectCosts</code>
            </div>
          </div>
          <div style="flex:1; min-width:160px;">
            <label style="font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:1px;
                           color:var(--text-muted); display:block; margin-bottom:6px;">Highlight Colour</label>
            <select class="enterprise-input" onchange="updateSchemaTotalColor(${si}, this.value)"
                    style="font-size:12px;">
              ${totalColors.map(c => `
                <option value="${c.color}|${c.bg}" ${(s.color === c.color) ? 'selected' : ''}>
                  ${c.label} (${c.color})
                </option>`).join('')}
            </select>
          </div>
        </div>
      </div>` : `
      <div id="schema-items-${si}"
           style="display:${expanded ? 'block' : 'none'};
                  padding-left:20px; border-left:2px solid var(--border-subtle); margin-top:12px;">
        <div style="font-size:10px; text-transform:uppercase; letter-spacing:1px;
                    color:var(--text-muted); margin-bottom:10px; font-weight:700;">
          Line Items (appear in data entry dropdown)
        </div>
        ${(s.items || []).map((itemObj, ii) => `
          <div style="margin-bottom:10px; padding:10px; background:rgba(0,0,0,0.2);
                      border:1px dashed var(--border-subtle); border-radius:6px;">
            <div style="display:flex; gap:8px; margin-bottom:6px; align-items:center;">
              <input class="enterprise-input" value="${escHtml(itemObj.name)}"
                     placeholder="Line Item Name (e.g. Sales)"
                     oninput="updateSchemaItemName(${si}, ${ii}, this.value)"
                     style="flex:2; font-weight:600;" />
              <input class="enterprise-input" value="${escHtml(itemObj.dataKey || '')}"
                     placeholder="dataKey (e.g. productSales)"
                     style="flex:1; font-family:monospace; font-size:11px; color:#a5b4fc;"
                     oninput="updateSchemaItemDataKey(${si}, ${ii}, this.value)"
                     title="Used in formulas to reference this item. Auto-generated from name." />
              <button class="btn-danger" onclick="removeSchemaItem(${si}, ${ii})">✕</button>
            </div>
            <div style="padding-left:14px; border-left:2px solid rgba(99,102,241,0.3); margin-top:6px;">
              ${(itemObj.subItems || []).map((subItem, ssi) => `
                <div style="display:flex; gap:8px; margin-bottom:6px; align-items:center;">
                  <input class="enterprise-input" style="padding:6px 10px; font-size:12px; flex:2;"
                         value="${escHtml(typeof subItem === 'string' ? subItem : (subItem.name || ''))}"
                         placeholder="Sub-item name"
                         oninput="updateSchemaSubItemName(${si}, ${ii}, ${ssi}, this.value)" />
                  <input class="enterprise-input" style="padding:6px 10px; font-size:11px; flex:1; font-family:monospace; color:#a5b4fc;"
                         value="${escHtml(typeof subItem === 'string' ? '' : (subItem.dataKey || ''))}"
                         placeholder="dataKey"
                         oninput="updateSchemaSubItemDataKey(${si}, ${ii}, ${ssi}, this.value)"
                         title="Used in formulas to reference this sub-item." />
                  <button class="btn-danger" style="padding:4px 8px;"
                          onclick="removeSchemaSubItem(${si}, ${ii}, ${ssi})">✕</button>
                </div>
              `).join('')}
              <button class="btn-secondary" style="font-size:10px; padding:4px 10px; margin-top:2px;"
                      onclick="addSchemaSubItem(${si}, ${ii})">+ Sub-item</button>
            </div>
          </div>
        `).join('')}
        <button class="btn-secondary" style="font-size:11px; padding:6px 12px; margin-top:6px;"
                onclick="addSchemaItem(${si})">+ Add Line Item</button>

        <!-- ── INLINE SECTION TOTALS ── -->
        <div style="margin-top:16px; padding-top:12px; border-top:1px dashed rgba(99,102,241,0.3);">
          <div style="font-size:10px; text-transform:uppercase; letter-spacing:1px;
                      color:#a5b4fc; margin-bottom:10px; font-weight:700;">
            ∑ Section Total Rows (multiple allowed)
          </div>
          ${(s.totals || []).map((t, ti) => `
            <div style="margin-bottom:10px; padding:10px; background:rgba(99,102,241,0.06);
                        border:1px solid rgba(99,102,241,0.2); border-radius:6px;">
              <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
                <input class="enterprise-input" value="${escHtml(t.title)}"
                       placeholder="Total Name (e.g. Total Products)"
                       style="flex:2; font-weight:600; color:#a5b4fc;"
                       oninput="updateSectionInlineTotalTitle(${si}, ${ti}, this.value)" />
                <input class="enterprise-input" value="${escHtml(t.key)}"
                       placeholder="key (camelCase)"
                       style="flex:1; font-family:monospace; font-size:11px;"
                       oninput="updateSectionInlineTotalKey(${si}, ${ti}, this.value)" />
                <button class="btn-danger" onclick="removeSectionInlineTotal(${si}, ${ti})">✕</button>
              </div>
              <input class="enterprise-input"
                     value="${escHtml(t.formula || '')}"
                     placeholder="Formula — use section or item dataKeys (e.g. productSales + serviceRevenue)"
                     style="font-family:monospace; color:#a5b4fc; margin-bottom:8px;"
                     oninput="updateSectionInlineTotalFormula(${si}, ${ti}, this.value)" />
              <select class="enterprise-input" style="font-size:12px;"
                      onchange="updateSectionInlineTotalColor(${si}, ${ti}, this.value)">
                ${totalColors.map(c => `
                  <option value="${c.color}|${c.bg}" ${(t.color === c.color) ? 'selected' : ''}>
                    ${c.label} (${c.color})
                  </option>`).join('')}
              </select>
            </div>
          `).join('')}
          <button class="btn-secondary" style="font-size:10px; padding:5px 12px; margin-top:2px;"
                  onclick="addSectionInlineTotal(${si})">+ Add Total Row</button>
        </div>
      </div>`}
    </div>`;
  }).join('');

  attachSchemaDragListeners();
}

// ── Schema drag-and-drop ──────────────────────────────────────────
function attachSchemaDragListeners() {
  document.querySelectorAll('.sb-card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      schemaDragSrcIdx = parseInt(card.dataset.si);
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => card.style.opacity = '0.4', 0);
    });
    card.addEventListener('dragend',  () => { card.style.opacity = '1'; });
    card.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; card.style.transform = 'scale(1.01)'; });
    card.addEventListener('dragleave',() => { card.style.transform = ''; });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.style.transform = '';
      const targetIdx = parseInt(card.dataset.si);
      if (schemaDragSrcIdx === null || schemaDragSrcIdx === targetIdx) return;
      const sections = chartOfAccounts[currentDomainId][currentDocId];
      const moved = sections.splice(schemaDragSrcIdx, 1)[0];
      sections.splice(targetIdx, 0, moved);
      expandedSchemaSections.clear();
      schemaDragSrcIdx = null;
      renderSchemaBuilder();
    });
  });
}

window.schemaDragStart = (e, si)       => { schemaDragSrcIdx = si; e.dataTransfer.effectAllowed = 'move'; };
window.schemaDragOver = (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  // ── Auto-scroll logic ──
  // The top needs a higher threshold to bypass the 104px fixed headers
  const topScrollThreshold = 160; 
  const bottomScrollThreshold = 100;
  const scrollSpeed = 20;

  // If mouse is near the top of the visible content area, scroll up
  if (e.clientY < topScrollThreshold) {
    window.scrollBy(0, -scrollSpeed);
  } 
  // If mouse is near the bottom of the viewport, scroll down
  else if (window.innerHeight - e.clientY < bottomScrollThreshold) {
    window.scrollBy(0, scrollSpeed);
  }
};
window.schemaDragEnd   = (e)           => { e.target.closest?.('.sb-card') && (e.target.closest('.sb-card').style.opacity = '1'); };
window.schemaDrop      = (e, targetIdx) => {
  e.preventDefault();
  if (schemaDragSrcIdx === null || schemaDragSrcIdx === targetIdx) return;
  const sections = chartOfAccounts[currentDomainId][currentDocId];
  const moved = sections.splice(schemaDragSrcIdx, 1)[0];
  sections.splice(targetIdx, 0, moved);
  expandedSchemaSections.clear();
  schemaDragSrcIdx = null;
  renderSchemaBuilder();
};

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

window.addSchemaSection = () => {
  if (!currentDomainId || !currentDocId) return;
  const ts = Date.now();
  chartOfAccounts[currentDomainId][currentDocId].push({ type: 'section', title: 'New Section', key: `section_${ts}`, items: [], totals: [] });
  const newIdx = chartOfAccounts[currentDomainId][currentDocId].length - 1;
  expandedSchemaSections.add(newIdx);
  renderSchemaBuilder();
};

window.addSchemaTotalRow = () => {
  if (!currentDomainId || !currentDocId) return;
  const ts = Date.now();
  chartOfAccounts[currentDomainId][currentDocId].push({
    type: 'total', title: 'New Total', key: `total_${ts}`, formula: '', color: '#6366f1', bg: 'rgba(99,102,241,0.10)'
  });
  renderSchemaBuilder();
};

window.toggleSectionType = (si) => {
  const section = chartOfAccounts[currentDomainId][currentDocId][si];
  if (section.type === 'total') {
    section.type = 'section';
    delete section.formula;
    if (!section.items) section.items = [];
    if (!section.totals) section.totals = [];
    expandedSchemaSections.add(si);
  } else {
    section.type  = 'total';
    section.color = section.color || '#6366f1';
    section.bg    = section.bg    || 'rgba(99,102,241,0.10)';
    if (!section.formula) section.formula = '';
    expandedSchemaSections.delete(si);
  }
  renderSchemaBuilder();
};

window.removeSchemaSection      = (si)       => { chartOfAccounts[currentDomainId][currentDocId].splice(si, 1); expandedSchemaSections.delete(si); renderSchemaBuilder(); };
window.updateSchemaSectionTitle = (si, val)  => { chartOfAccounts[currentDomainId][currentDocId][si].title   = val; };
window.updateSchemaSectionKey   = (si, val)  => { chartOfAccounts[currentDomainId][currentDocId][si].key     = val; };
window.updateSchemaTotalFormula = (si, val)  => { chartOfAccounts[currentDomainId][currentDocId][si].formula = val; };
window.updateSchemaTotalColor   = (si, val)  => {
  const [color, bg] = val.split('|');
  chartOfAccounts[currentDomainId][currentDocId][si].color = color;
  chartOfAccounts[currentDomainId][currentDocId][si].bg    = bg;
};

// ── Line Item functions (with dataKey) ───────────────────────────────
window.addSchemaItem = (si) => {
  chartOfAccounts[currentDomainId][currentDocId][si].items.push({ name: '', dataKey: '', subItems: [] });
  renderSchemaBuilder();
};
window.removeSchemaItem      = (si, ii)       => { chartOfAccounts[currentDomainId][currentDocId][si].items.splice(ii, 1); renderSchemaBuilder(); };
window.updateSchemaItemName  = (si, ii, val)  => {
  const item = chartOfAccounts[currentDomainId][currentDocId][si].items[ii];
  item.name = val;
  // Auto-populate dataKey if it is still empty
  if (!item.dataKey) item.dataKey = slugify(val);
};
window.updateSchemaItemDataKey = (si, ii, val) => {
  chartOfAccounts[currentDomainId][currentDocId][si].items[ii].dataKey = val;
};
// Keep backward compat alias
window.updateSchemaItem = window.updateSchemaItemName;

// ── Sub-Item functions (with dataKey) ────────────────────────────────
window.addSchemaSubItem = (si, ii) => {
  const item = chartOfAccounts[currentDomainId][currentDocId][si].items[ii];
  if (!item.subItems) item.subItems = [];
  item.subItems.push({ name: '', dataKey: '' });
  renderSchemaBuilder();
};
window.removeSchemaSubItem = (si, ii, ssi) => {
  chartOfAccounts[currentDomainId][currentDocId][si].items[ii].subItems.splice(ssi, 1);
  renderSchemaBuilder();
};
window.updateSchemaSubItemName = (si, ii, ssi, val) => {
  const sub = chartOfAccounts[currentDomainId][currentDocId][si].items[ii].subItems[ssi];
  if (typeof sub === 'string') {
    chartOfAccounts[currentDomainId][currentDocId][si].items[ii].subItems[ssi] = { name: val, dataKey: slugify(val) };
  } else {
    sub.name = val;
    if (!sub.dataKey) sub.dataKey = slugify(val);
  }
};       
window.updateSchemaSubItemDataKey = (si, ii, ssi, val) => {
  const sub = chartOfAccounts[currentDomainId][currentDocId][si].items[ii].subItems[ssi];
  if (typeof sub === 'string') {
    chartOfAccounts[currentDomainId][currentDocId][si].items[ii].subItems[ssi] = { name: sub, dataKey: val };
  } else {
    sub.dataKey = val;
  }
};
// Keep backward compat alias
window.updateSchemaSubItem = (si, ii, ssi, val) => window.updateSchemaSubItemName(si, ii, ssi, val);

window.toggleSchemaItems = (si) => { expandedSchemaSections.has(si) ? expandedSchemaSections.delete(si) : expandedSchemaSections.add(si); renderSchemaBuilder(); };

// ── Inline Section Total functions ───────────────────────────────────
window.addSectionInlineTotal = (si) => {
  const section = chartOfAccounts[currentDomainId][currentDocId][si];
  if (!section.totals) section.totals = [];
  const ts = Date.now();
  section.totals.push({ title: 'New Total', key: `total_${ts}`, formula: '', color: '#6366f1', bg: 'rgba(99,102,241,0.10)' });
  renderSchemaBuilder();
};
window.removeSectionInlineTotal = (si, ti) => {
  chartOfAccounts[currentDomainId][currentDocId][si].totals.splice(ti, 1);
  renderSchemaBuilder();
};
window.updateSectionInlineTotalTitle   = (si, ti, val) => { chartOfAccounts[currentDomainId][currentDocId][si].totals[ti].title   = val; };
window.updateSectionInlineTotalKey     = (si, ti, val) => { chartOfAccounts[currentDomainId][currentDocId][si].totals[ti].key     = val; };
window.updateSectionInlineTotalFormula = (si, ti, val) => { chartOfAccounts[currentDomainId][currentDocId][si].totals[ti].formula = val; };
window.updateSectionInlineTotalColor   = (si, ti, val) => {
  const [color, bg] = val.split('|');
  chartOfAccounts[currentDomainId][currentDocId][si].totals[ti].color = color;
  chartOfAccounts[currentDomainId][currentDocId][si].totals[ti].bg    = bg;
};

// ── 5. METRICS FORMULAS ───────────────────────────────────────────
function renderMetricsFormulas() {
  const c = document.getElementById("metrics-formulas-container");
  if (!metricsFormulas.length) {
    c.innerHTML = '<div class="field-description">No metrics defined. Add one to power your Dashboard.</div>';
    return;
  }
  c.innerHTML = metricsFormulas.map((m, i) => `
    <div style="background:rgba(15,23,42,0.4); border:1px solid var(--border-subtle);
                border-radius:12px; padding:20px; margin-bottom:16px;">

      <!-- ── Primary row: label first ── -->
      <div style="display:flex; gap:16px; align-items:flex-start; flex-wrap:wrap;">
        <div style="flex:1; min-width:200px;">
          <label style="font-size:11px; color:var(--text-muted); font-weight:700; display:block; margin-bottom:6px;">
            DISPLAY LABEL <span style="color:var(--accent); font-style:normal; font-weight:400;">(shown to users)</span>
          </label>
          <input class="enterprise-input" value="${m.label}"
                 oninput="updateMetric(${i}, 'label', this.value)" placeholder="e.g. EBITDA" />
        </div>
        <div style="flex:2; min-width:250px;">
          <label style="font-size:11px; color:var(--text-muted); font-weight:700; display:block; margin-bottom:6px;">
            FORMULA <span style="color:var(--accent); font-style:normal; font-weight:400;">(use section/item keys, e.g. revenue - directCosts)</span>
          </label>
          <input class="enterprise-input" style="font-family:monospace; color:var(--brand-primary);"
                 value="${m.formula || ''}" oninput="updateMetric(${i}, 'formula', this.value)"
                 placeholder="e.g. revenue - directCosts" />
        </div>
        <div style="display:flex; flex-direction:column; align-items:center;">
          <label style="font-size:11px; color:var(--text-muted); font-weight:700; display:block; margin-bottom:14px;">%?</label>
          <input type="checkbox" ${m.isPercentage ? 'checked' : ''}
                 onchange="updateMetric(${i}, 'isPercentage', this.checked)"
                 style="accent-color:var(--brand-primary); width:16px; height:16px;" />
        </div>
        <button class="btn-danger" style="margin-top:24px;" onclick="removeMetric(${i})">✕</button>
      </div>

      <!-- ── Advanced: key / dataPath (hidden by default) ── -->
      <details class="kpi-advanced-panel" style="margin-top:12px;">
        <summary class="kpi-advanced-summary">⚙ Advanced — Key / Data Path</summary>
        <div style="margin-top:10px; display:flex; gap:16px; flex-wrap:wrap; align-items:flex-start;">
          <div style="flex:1; min-width:200px;">
            <label style="font-size:10px; color:var(--text-muted); font-weight:700; display:block; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.8px;">
              Internal Key <span style="color:var(--text-muted); font-weight:400;">(stable machine reference)</span>
            </label>
            <input class="enterprise-input" style="font-family:monospace; font-size:11px;"
                   value="${m.key}"
                   oninput="updateMetric(${i}, 'key', this.value)"
                   placeholder="e.g. ebitda" />
            <div style="font-size:10px; color:var(--text-muted); margin-top:5px; line-height:1.5;">
              Used internally in formulas and data paths. Renaming the label above will NOT break this reference.
            </div>
          </div>
        </div>
      </details>
    </div>
  `).join("");
}

// ── 6. CONFIDENCE THRESHOLD MANAGER ──────────────────────────────
function renderConfidenceThresholds() {
  const container = document.getElementById("confidence-thresholds-container");
  if (!container) return;

  container.innerHTML = `
    <div style="background:rgba(15,23,42,0.4); border:1px solid var(--border-subtle);
                border-radius:12px; padding:24px; margin-bottom:16px;">
      <div style="font-size:11px; font-weight:800; text-transform:uppercase;
                  letter-spacing:1.5px; color:var(--brand-primary); margin-bottom:8px;">
        PDF Import Confidence Thresholds
      </div>
      <div style="font-size:12px; color:var(--text-muted); margin-bottom:20px; line-height:1.6;">
        When a PDF is imported, each extracted line item gets a confidence score (0–100)
        from the AI. These thresholds define what gets coloured
        <span style="color:#10b981; font-weight:700;">green</span>,
        <span style="color:#f59e0b; font-weight:700;">amber</span>, or
        <span style="color:#ef4444; font-weight:700;">red</span>
        in the import review modal.
      </div>
      <div style="display:flex; gap:20px; flex-wrap:wrap; align-items:flex-end;">
        <div style="flex:1; min-width:160px;">
          <label style="font-size:11px; font-weight:700; color:#10b981;
                        text-transform:uppercase; letter-spacing:0.8px; display:block; margin-bottom:8px;">
            🟢 High Confidence ≥
          </label>
          <input type="number" id="conf-high" class="enterprise-input"
                 value="${confidenceThresholds.high}" min="50" max="99" step="5"
                 style="text-align:center; font-size:18px; font-weight:800; color:#10b981;" />
          <div style="font-size:10px; color:var(--text-muted); margin-top:6px; line-height:1.4;">
            Scores at or above this = green. Mapped confidently by AI.
          </div>
        </div>
        <div style="flex:1; min-width:160px;">
          <label style="font-size:11px; font-weight:700; color:#f59e0b;
                        text-transform:uppercase; letter-spacing:0.8px; display:block; margin-bottom:8px;">
            🟡 Medium Confidence ≥
          </label>
          <input type="number" id="conf-medium" class="enterprise-input"
                 value="${confidenceThresholds.medium}" min="10" max="85" step="5"
                 style="text-align:center; font-size:18px; font-weight:800; color:#f59e0b;" />
          <div style="font-size:10px; color:var(--text-muted); margin-top:6px; line-height:1.4;">
            Scores at or above this = amber. Below = red.
          </div>
        </div>
        <div style="flex:1; min-width:160px; padding:16px; background:rgba(239,68,68,0.06);
                    border:1px solid rgba(239,68,68,0.2); border-radius:8px;">
          <div style="font-size:11px; font-weight:700; color:#ef4444;
                      text-transform:uppercase; letter-spacing:0.8px; margin-bottom:8px;">
            🔴 Low Confidence
          </div>
          <div style="font-size:22px; font-weight:800; color:#ef4444;">
            &lt; ${confidenceThresholds.medium}
          </div>
          <div style="font-size:10px; color:var(--text-muted); margin-top:6px; line-height:1.4;">
            Auto-calculated. Must be reviewed and manually verified.
          </div>
        </div>
      </div>
      <div style="margin-top:20px; padding:12px 16px; background:var(--bg-input);
                  border-radius:8px; border:1px solid var(--border-subtle);
                  display:flex; gap:16px; align-items:center; flex-wrap:wrap;">
        <span style="font-size:11px; color:var(--text-muted); font-weight:600; text-transform:uppercase;">Preview:</span>
        <span id="conf-preview-high"   style="font-size:11px; font-weight:700; color:#10b981; background:rgba(16,185,129,0.1); padding:3px 10px; border-radius:12px;">High ≥${confidenceThresholds.high}%</span>
        <span id="conf-preview-medium" style="font-size:11px; font-weight:700; color:#f59e0b; background:rgba(245,158,11,0.1); padding:3px 10px; border-radius:12px;">Med ≥${confidenceThresholds.medium}%</span>
        <span id="conf-preview-low"    style="font-size:11px; font-weight:700; color:#ef4444; background:rgba(239,68,68,0.1); padding:3px 10px; border-radius:12px;">Low &lt;${confidenceThresholds.medium}%</span>
      </div>
    </div>
  `;

  ['conf-high', 'conf-medium'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      const h = parseInt(document.getElementById('conf-high')?.value)   || 85;
      const m = parseInt(document.getElementById('conf-medium')?.value) || 60;
      const previewH = document.getElementById('conf-preview-high');
      const previewM = document.getElementById('conf-preview-medium');
      const previewL = document.getElementById('conf-preview-low');
      if (previewH) previewH.textContent = `High ≥${h}%`;
      if (previewM) previewM.textContent = `Med ≥${m}%`;
      if (previewL) previewL.textContent = `Low <${m}%`;
      const redBox = container.querySelector('[style*="font-size:22px"]');
      if (redBox) redBox.textContent = `< ${m}`;
    });
  });
}

// ── 7. DASHBOARD CONFIG ───────────────────────────────────────────
function renderDashboardConfig() {
  const allOpts = getAvailableMetrics();

  const kpiContainer = document.getElementById("dashboard-kpis-container");
  if (kpiContainer) {
    kpiContainer.innerHTML = allOpts.map(opt => `
      <label style="display:flex; align-items:center; gap:10px; background:var(--bg-input);
                    padding:10px 14px; border-radius:8px; border:1px solid var(--border-subtle);
                    cursor:pointer; transition:all 0.2s;">
        <input type="checkbox" value="${opt.key}"
               ${dashboardConfig.kpis.includes(opt.key) ? 'checked' : ''}
               onchange="toggleKpi('${opt.key}', this.checked)"
               style="accent-color:var(--brand-primary);" />
        <span style="flex:1;">
          <span style="font-size:12px; font-weight:600; display:block;">${opt.label}</span>
          <span style="font-size:10px; font-family:monospace; color:var(--text-muted); opacity:0.7;">${opt.key}</span>
        </span>
      </label>
    `).join("");
  }

  const chartsContainer = document.getElementById("dashboard-charts-container");
  if (chartsContainer) {
    if (!dashboardConfig.charts.length) {
      chartsContainer.innerHTML = '<div class="field-description">No charts configured.</div>';
    } else {
      chartsContainer.innerHTML = dashboardConfig.charts.map((chart, ci) => `
        <div style="background:rgba(15,23,42,0.4); border:1px solid var(--border-subtle);
                    border-radius:12px; padding:20px; margin-bottom:16px;">
          <div style="display:flex; justify-content:space-between; margin-bottom:16px;">
            <input class="enterprise-input" style="font-weight:800; font-size:16px; max-width:300px;"
                   value="${chart.title}" placeholder="Chart Title"
                   oninput="updateChart(${ci}, 'title', this.value)" />
            <button class="btn-danger" onclick="removeChart(${ci})">✕ Delete</button>
          </div>
          <div style="margin-bottom:16px;">
            <select class="enterprise-input" onchange="updateChart(${ci}, 'type', this.value)" style="max-width:200px;">
              <option value="bar"   ${chart.type==='bar'   ? 'selected' : ''}>📊 Bar Chart</option>
              <option value="line"  ${chart.type==='line'  ? 'selected' : ''}>📈 Line Chart</option>
              <option value="combo" ${chart.type==='combo' ? 'selected' : ''}>📉 Combo (Bar + Line)</option>
            </select>
          </div>
          <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:16px; min-height:30px;
                      align-items:center; background:var(--bg-input); padding:12px;
                      border-radius:8px; border:1px dashed var(--border-subtle);">
            ${!chart.datasets.length
              ? '<span style="font-size:12px; color:var(--text-muted)">No datasets added...</span>'
              : chart.datasets.map((ds, di) => {
                  const label = allOpts.find(o => o.key === ds)?.label || ds;
                  return `<span style="background:rgba(59,130,246,0.15); border:1px solid rgba(59,130,246,0.4);
                                       padding:4px 10px; border-radius:20px; font-size:11px; font-weight:600;
                                       color:#60a5fa; display:flex; align-items:center; gap:6px;">
                    ${label}
                    <button style="background:none; border:none; color:#ef4444; cursor:pointer; padding:0;"
                            onclick="removeDataset(${ci}, ${di})">✕</button>
                  </span>`;
                }).join("")}
          </div>
          <div style="display:flex; gap:12px; max-width:400px;">
            <select id="add-ds-sel-${ci}" class="enterprise-input">
              <option value="">+ Select Dataset to Plot...</option>
              ${allOpts.map(o => `<option value="${o.key}">${o.label}</option>`).join("")}
            </select>
            <button class="btn-secondary" onclick="addDataset(${ci})">Add Data</button>
          </div>
        </div>
      `).join("");
    }
  }
}

// ── 8. CUSTOM RATIOS ──────────────────────────────────────────────
function renderCustomRatios() {
  const container = document.getElementById('custom-ratios-container');
  if (!customRatios.length) {
    container.innerHTML = '<div class="field-description">No custom ratios yet.</div>';
    return;
  }

  const allOpts     = getAvailableMetrics();
  const optionsHtml = allOpts.map(o => `<option value="${o.key}">${o.label}</option>`).join("");

  container.innerHTML = customRatios.map((r, i) => `
    <div style="background:rgba(15,23,42,0.4); border:1px solid var(--border-subtle);
                border-radius:12px; padding:20px; margin-bottom:16px;" data-ratio-index="${i}">
      <div style="display:flex; gap:24px; align-items:flex-start; flex-wrap:wrap;">
        <div style="flex:1.5; min-width:200px;">
          <label style="font-size:11px; color:var(--text-muted); font-weight:700; display:block; margin-bottom:6px;">RATIO NAME</label>
          <input class="enterprise-input" value="${r.label}" data-field="label" data-index="${i}" placeholder="e.g. Current Ratio" />
          <label style="display:flex; align-items:center; gap:6px; margin-top:12px; font-size:11px; color:var(--text-muted); cursor:pointer;">
            <input type="checkbox" ${r.isPercentage ? 'checked' : ''}
                   data-field="isPercentage" data-index="${i}"
                   style="accent-color:var(--brand-primary);" /> Show as %
          </label>
        </div>
        <div style="flex:1; min-width:180px;">
          <label style="font-size:11px; color:var(--text-muted); font-weight:700; display:block; margin-bottom:6px;">NUMERATOR</label>
          <div style="background:var(--bg-input); min-height:36px; padding:8px; border-radius:6px;
                      margin-bottom:8px; border:1px solid var(--border-subtle); display:flex; flex-wrap:wrap; gap:6px;">
            ${renderPills(r.numerator || [], i, 'numerator', allOpts)}
          </div>
          <select class="enterprise-input ratio-add-select" data-part="numerator" data-index="${i}">
            <option value="">+ Add item</option>${optionsHtml}
          </select>
        </div>
        <div style="padding-top:28px; color:var(--text-muted); font-size:24px; font-weight:300;">÷</div>
        <div style="flex:1; min-width:180px;">
          <label style="font-size:11px; color:var(--text-muted); font-weight:700; display:block; margin-bottom:6px;">DENOMINATOR</label>
          <div style="background:var(--bg-input); min-height:36px; padding:8px; border-radius:6px;
                      margin-bottom:8px; border:1px solid var(--border-subtle); display:flex; flex-wrap:wrap; gap:6px;">
            ${renderPills(r.denominator || [], i, 'denominator', allOpts)}
          </div>
          <select class="enterprise-input ratio-add-select" data-part="denominator" data-index="${i}">
            <option value="">+ Add item</option>${optionsHtml}
          </select>
        </div>
        <button class="btn-danger" data-delete-ratio="${i}" style="margin-top:28px;">✕</button>
      </div>
    </div>
  `).join("");

  attachRatioListeners(container);
}

function renderPills(keys, ratioIndex, part, allOpts) {
  if (!keys.length) return '<span style="font-size:11px; color:var(--text-muted); opacity:0.5;">None selected</span>';
  return keys.map((k, ki) => {
    const label = allOpts.find(o => o.key === k)?.label || k;
    return `<span style="background:rgba(255,255,255,0.05); border:1px solid var(--border-subtle);
                         padding:3px 8px; border-radius:12px; font-size:10px; color:var(--text-main);
                         display:inline-flex; align-items:center; gap:4px;">
      ${label}
      <button data-remove-pill data-ratio="${ratioIndex}" data-part="${part}" data-ki="${ki}"
              style="background:none; border:none; color:#ef4444; cursor:pointer; padding:0;">✕</button>
    </span>`;
  }).join("");
}

function attachRatioListeners(container) {
  container.querySelectorAll('input[data-field="label"]').forEach(el => {
    el.addEventListener('input', () => { customRatios[el.dataset.index].label = el.value; });
  });
  container.querySelectorAll('input[data-field="isPercentage"]').forEach(el => {
    el.addEventListener('change', () => { customRatios[el.dataset.index].isPercentage = el.checked; });
  });
  container.querySelectorAll('select.ratio-add-select').forEach(sel => {
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      const idx = parseInt(sel.dataset.index), part = sel.dataset.part;
      if (!customRatios[idx][part]) customRatios[idx][part] = [];
      if (!customRatios[idx][part].includes(sel.value)) customRatios[idx][part].push(sel.value);
      sel.value = '';
      renderCustomRatios();
    });
  });
  container.querySelectorAll('[data-remove-pill]').forEach(btn => {
    btn.addEventListener('click', () => {
      customRatios[parseInt(btn.dataset.ratio)][btn.dataset.part].splice(parseInt(btn.dataset.ki), 1);
      renderCustomRatios();
    });
  });
  container.querySelectorAll('[data-delete-ratio]').forEach(btn => {
    btn.addEventListener('click', () => { customRatios.splice(parseInt(btn.dataset.deleteRatio), 1); renderCustomRatios(); });
  });
}

// ── WINDOW HANDLERS ───────────────────────────────────────────────
window.addMetricFormula = () => {
  const ts = Date.now();
  metricsFormulas.push({ key: `metric_${ts}`, label: 'New Metric', formula: '', isPercentage: false });
  renderMetricsFormulas();
};
window.updateMetric     = (i, field, val) => { metricsFormulas[i][field] = val; };
window.removeMetric     = (i) => { metricsFormulas.splice(i, 1); renderMetricsFormulas(); renderDashboardConfig(); renderCustomRatios(); };

window.toggleKpi = (key, isChecked) => {
  if (isChecked) {
    if (dashboardConfig.kpis.length >= 8) { alert("Maximum 8 KPIs allowed."); renderDashboardConfig(); return; }
    dashboardConfig.kpis.push(key);
  } else {
    dashboardConfig.kpis = dashboardConfig.kpis.filter(k => k !== key);
  }
};
window.addChart       = () => { dashboardConfig.charts.push({ title: 'New Chart', type: 'bar', datasets: [] }); renderDashboardConfig(); };
window.updateChart    = (ci, field, val) => { dashboardConfig.charts[ci][field] = val; };
window.removeChart    = (ci) => { dashboardConfig.charts.splice(ci, 1); renderDashboardConfig(); };
window.addDataset     = (ci) => { const sel = document.getElementById(`add-ds-sel-${ci}`); if (sel?.value) { dashboardConfig.charts[ci].datasets.push(sel.value); sel.value = ''; renderDashboardConfig(); } };
window.removeDataset  = (ci, di) => { dashboardConfig.charts[ci].datasets.splice(di, 1); renderDashboardConfig(); };

// ── SAVING ────────────────────────────────────────────────────────
// Always use merge: false (full overwrite) with sanitizeForFirestore()
// to avoid Firestore merge corrupting nested arrays.
async function saveDomains() {
  await setDoc(
    doc(db, "workspace-config", "domainTemplates"),
    sanitizeForFirestore({ domains: masterDomains, documents: masterDocuments, chartOfAccounts })
  );
  showStatus("domain-status");
  renderDashboardConfig(); renderCustomRatios();
}

async function saveEntities() {
  await setDoc(
    doc(db, "workspace-config", "entityTypes"),
    sanitizeForFirestore({ types: entityTypes })
  );
  showStatus("entity-status");
}

async function saveDocuments() {
  await setDoc(
    doc(db, "workspace-config", "domainTemplates"),
    sanitizeForFirestore({ domains: masterDomains, documents: masterDocuments, chartOfAccounts })
  );
  showStatus("document-status");
}

async function saveSchema() {
  await setDoc(
    doc(db, "workspace-config", "domainTemplates"),
    sanitizeForFirestore({ domains: masterDomains, documents: masterDocuments, chartOfAccounts })
  );
  showStatus("schema-status");
  renderDashboardConfig(); renderCustomRatios();
}

async function saveMetricsFormulas() {
  metricsFormulas.forEach(m => {
    // Auto-generate a stable key from the label only for brand-new metrics
    // (those that still have the auto-assigned `metric_<timestamp>` placeholder key).
    // If the user explicitly set a key via the Advanced panel, leave it unchanged.
    if (m.key.startsWith('metric_')) {
      m.key = m.label.toLowerCase().replace(/ /g, '_').replace(/[^a-z0-9_]/g, '') || m.key;
    }
    // Ensure key is never empty
    if (!m.key) m.key = `metric_${Date.now()}`;
  });
  
  // ✅ ENHANCED: Extract and validate confidence thresholds
  const high   = parseInt(document.getElementById('conf-high')?.value)   || 85;
  const medium = parseInt(document.getElementById('conf-medium')?.value) || 60;
  
  // Validate thresholds
  if (isNaN(high) || isNaN(medium)) {
    alert("Confidence thresholds must be valid numbers.");
    return;
  }
  if (medium >= high) { 
    alert("Medium threshold must be lower than High threshold."); 
    return; 
  }
  if (high < 50 || high > 100) {
    alert("High threshold must be between 50 and 100.");
    return;
  }
  if (medium < 0 || medium > high - 10) {
    alert("Medium threshold must be at least 10 points below High threshold.");
    return;
  }
  
  confidenceThresholds = { high, medium };
  
  // ✅ ENHANCED: Save both metrics AND confidence thresholds together
  await setDoc(
    doc(db, "workspace-config", "engineConfig"),
    sanitizeForFirestore({ 
      metrics: metricsFormulas, 
      confidenceThresholds  // ← NEW: Include confidence thresholds
    })
  );
  
  showStatus("metrics-save-status");
  renderMetricsFormulas(); 
  renderConfidenceThresholds(); 
  renderDashboardConfig(); 
  renderCustomRatios();
}
async function saveDashboardConfig() {
  await setDoc(
    doc(db, "workspace-config", "dashboardConfig"),
    sanitizeForFirestore(dashboardConfig)
  );
  showStatus("dashboard-config-status");
}

async function saveCustomRatios() {
  const invalid = customRatios.find(r => !r.label.trim());
  if (invalid) { alert("All ratios must have a name."); return; }
  customRatios = customRatios.map(r => ({
    ...r,
    key: r.key.startsWith('customRatio') ? r.label.trim().toLowerCase().replace(/ /g, '_').replace(/[^a-z0-9_]/g, '') : r.key
  }));
  await setDoc(
    doc(db, "workspace-config", "analysisConfig"),
    sanitizeForFirestore({ customRatios })
  );
  showStatus("ratio-status");
  renderCustomRatios(); renderDashboardConfig();
}

function showStatus(id) {
  const el = document.getElementById(id);
  if (el) { el.style.display = 'inline'; setTimeout(() => el.style.display = 'none', 2500); }
}

// ── BUTTON WIRING ─────────────────────────────────────────────────
function setupButtons() {
  document.getElementById("save-domains-btn")?.addEventListener("click", saveDomains);
  document.getElementById("save-entities-btn")?.addEventListener("click", saveEntities);
  document.getElementById("save-documents-btn")?.addEventListener("click", saveDocuments);
  document.getElementById("save-schema-btn")?.addEventListener("click", saveSchema);
  document.getElementById("save-metrics-formulas-btn")?.addEventListener("click", saveMetricsFormulas);
  document.getElementById("save-dashboard-config-btn")?.addEventListener("click", saveDashboardConfig);
  document.getElementById("save-ratios-btn")?.addEventListener("click", saveCustomRatios);

  document.getElementById("add-domain-btn")?.addEventListener("click", window.addDomain);
  document.getElementById("add-entity-btn")?.addEventListener("click", window.addEntity);
  document.getElementById("add-document-type-btn")?.addEventListener("click", window.addDocumentType);
  document.getElementById("add-schema-section-btn")?.addEventListener("click", window.addSchemaSection);
  document.getElementById("add-schema-total-btn")?.addEventListener("click", window.addSchemaTotalRow);
  document.getElementById("add-metric-formula-btn")?.addEventListener("click", window.addMetricFormula);
  document.getElementById("add-chart-btn")?.addEventListener("click", window.addChart);
  document.getElementById("add-ratio-btn")?.addEventListener("click", () => {
    customRatios.push({ key: `customRatio_${Date.now()}`, label: '', numerator: [], denominator: [], isPercentage: false });
    renderCustomRatios();
  });

  // FIXED: schema-domain-select removed (single shared template)
  document.getElementById("schema-document-select")?.addEventListener("change", handleSchemaDropdownChange);
  document.getElementById("back-btn")?.addEventListener("click", () => history.back());
}
