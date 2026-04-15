// js/im.js — Multi-user Collaborative Rewrite (Phase 1-5 & Advanced Schema Support)
// Firebase Version: 10.12.2 strictly enforced

import { db, auth, rtdb } from './firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
    doc, updateDoc, setDoc, onSnapshot,
    serverTimestamp, collection, addDoc, getDocs, deleteDoc, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { 
    ref, onValue, set, onDisconnect, remove, 
    serverTimestamp as rtdbTimestamp 
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

// 🌟 Import Firebase Storage
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';
const storage = getStorage();

// 🌟 NEW: Added saveSchema import so the workspace can inject rows into the template
import { loadSchema, subscribeToSchema, saveSchema } from './im-core/schema-service.js';
import { renderSection as renderSectionDOM } from './im-core/renderer.js';
import { getNestedValue, setNestedValue } from './im-core/utils.js';


// ── Globals ───────────────────────────────────────────────────────────────────
let currentImId       = null;
let currentProjectId  = null;
let currentImData     = {};
let currentSectionKey = null;
let imSchema          = [];
let unsubscribeIm     = null;
let isTyping          = false;
let typingTimer       = null;
let currentUserId     = null;
let currentUserName   = null;
let isPreviewMode     = false;

// ── Utility ───────────────────────────────────────────────────────────────────
function esc(str) {
    return String(str ?? '').replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag));
}

// ── 🌟 IMPROVEMENT 1: Centralized Save Queue (Batched Mutations) ──────────────
const SaveManager = {
    pendingWrites: {},
    saveTimeout: null,

    async queue(path, data) {
        this.pendingWrites[path] = data;
        setNestedValue(currentImData, path, data); 

        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(() => this.flush(), 1500);
    },

    async flush() {
        if (Object.keys(this.pendingWrites).length === 0) return;

        const batch = writeBatch(db);
        const imRef = doc(db, 'investment-memos', currentImId);
        
        batch.update(imRef, { 
            updatedAt: serverTimestamp(), 
            lastChangedBy: currentUserName 
        });

        for (const [path, value] of Object.entries(this.pendingWrites)) {
            const safeId = path.replace(/\./g, '___');
            const fragmentRef = doc(db, 'investment-memos', currentImId, 'data', safeId);
            batch.set(fragmentRef, { path, value, updatedAt: serverTimestamp(), lastChangedBy: currentUserName });
        }
        
        this.pendingWrites = {}; 

        try {
            await batch.commit();
        } catch (e) {
            console.error("Batch Save Error:", e);
        }
    }
};

function injectQuillFixes() {
    if (document.getElementById('quill-fixes-css')) return;
    const style = document.createElement('style');
    style.id = 'quill-fixes-css';
    style.textContent = `
        .ql-snow.ql-toolbar button:hover .ql-stroke,
        .ql-snow .ql-toolbar button:hover .ql-stroke,
        .ql-snow.ql-toolbar button.ql-active .ql-stroke,
        .ql-snow .ql-toolbar button.ql-active .ql-stroke { stroke: var(--s-accent, #ef4444) !important; }
        .ql-snow.ql-toolbar button:hover .ql-fill,
        .ql-snow .ql-toolbar button:hover .ql-fill,
        .ql-snow.ql-toolbar button.ql-active .ql-fill,
        .ql-snow .ql-toolbar button.ql-active .ql-fill { fill: var(--s-accent, #ef4444) !important; }
        .ql-snow.ql-toolbar button.ql-active { background-color: rgba(239, 68, 68, 0.15) !important; border-radius: 4px; }
        .ql-snow.ql-toolbar .ql-picker-label:hover,
        .ql-snow.ql-toolbar .ql-picker-label.ql-active { color: var(--s-accent, #ef4444) !important; }
        .ql-snow.ql-toolbar .ql-picker-label:hover .ql-stroke,
        .ql-snow.ql-toolbar .ql-picker-label.ql-active .ql-stroke { stroke: var(--s-accent, #ef4444) !important; }
        .ql-editor.ql-blank::before { color: var(--text2, #9ca3af) !important; font-style: italic; opacity: 0.6; }
    `;
    document.head.appendChild(style);
}

// ── Auth gate ─────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, user => {
    if (!user) { window.location.href = 'login.html'; return; }
    currentUserId   = user.uid;
    currentUserName = user.displayName || user.email.split('@')[0];

    const params     = new URLSearchParams(window.location.search);
    currentImId      = params.get('im');
    currentProjectId = params.get('project');

    if (!currentImId) { alert('No IM selected.'); return; }

    sessionStorage.setItem('last-im-url', window.location.href);

    injectQuillFixes(); 
    setupExitBtn();
    setupTheme();
    setupPreviewBtn();
    setupExportJsonBtn();
    setupPdfBtn();
    setupVersionsBtn();
    setupCommitBtn();
    setupGlobalClickHandlers();
    wireSettingsLinks(); 
    loadIM();
    setupPresence();
    initCommentsEngine();
    setupSidebarToggle();

    window.__im = { SaveManager, get data() { return currentImData; } };
});

function wireSettingsLinks() {
    document.querySelectorAll('a[href*="im-settings.html"]').forEach(link => {
        link.href = `im-settings.html?im=${currentImId}&project=${currentProjectId || ''}`;
    });
}

// ── Load IM from Firestore ────────────────────────────────────────────────────
async function loadIM() {
    if (!imSchema.length) imSchema = await loadSchema(currentImId);
    buildNav();

    subscribeToSchema(currentImId, (newSchema) => {
        if (!isTyping && JSON.stringify(imSchema) !== JSON.stringify(newSchema)) {
            imSchema = newSchema || [];
            buildNav();
            if (currentSectionKey) renderCurrentSection();
        }
    });

    const imRef = doc(db, 'investment-memos', currentImId);
    const dataCollRef = collection(db, 'investment-memos', currentImId, 'data');

    onSnapshot(imRef, snapshot => {
        if (!snapshot.exists()) { console.warn('IM not found.'); return; }
        const meta = snapshot.data();
        document.getElementById('im-title').textContent = meta.title || 'Untitled IM';
    });

    if (unsubscribeIm) unsubscribeIm();
    unsubscribeIm = onSnapshot(dataCollRef, snapshot => {
        let hasChanges = false;
        const newData = currentImData ? JSON.parse(JSON.stringify(currentImData)) : {};

        snapshot.docChanges().forEach(change => {
            const docData = change.doc.data();
            if (change.type === 'added' || change.type === 'modified') {
                setNestedValue(newData, docData.path, docData.value);
                hasChanges = true;
            } else if (change.type === 'removed') {
                setNestedValue(newData, docData.path, null);
                hasChanges = true;
            }
        });

        if (hasChanges) {
            if (currentSectionKey) applyRemoteState(newData);
            else {
                currentImData = newData;
                const first = [...imSchema].sort((a, b) => a.order - b.order)[0];
                if (first) navigateTo(first.key);
            }
        }
    });
}

// ── 🌟 IMPROVEMENT 2: Granular Remote State Merging (Zero-Nuke DOM Patching) ──
function applyRemoteState(newData) {
    let requiresFullRender = false;
    
    const sectionSchema = imSchema.find(s => s.key === currentSectionKey);
    if (sectionSchema) {
        sectionSchema.blocks?.forEach(block => {
            if (block.type.includes('table')) {
                const oldArr = getNestedValue(currentImData, block.dataPath);
                const newArr = getNestedValue(newData, block.dataPath);
                const oldLen = Array.isArray(oldArr) ? oldArr.length : (oldArr && typeof oldArr === 'object' ? Object.keys(oldArr).length : 0);
                const newLen = Array.isArray(newArr) ? newArr.length : (newArr && typeof newArr === 'object' ? Object.keys(newArr).length : 0);
                if (oldLen !== newLen) requiresFullRender = true;
            }
            if (block.type === 'file' || block.type === 'image') {
                const oldArr = getNestedValue(currentImData, block.dataPath);
                const newArr = getNestedValue(newData, block.dataPath);
                const oldLen = Array.isArray(oldArr) ? oldArr.length : (oldArr ? 1 : 0);
                const newLen = Array.isArray(newArr) ? newArr.length : (newArr ? 1 : 0);
                if (oldLen !== newLen) requiresFullRender = true;
            }
        });
    }

    if (JSON.stringify(currentImData._hiddenBlocks || {}) !== JSON.stringify(newData._hiddenBlocks || {})) {
        requiresFullRender = true;
    }

    if (requiresFullRender) {
        if (!isTyping) {
            const safeNewData = JSON.parse(JSON.stringify(newData));
            for (const pendingPath of Object.keys(SaveManager.pendingWrites)) {
                const localVal = getNestedValue(currentImData, pendingPath);
                setNestedValue(safeNewData, pendingPath, localVal);
            }
            currentImData = safeNewData;
            renderCurrentSection();
        }
        return;
    }

    document.querySelectorAll('.editor-field:not(.table-cell)').forEach(field => {
        if (document.activeElement === field) return; 
        const path = field.dataset.path;
        if (!path || SaveManager.pendingWrites[path] !== undefined) return;

        const mixedIdx = field.dataset.mixedIdx;
        let newVal = getNestedValue(newData, path);
        if (mixedIdx !== undefined && Array.isArray(newVal)) newVal = newVal[mixedIdx];

        if (newVal !== undefined) {
            if (field.type === 'checkbox' || field.type === 'radio') {
                field.checked = !!newVal;
            } else {
                if (field.value !== String(newVal)) field.value = newVal;
            }
        }
    });

    document.querySelectorAll('.table-cell:not(.computed-cell)').forEach(cell => {
        if (document.activeElement === cell) return;
        const dataPath = cell.dataset.path;
        if (!dataPath || SaveManager.pendingWrites[dataPath] !== undefined) return;

        const rowIdx = parseInt(cell.dataset.row);
        const colId = cell.dataset.col;
        const mixedIdx = cell.dataset.mixedIdx;

        const records = getNestedValue(newData, dataPath);
        let targetRecs = records;
        if (records && typeof records === 'object' && !Array.isArray(records)) {
            targetRecs = Object.keys(records).sort((a,b)=>a-b).map(k => records[k]);
        }

        if (!targetRecs || !targetRecs[rowIdx]) return;

        let newVal;
        if (mixedIdx !== undefined) {
            newVal = targetRecs[rowIdx][colId] ? targetRecs[rowIdx][colId][mixedIdx] : '';
        } else {
            newVal = targetRecs[rowIdx][colId];
        }

        if (newVal !== undefined) {
            if (cell.type === 'checkbox') cell.checked = !!newVal;
            else if (cell.value !== String(newVal)) cell.value = newVal;
        }
    });
document.querySelectorAll('.ql-container').forEach(container => {
        if (container.contains(document.activeElement)) return;
        const path = container.dataset.path;
        if (!path || SaveManager.pendingWrites[path] !== undefined) return;

        const newVal = getNestedValue(newData, path) || '';
        const quill = Quill.find(container);
        if (quill) {
            const currentHtml = quill.root.innerHTML === '<p><br></p>' ? '' : quill.root.innerHTML;
            if (currentHtml !== newVal) {
                const sel = quill.getSelection();
                // 🌟 FIX: Force DOM paste to prevent Quill from stripping valid HTML into an empty block
                quill.clipboard.dangerouslyPasteHTML(newVal, 'silent'); 
                if (sel) {
                    setTimeout(() => quill.setSelection(sel.index, sel.length, 'silent'), 10);
                }
            }
        }
    });

    currentImData = newData; 
}

// ── Navigation & Section Presence ─────────────────────────────────────────────
function buildNav() {
    const nav = document.getElementById('im-nav');
    if (!nav) return;
    nav.innerHTML = '';

    const parents = [...imSchema]
        .filter(s => !s.parentId)
        .sort((a, b) => a.order - b.order);

    parents.forEach(sec => {
        const children = [...imSchema]
            .filter(s => s.parentId === sec.id)
            .sort((a, b) => a.order - b.order);

        if (children.length === 0) {
            const el = document.createElement('div');
            el.className   = 'nav-item';
            el.dataset.section = sec.key;
            el.innerHTML = `
                ${esc(sec.navLabel)}
                <div class="presence-indicator" id="presence-${sec.key}"></div>
            `;
            el.addEventListener('click', () => navigateTo(sec.key));
            nav.appendChild(el);

        } else {
            const wrapper = document.createElement('div');
            wrapper.className = 'nav-group';

            const parentEl = document.createElement('div');
            parentEl.className = 'nav-item nav-parent';
            parentEl.dataset.section = sec.key;
            parentEl.innerHTML = `
                <span class="nav-arrow" style="display:inline-block;margin-right:6px;transition:transform 0.2s;font-size:10px">▶</span>
                ${esc(sec.navLabel)}
                <div class="presence-indicator" id="presence-${sec.key}"></div>
            `;

            const childrenEl = document.createElement('div');
            childrenEl.className = 'nav-children';
            childrenEl.style.display  = 'none';   
            childrenEl.style.paddingLeft = '12px';

            children.forEach(child => {
                const cel = document.createElement('div');
                cel.className   = 'nav-item sub-item';
                cel.dataset.section = child.key;
                cel.innerHTML = `
                    ${esc(child.navLabel)}
                    <div class="presence-indicator" id="presence-${child.key}"></div>
                `;
                cel.addEventListener('click', e => {
                    e.stopPropagation();
                    navigateTo(child.key);
                });
                childrenEl.appendChild(cel);
            });

            parentEl.addEventListener('click', () => {
                const isOpen = childrenEl.style.display !== 'none';
                childrenEl.style.display = isOpen ? 'none' : 'block';
                parentEl.querySelector('.nav-arrow').style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
                navigateTo(sec.key);
            });

            wrapper.appendChild(parentEl);
            wrapper.appendChild(childrenEl);
            nav.appendChild(wrapper);
        }
    });
}

async function navigateTo(key) {
    currentSectionKey = key;
    document.querySelectorAll('#im-nav .nav-item').forEach(el => {
        el.classList.toggle('active', el.dataset.section === key);
    });

    if (currentUserId && currentImId) {
        set(ref(rtdb, `im-presence/${currentImId}/${currentUserId}/currentSection`), key);
    }

    renderCurrentSection();
}

// ── Render & Locking Logic ────────────────────────────────────────────────────
function renderCurrentSection() {
  if (isPreviewMode) { renderPreview(); return; }
  const canvas = document.getElementById('im-canvas');
  if (!canvas) return;

  const sectionSchema = imSchema.find(s => s.key === currentSectionKey);
  if (!sectionSchema) { return; }

  const quillTargets = renderSectionDOM(sectionSchema, canvas, currentImData);
  quillTargets.forEach(({ editorId, dataPath, initialContent }) =>
    initQuillEditor(editorId, dataPath, initialContent)
  );

  enableAutosave();
  wireTableControls();
  wireImageControls();
  wireFileControls();  
  wireFieldLocking();
  wireEditableHeaders();
  wireEditableGroupLabels();

  recalculateTableFormulas(); 
  evaluateVisibility(); 
}

// ── Phase 1: Real-time Field Locking System ───────────────────────────────────
function wireFieldLocking() {
    if (!currentImId || !currentUserId) return;

    const locksRef = ref(rtdb, `im-locks/${currentImId}`);

    onValue(locksRef, (snapshot) => {
        const locks = snapshot.val() || {};
        
        document.querySelectorAll('.editor-field').forEach(el => {
            el.disabled = false;
            el.classList.remove('locked-by-other');
            const parent = el.closest('.field-group') || el.parentElement;
            parent.querySelectorAll('.lock-badge').forEach(b => b.remove());
        });

        Object.entries(locks).forEach(([lockKey, locker]) => {
            const [encodedPath, mixedIdxStr] = lockKey.split('--');
            const path = encodedPath.replace(/__/g, '.');

            if (locker.userId !== currentUserId) {
                const fields = document.querySelectorAll(`[data-path="${path}"]`);
                fields.forEach(field => {
                    const fieldMixedIdx = field.dataset.mixedIdx || 'none';
                    if (fieldMixedIdx !== mixedIdxStr) return;

                    field.disabled = true;
                    field.classList.add('locked-by-other');
                    
                    const badge = document.createElement('div');
                    badge.className = 'lock-badge';
                    badge.innerHTML = `🔒 ${esc(locker.userName)}`;
                    field.parentElement.insertBefore(badge, field);
                });
            }
        });
        
        if (window.lucide) lucide.createIcons();
    });

    document.querySelectorAll('.editor-field').forEach(field => {
        const path = field.dataset.path;
        if (!path) return;
        const mixedIdx = field.dataset.mixedIdx || 'none';
        const encodedPath = path.replace(/\./g, '__');
        const lockKey = `${encodedPath}--${mixedIdx}`;

        field.addEventListener('focus', () => {
            set(ref(rtdb, `im-locks/${currentImId}/${lockKey}`), {
                userId: currentUserId,
                userName: currentUserName,
                mixedIdx: field.dataset.mixedIdx || 'none', 
                timestamp: rtdbTimestamp()
            });
            onDisconnect(ref(rtdb, `im-locks/${currentImId}/${lockKey}`)).remove();
        });

        field.addEventListener('blur', () => {
            remove(ref(rtdb, `im-locks/${currentImId}/${lockKey}`));
        });
    });
}

// ── Persistence & Multi-user Conflict Resolution ───────────────────────────────
async function persistData(dataPath, data) {
    if (typeof data === 'string' && data.length > 100000) {
        alert("System Error: Data payload exceeds limit.");
        return;
    }
    SaveManager.queue(dataPath, data);
}

// ── Phase 2: Active User Awareness (Dots) ──────────────────────────────────────
function setupPresence() {
    if (!currentImId || !currentUserId) return;

    const presenceRef = ref(rtdb, `im-presence/${currentImId}`);
    const myStatusRef = ref(rtdb, `im-presence/${currentImId}/${currentUserId}`);

    const connectedRef = ref(rtdb, '.info/connected');
    onValue(connectedRef, (snap) => {
        if (snap.val() === true) {
            onDisconnect(myStatusRef).remove();
            set(myStatusRef, {
                name: currentUserName,
                currentSection: currentSectionKey || 'none',
                lastSeen: rtdbTimestamp()
            });
        }
    });

    onValue(presenceRef, (snap) => {
        const users = snap.val() || {};
        
        document.querySelectorAll('.presence-indicator').forEach(dot => dot.innerHTML = '');

        Object.values(users).forEach(u => {
            if (u.name === currentUserName) return; 
            
            const targetIndicator = document.getElementById(`presence-${u.currentSection}`);
            if (targetIndicator) {
                const dot = document.createElement('span');
                dot.className = 'presence-dot';
                dot.title = `${esc(u.name)} is editing here`;
                dot.textContent = u.name.charAt(0).toUpperCase();
                targetIndicator.appendChild(dot);
            }
        });
        
        updateCollaboratorsUI(users);
    });
}

function updateCollaboratorsUI(users) {
    const collabToggle = document.getElementById('collab-toggle');
    const collabList = document.getElementById('collab-list');
    if (!collabToggle || !collabList) return;
    
    const activeUsers = Object.values(users);
    const count = activeUsers.length;
    const isOpen = collabList.style.display !== 'none';
    const arrowStyle = `display:inline-block; margin-right:6px; transition:transform 0.2s; font-size:10px; transform:rotate(${isOpen ? '90deg' : '0deg'})`;

    if (count > 1) {
        collabToggle.innerHTML = `<span class="nav-arrow" style="${arrowStyle}">▶</span><span style="color:#10b981">🟢 ${count} Online</span>`;
    } else {
        collabToggle.innerHTML = `<span class="nav-arrow" style="${arrowStyle}">▶</span><span style="opacity:0.6">🟢 Just You</span>`;
    }

    if (count === 0 || (count === 1 && activeUsers[0].name === currentUserName)) {
        collabList.innerHTML = `<div class="nav-item sub-item" style="opacity:0.5; padding-left:24px;">No one else here</div>`;
    } else {
        collabList.innerHTML = activeUsers.map(u => `
            <div class="nav-item sub-item" style="padding-left:24px; font-size:12px; pointer-events:none;">
                👤 ${esc(u.name)}
            </div>
        `).join('');
    }
}

function evaluateVisibility() {
    document.querySelectorAll('[data-show-condition]').forEach(el => {
        const conditionStr = el.dataset.showCondition; 
        if (!conditionStr) return;
        
        try {
            const [path, operator, expectedVal] = conditionStr.split(':');
            const actualVal = getNestedValue(currentImData, path);
            
            let isVisible = false;
            if (operator === '==') isVisible = (String(actualVal) === expectedVal);
            else if (operator === '!=') isVisible = (String(actualVal) !== expectedVal);
            else if (operator === 'includes') isVisible = (Array.isArray(actualVal) && actualVal.includes(expectedVal));
            else if (operator === 'not_empty') isVisible = (actualVal !== undefined && actualVal !== null && actualVal !== '');
            
            if (isVisible) {
                el.style.display = el.dataset.originalDisplay || '';
            } else {
                if (el.style.display !== 'none') {
                    el.dataset.originalDisplay = el.style.display;
                    el.style.display = 'none';
                }
            }
        } catch (e) {
            console.warn("Invalid visibility condition:", conditionStr);
        }
    });
}

function initQuillEditor(editorId, dataPath, initialContent) {
    const container = document.getElementById(editorId);
    if (!container) return;

    container.dataset.path = dataPath; 

    if (initialContent) {
        container.innerHTML = initialContent;
    }

    const quill = new Quill(container, {
        theme: 'snow',
        placeholder: container.dataset.placeholder || 'Type here...',
        modules: {
            toolbar: [
                [{ header: [1, 2, 3, false] }],
                ['bold', 'italic', 'underline'],
                [{ list: 'ordered' }, { list: 'bullet' }],
                ['blockquote', 'link'],
                ['clean']
            ]
        }
    });

    let saveTimer = null;
    quill.on('text-change', (delta, oldDelta, source) => {
        if (source !== 'user') return; 

        isTyping = true;
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => { isTyping = false; }, 3000);

        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
            const html = quill.root.innerHTML;
            await persistData(dataPath, html === '<p><br></p>' ? '' : html);
        }, 800);
    });
}

function wireEditableHeaders() {
    document.querySelectorAll('.editable-header-input').forEach(input => {
        if (input._wired) return;
        input._wired = true;
        let timer = null;
        
        input.addEventListener('input', () => {
            const dataPath = input.dataset.path; 
            const colIdx = parseInt(input.dataset.colIdx);
            
            isTyping = true;
            clearTimeout(typingTimer);
            typingTimer = setTimeout(() => { isTyping = false; }, 3000);

            clearTimeout(timer);
            timer = setTimeout(async () => {
                let headersArr = getNestedValue(currentImData, dataPath) || [];
                if (!Array.isArray(headersArr)) headersArr = [];
                headersArr[colIdx] = input.value;
                
                await persistData(dataPath, headersArr);
            }, 800);
        });
    });
}

function wireEditableGroupLabels() {
    document.querySelectorAll('.editable-group-label').forEach(input => {
        if (input._wired) return;
        input._wired = true;
        let timer = null;
        
        input.addEventListener('input', () => {
            const dataPath = input.dataset.path; 
            const tIdx = parseInt(input.dataset.index);
            
            isTyping = true;
            clearTimeout(typingTimer);
            typingTimer = setTimeout(() => { isTyping = false; }, 3000);

            clearTimeout(timer);
            timer = setTimeout(async () => {
                let tableGroups = getNestedValue(currentImData, dataPath) || [];
                if (!Array.isArray(tableGroups)) tableGroups = [];
                if (!tableGroups[tIdx]) tableGroups[tIdx] = { rows: [] };
                
                tableGroups[tIdx].groupLabel = input.value;
                await persistData(dataPath, tableGroups);
            }, 800);
        });
    });
}

function enableAutosave() {
    document.querySelectorAll('.editor-field:not(.table-cell)').forEach(field => {
        if (field._wired) return;
        field._wired = true;

        if (field.tagName === 'TEXTAREA') autoGrow(field);

        let saveTimer = null; 

        const save = async () => {
            const path = field.dataset.path;
            const mixedIdx = field.dataset.mixedIdx; 
            
            let value = (field.type === 'checkbox' || field.type === 'radio') ? field.checked : field.value;
            
            if (!path) return;

            if (field.tagName === 'SELECT' && value === "__CUSTOM__") {
                const customVal = prompt("Enter custom value:");
                if (!customVal) {
                    const existing = getNestedValue(currentImData, path);
                    if (mixedIdx !== undefined && Array.isArray(existing)) {
                        field.value = existing[mixedIdx] || "";
                    } else {
                        field.value = existing || "";
                    }
                    return;
                }
                const newOpt = document.createElement('option');
                newOpt.value = customVal;
                newOpt.textContent = customVal;
                newOpt.selected = true;
                field.insertBefore(newOpt, field.lastElementChild);
                value = customVal;
            }

            isTyping = true;
            clearTimeout(typingTimer);
            typingTimer = setTimeout(() => { isTyping = false; }, 3000); 

            clearTimeout(saveTimer);
            saveTimer = setTimeout(async () => {
                let dataToSave = value;

                if (mixedIdx !== undefined) {
                    let currentArr = getNestedValue(currentImData, path);
                    if (!Array.isArray(currentArr)) currentArr = [];
                    if (currentArr[mixedIdx] === value) return; 
                    currentArr[mixedIdx] = value;
                    dataToSave = currentArr;
                } else {
                    if (getNestedValue(currentImData, path) === value) return; 
                }

                await persistData(path, dataToSave);
                evaluateVisibility(); 
            }, 800);
        };

        field.addEventListener('input', save);
        field.addEventListener('change', save); 
    });
}

function wireTableControls() {
    document.querySelectorAll('.add-row-btn').forEach(btn => {
        if (btn._wired) return;
        btn._wired = true;
        btn.addEventListener('click', async () => {
            const dataPath = btn.dataset.path;
            const blockId  = btn.dataset.blockId;
            const block    = findBlock(blockId);
            if (!block) return;

            let records = getNestedValue(currentImData, dataPath);
            if (records && typeof records === 'object' && !Array.isArray(records))
                records = Object.keys(records).sort((a,b)=>a-b).map(k => records[k]);

            if (records == null || records === '' || !Array.isArray(records))
                records = [];

            const newRecord = {};
            if (block.rows && block.rows.length > 0) {
                block.rows.forEach(r => r.cells.forEach(c => {
                    if (c.cellType === 'input' && c.id)                              newRecord[c.id] = '';
                    else if ((c.cellType === 'mixed' || c.cellType === 'smart-select') && c.id) newRecord[c.id] = [];
                }));
            }
            records.push(newRecord);

            isTyping = true; clearTimeout(typingTimer); typingTimer = setTimeout(() => { isTyping = false; }, 1500);
            await persistData(dataPath, records); 
            await SaveManager.flush();             

            renderCurrentSection();
            recalculateTableFormulas();
        });
    });

    document.querySelectorAll('.insert-row-btn').forEach(btn => {
        if (btn._wired) return;
        btn._wired = true;
        btn.addEventListener('click', async () => {
            const dataPath = btn.dataset.path;
            const rowIndex = parseInt(btn.dataset.row); 
            const blockId  = btn.dataset.blockId;
            const block    = findBlock(blockId);
            if (!block) return;

            let records = getNestedValue(currentImData, dataPath);
            if (records && typeof records === 'object' && !Array.isArray(records))
                records = Object.keys(records).sort((a,b)=>a-b).map(k => records[k]);

            if (records === '' || records == null) {
                records = Array.from({ length: block.baseRowCount || 1 }, () => ({}));
            } else if (!Array.isArray(records)) {
                records = [];
            }

            const newRecord = {};
            if (block.rows && block.rows.length > 0) {
                block.rows.forEach(r => r.cells.forEach(c => {
                    if (c.cellType === 'input' && c.id)                              newRecord[c.id] = '';
                    else if ((c.cellType === 'mixed' || c.cellType === 'smart-select') && c.id) newRecord[c.id] = [];
                }));
            }
            
            records.splice(rowIndex + 1, 0, newRecord); 

            isTyping = true; clearTimeout(typingTimer); typingTimer = setTimeout(() => { isTyping = false; }, 1500);
            await persistData(dataPath, records); 
            await SaveManager.flush();            

            renderCurrentSection();
            recalculateTableFormulas();
        });
    });

    document.querySelectorAll('.remove-row-btn').forEach(btn => {
        if (btn._wired) return;
        btn._wired = true;
        btn.addEventListener('click', async () => {
            const dataPath = btn.dataset.path;
            const rowIndex = parseInt(btn.dataset.row);
            const blockId  = btn.dataset.blockId;
            const block    = findBlock(blockId);

            let records = getNestedValue(currentImData, dataPath);
            if (records && typeof records === 'object' && !Array.isArray(records))
                records = Object.keys(records).sort((a,b)=>a-b).map(k => records[k]);

            if (records == null || records === '' || !Array.isArray(records))
                records = [];

            records.splice(rowIndex, 1);

            isTyping = true; clearTimeout(typingTimer); typingTimer = setTimeout(() => { isTyping = false; }, 1500);
            await persistData(dataPath, records);  
            await SaveManager.flush();             

            renderCurrentSection();
            recalculateTableFormulas();
        });
    });
    
    // 🌟 NEW: Insert Inner Matrix Row (Clones the specific row directly in the template)
    document.querySelectorAll('.insert-inner-row-btn').forEach(btn => {
        if (btn._wired) return;
        btn._wired = true;
        btn.addEventListener('click', async () => {
            const blockId = btn.dataset.blockId;
            const ri = parseInt(btn.dataset.ri);
            
            let targetBlock = null;
            for (const sec of imSchema) {
                const b = sec.blocks?.find(b => b.id === blockId);
                if (b) { targetBlock = b; break; }
            }
            if (!targetBlock) return;

            // Clone the exact row clicked
            const rowToClone = targetBlock.rows[ri];
            const newRow = JSON.parse(JSON.stringify(rowToClone));
            
            // Generate fresh IDs so data doesn't overlap
            const makeId = () => Math.random().toString(36).substring(2, 15);
            newRow.id = makeId();
            newRow.cells.forEach(c => {
                c.id = makeId();
            });

            // Splice it directly beneath the clicked row
            targetBlock.rows.splice(ri + 1, 0, newRow);
            targetBlock.numRows = targetBlock.rows.length;

            isTyping = true; clearTimeout(typingTimer); typingTimer = setTimeout(() => { isTyping = false; }, 1500);
            
            // Save the modified schema
            await saveSchema(currentImId, imSchema);
            
            renderCurrentSection();
            recalculateTableFormulas();
        });
    });

    // 🌟 NEW: Remove Inner Matrix Row
    document.querySelectorAll('.remove-inner-row-btn').forEach(btn => {
        if (btn._wired) return;
        btn._wired = true;
        btn.addEventListener('click', async () => {
            const blockId = btn.dataset.blockId;
            const ri = parseInt(btn.dataset.ri);
            
            let targetBlock = null;
            for (const sec of imSchema) {
                const b = sec.blocks?.find(b => b.id === blockId);
                if (b) { targetBlock = b; break; }
            }
            if (!targetBlock || targetBlock.rows.length <= 1) {
                alert("Cannot delete the last row of the template.");
                return; 
            }

            if (!confirm("Delete this row from the template? This will affect all records using this table.")) return;

            targetBlock.rows.splice(ri, 1);
            targetBlock.numRows = targetBlock.rows.length;

            isTyping = true; clearTimeout(typingTimer); typingTimer = setTimeout(() => { isTyping = false; }, 1500);
            
            await saveSchema(currentImId, imSchema);
            
            renderCurrentSection();
            recalculateTableFormulas();
        });
    });
// 🌟 NEW: Add Column dynamically to template
    document.querySelectorAll('.add-col-btn').forEach(btn => {
        if (btn._wired) return;
        btn._wired = true;
        btn.addEventListener('click', async () => {
            const blockId = btn.dataset.blockId;
            let targetBlock = null;
            for (const sec of imSchema) {
                const b = sec.blocks?.find(b => b.id === blockId);
                if (b) { targetBlock = b; break; }
            }
            if (!targetBlock) return;

            // 1. Expand template blueprint
            targetBlock.cols += 1;
            targetBlock.colHeaders.push(`Col ${targetBlock.cols}`);

            // 2. Loop through every row in the template and add a new empty cell
            const makeId = () => Math.random().toString(36).substring(2, 15);
            targetBlock.rows.forEach(row => {
                row.cells.push({
                    id: makeId(), cellType: 'input', inputType: 'text',
                    text: '', placeholder: '', options: ['Option 1', 'Option 2'],
                    formula: '', prefix: '', suffix: '', template: '',
                    conditions: [{ label: 'Yes', template: 'Yes, [text]' }, { label: 'No', template: 'No, [text]' }],
                    colspan: 1, rowspan: 1
                });
            });

            isTyping = true; clearTimeout(typingTimer); typingTimer = setTimeout(() => { isTyping = false; }, 1500);
            await saveSchema(currentImId, imSchema); // Updates the blueprint for everyone
            
            renderCurrentSection();
            recalculateTableFormulas();
        });
    });

    // 🌟 NEW: Remove Last Column dynamically from template
    document.querySelectorAll('.remove-col-btn').forEach(btn => {
        if (btn._wired) return;
        btn._wired = true;
        btn.addEventListener('click', async () => {
            const blockId = btn.dataset.blockId;
            let targetBlock = null;
            for (const sec of imSchema) {
                const b = sec.blocks?.find(b => b.id === blockId);
                if (b) { targetBlock = b; break; }
            }
            if (!targetBlock || targetBlock.cols <= 1) {
                alert("Cannot delete the last column.");
                return;
            }

            if (!confirm("Delete the last column? This removes it for everyone.")) return;

            // Shrink template blueprint
            targetBlock.cols -= 1;
            targetBlock.colHeaders.pop();

            // Remove the last cell from every template row
            targetBlock.rows.forEach(row => {
                row.cells.pop();
            });

            isTyping = true; clearTimeout(typingTimer); typingTimer = setTimeout(() => { isTyping = false; }, 1500);
            await saveSchema(currentImId, imSchema); 
            
            renderCurrentSection();
            recalculateTableFormulas();
        });
    });
    document.querySelectorAll('.add-table-btn').forEach(btn => {
        if (btn._wired) return;
        btn._wired = true;
        btn.addEventListener('click', async () => {
            const dataPath = btn.dataset.path;
            let tableGroups = getNestedValue(currentImData, dataPath);
            if (tableGroups && typeof tableGroups === 'object' && !Array.isArray(tableGroups))
                tableGroups = Object.keys(tableGroups).sort((a,b)=>a-b).map(k => tableGroups[k]);

            if (tableGroups == null || tableGroups === '' || !Array.isArray(tableGroups))
                tableGroups = [];

            const blockId = btn.dataset.blockId;
            const block   = findBlock(blockId);

            tableGroups.push({ rows: Array.from({ length: block?.baseRowCount || 1 }, () => ({})) });

            isTyping = true; clearTimeout(typingTimer); typingTimer = setTimeout(() => { isTyping = false; }, 1500);
            await persistData(dataPath, tableGroups);
            renderCurrentSection();
        });
    });

    document.querySelectorAll('.remove-table-btn').forEach(btn => {
        if (btn._wired) return;
        btn._wired = true;
        btn.addEventListener('click', async () => {
            if (!confirm("Remove this entire table and all its records?")) return;
            const dataPath = btn.dataset.path;
            const tIndex   = parseInt(btn.dataset.index);
            let tableGroups = getNestedValue(currentImData, dataPath);

            if (tableGroups && typeof tableGroups === 'object' && !Array.isArray(tableGroups))
                tableGroups = Object.keys(tableGroups).sort((a,b)=>a-b).map(k => tableGroups[k]);

            if (tableGroups == null || tableGroups === '' || !Array.isArray(tableGroups))
                tableGroups = [];

            tableGroups.splice(tIndex, 1);

            isTyping = true; clearTimeout(typingTimer); typingTimer = setTimeout(() => { isTyping = false; }, 1500);
            await persistData(dataPath, tableGroups);
            renderCurrentSection();
        });
    });

    document.querySelectorAll('.table-cell:not(.computed-cell)').forEach(cell => {
        if (cell._wired) return;
        cell._wired = true;
        if (cell.tagName === 'TEXTAREA') autoGrow(cell);

        let timer = null;
        const saveCell = async () => {
            const dataPath   = cell.dataset.path;
            const rowIdx     = parseInt(cell.dataset.row);
            const colId      = cell.dataset.col;
            const mixedIdx   = cell.dataset.mixedIdx;

            let value = (cell.type === 'checkbox') ? cell.checked : cell.value;
            const isSmartMain = cell.classList.contains('smart-select-main');

            if (cell.tagName === 'SELECT' && value === "__CUSTOM__") {
                const customVal = prompt("Enter custom value:");
                if (!customVal) {
                    const existing = getNestedValue(currentImData, dataPath);
                    if (mixedIdx !== undefined) {
                        cell.value = (existing && existing[rowIdx] && existing[rowIdx][colId] && Array.isArray(existing[rowIdx][colId]) && existing[rowIdx][colId][mixedIdx]) ? existing[rowIdx][colId][mixedIdx] : "";
                    } else {
                        cell.value = (existing && existing[rowIdx]) ? (existing[rowIdx][colId] || "") : "";
                    }
                    return;
                }
                const newOpt = document.createElement('option');
                newOpt.value = customVal;
                newOpt.textContent = customVal;
                newOpt.selected = true;
                cell.insertBefore(newOpt, cell.lastElementChild);
                value = customVal;
            }

            isTyping = true;
            clearTimeout(typingTimer);
            typingTimer = setTimeout(() => { isTyping = false; }, 3000);

            const debounceTime = (isSmartMain || cell.type === 'checkbox') ? 0 : 800;

           clearTimeout(timer);
            timer = setTimeout(async () => {
                let records = getNestedValue(currentImData, dataPath);
                
                if (records && typeof records === 'object' && !Array.isArray(records)) {
                    records = Object.keys(records).sort((a,b)=>a-b).map(k => records[k]);
                }
                if (!records || !Array.isArray(records)) records = [];
                if (!records[rowIdx]) records[rowIdx] = {};

                if (mixedIdx !== undefined) {
                    if (!records[rowIdx][colId] || !Array.isArray(records[rowIdx][colId])) {
                        records[rowIdx][colId] = [];
                    }
                    records[rowIdx][colId][mixedIdx] = value;
                } else {
                    records[rowIdx][colId] = value;
                }

                await persistData(dataPath, records); 
                recalculateTableFormulas();
                if (isSmartMain) renderCurrentSection();
            }, debounceTime);
        };

        cell.addEventListener('input', saveCell);
        if (cell.tagName === 'SELECT' || cell.type === 'checkbox') cell.addEventListener('change', saveCell);
    });
}

function findBlock(blockId) {
    for (const sec of imSchema) {
        const b = sec.blocks?.find(b => b.id === blockId);
        if (b) return b;
    }
    return null;
}

// ── Preview ───────────────────────────────────────────────────────────────────
function renderPreview() {
    const canvas   = document.getElementById('im-canvas');
    if (!canvas) return;

    const sections = [...imSchema].sort((a, b) => a.order - b.order);
    let html = '<div class="preview-wrapper">';

    sections.forEach(sec => {
        html += `<h2 class="preview-section-title">${esc(sec.heading)}</h2>`;
        const blocks = [...(sec.blocks || [])].sort((a, b) => a.order - b.order);

        blocks.forEach(block => {
            if (getNestedValue(currentImData, `_hiddenBlocks.${block.id}`)) return;

            const val = getNestedValue(currentImData, block.dataPath);

            if (block.type === 'h3')      { html += `<h3>${esc(block.label)}</h3>`; return; }
            if (block.type === 'h4')      { html += `<h4>${esc(block.label)}</h4>`; return; }
            if (block.type === 'divider') { html += `<div class="field-divider">${esc(block.label||'')}</div>`; return; }

            if (block.type === 'quill') {
                if (!val) return;
                html += `<div class="preview-narrative">
                    ${block.label ? `<strong>${esc(block.label)}</strong><br>` : ''}
                    ${val}
                </div>`;
                return;
            }

            if (block.type === 'table-static' || block.type === 'table-repeating' || block.type === 'table') {
                html += `<div class="preview-narrative">
                    ${block.label ? `<strong>${esc(block.label)}</strong>` : ''}
                    <div style="font-size:12px;opacity:0.6;border:1px dashed var(--border);padding:10px;margin-top:4px;border-radius:4px;">
                        [ Advanced Dynamic Table Data Generated ]
                    </div>
                </div>`;
                return;
            }

            if (block.type === 'image') {
                let urlList = Array.isArray(val) ? val : (val ? [val] : []);
                if (urlList.length === 0) return;
                
                const imagesHtml = urlList.map(img => {
                    const src = typeof img === 'object' ? img.url : img;
                    const name = typeof img === 'object' ? img.name : '';
                    return `
                    <div style="margin-right:16px; margin-bottom:16px; display:inline-block; text-align:center;">
                        <img src="${esc(src)}" style="max-width:${esc(block.maxWidth || '100%')};${block.maxHeight ? `max-height:${esc(block.maxHeight)};` : ''}border-radius:6px;border:1px solid var(--border);display:block;">
                        ${name ? `<div style="font-size:12px;margin-top:6px;color:var(--text2);">${esc(name)}</div>` : ''}
                    </div>`;
                }).join('');

                html += `<div class="preview-narrative">
                    ${block.label ? `<strong>${esc(block.label)}</strong><br>` : ''}
                    <div style="margin-top:8px;">
                        ${imagesHtml}
                    </div>
                </div>`;
                return;
            }

            if (block.type === 'file') {
                let fileList = Array.isArray(val) ? val : (val ? [val] : []);
                if (fileList.length === 0) return;
                
                const filesHtml = fileList.map(f => {
                    const src = typeof f === 'object' ? f.url : f;
                    const name = typeof f === 'object' ? f.name : 'Attached Document';
                    return `
                    <a href="${esc(src)}" target="_blank" style="margin-right:12px; margin-bottom:12px; display:inline-flex; align-items:center; gap:8px; padding:8px 12px; border:1px solid var(--border); border-radius:6px; background:var(--surface); text-decoration:none; color:var(--text); font-size:13px;">
                        📄 ${esc(name)}
                    </a>`;
                }).join('');

                html += `<div class="preview-narrative">
                    ${block.label ? `<strong>${esc(block.label)}</strong><br>` : ''}
                    <div style="margin-top:8px;">
                        ${filesHtml}
                    </div>
                </div>`;
                return;
            }

            if (val !== undefined && val !== null && val !== '') {
                const displayVal = typeof val === 'boolean' 
                    ? (val ? 'Yes / Checked' : 'No / Unchecked') 
                    : (Array.isArray(val) ? val.join(', ') : val);

                html += `<div class="preview-narrative">
                    ${block.label ? `<strong>${esc(block.label)}</strong><br>` : ''}
                    ${esc(displayVal)}
                </div>`;
            }
        });
    });

    html += '</div>';
    canvas.innerHTML = html;
}

// ── UI setup helpers ──────────────────────────────────────────────────────────
function setupExitBtn() {
    const btn = document.getElementById('exit-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        const name = new URLSearchParams(window.location.search).get('name') || '';
        window.location.href = `module-hub.html?project=${currentProjectId}&name=${encodeURIComponent(name)}`;
    });
}

function setupSidebarToggle() {
    const toggleBtn = document.getElementById('sidebar-toggle');
    const layout = document.querySelector('.im-layout');
    if (toggleBtn && layout) {
        toggleBtn.addEventListener('click', () => {
            layout.classList.toggle('sidebar-collapsed');
        });
    }
}

function setupTheme() {
    const toggle = document.getElementById('theme-toggle');
    if (!toggle) return;
    const saved = localStorage.getItem('im-theme') || 'dark-mode';
    document.body.classList.remove('dark-mode', 'light-mode');
    document.body.classList.add(saved);
    toggle.checked = (saved === 'dark-mode');
    toggle.addEventListener('change', () => {
        const theme = toggle.checked ? 'dark-mode' : 'light-mode';
        document.body.classList.remove('dark-mode', 'light-mode');
        document.body.classList.add(theme);
        localStorage.setItem('im-theme', theme);
    });
}

function setupPreviewBtn() {
    const btn = document.getElementById('preview-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
        isPreviewMode = !isPreviewMode;
        btn.textContent = isPreviewMode ? 'Edit' : 'Preview';
        if (isPreviewMode) renderPreview();
        else renderCurrentSection();
    });
}

function setupExportJsonBtn() {
    const btn = document.getElementById('export-json-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(currentImData, null, 2)], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `${currentImData.title || 'investment-memo'}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });
}

function setupPdfBtn() {
    const btn = document.getElementById('export-pdf-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (!isPreviewMode) {
            isPreviewMode = true;
            renderPreview();
            const prev = document.getElementById('preview-toggle');
            if (prev) prev.textContent = 'Edit';
        }
        setTimeout(() => window.print(), 300);
    });
}

function setupVersionsBtn() {
    const btn   = document.getElementById('versions-btn');
    const modal = document.getElementById('versions-modal');
    const close = document.getElementById('close-versions');
    if (!btn || !modal) return;
    btn.addEventListener('click', () => { modal.classList.remove('hidden'); loadVersions(); });
    close?.addEventListener('click', () => modal.classList.add('hidden'));
}

async function loadVersions() {
    const list = document.getElementById('versions-list');
    if (!list) return;
    list.innerHTML = 'Loading...';
    const snap = await getDocs(collection(db, 'investment-memos', currentImId, 'versions'));
    if (snap.empty) { list.innerHTML = 'No versions yet.'; return; }
    
    const versions = [];
    snap.forEach(d => versions.push({ id: d.id, ...d.data() }));
    versions.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    
    list.innerHTML = versions.map(v => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
            <span style="font-size:13px">${esc(v.label || 'Untitled')} <span style="opacity:0.4;font-size:11px">${v.createdAt?.toDate?.().toLocaleString() || ''}</span></span>
            <button class="fsa-btn" data-restore="${v.id}" style="font-size:11px;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;cursor:pointer;">Restore</button>
        </div>
    `).join('');
    
    list.querySelectorAll('[data-restore]').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm('Restore this version? Current data will be overwritten.')) return;
            
            const vSnap = await getDocs(collection(db, 'investment-memos', currentImId, 'versions'));
            let storageUrl;
            vSnap.forEach(d => { if (d.id === btn.dataset.restore) storageUrl = d.data().storageUrl; });
            
            if (!storageUrl) { alert("Version data missing."); return; }

            const response = await fetch(storageUrl);
            const restoredData = await response.json();
            
            for (const key of Object.keys(restoredData)) {
                SaveManager.queue(key, restoredData[key]);
            }
            
            document.getElementById('versions-modal').classList.add('hidden');
        });
    });
}

function setupCommitBtn() {
    const btn = document.getElementById('commit-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        const label = prompt('Version label (e.g. "After IC Review"):');
        if (!label) return;
        btn.disabled = true;
        btn.textContent = 'Saving...';
        try {
            const jsonString = JSON.stringify(currentImData);
            const blob = new Blob([jsonString], { type: 'application/json' });
            const safeLabel = label.replace(/[^a-zA-Z0-9]/g, '_');
            const vRef = storageRef(storage, `im-versions/${currentImId}/${Date.now()}_${safeLabel}.json`);
            
            await uploadBytes(vRef, blob);
            const downloadUrl = await getDownloadURL(vRef);

            await addDoc(collection(db, 'investment-memos', currentImId, 'versions'), {
                label,
                storageUrl: downloadUrl,
                createdAt: serverTimestamp(),
                createdBy: currentUserName
            });
            alert('Version saved.');
        } catch (e) {
            alert('Failed: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Commit Version';
        }
    });
}

function setupGlobalClickHandlers() {
    document.addEventListener('click', async (e) => {
        const collabBtn = e.target.closest('#collab-toggle');
        if (collabBtn) {
            const listContainer = document.getElementById('collab-list');
            if (listContainer) {
                const isHidden = listContainer.style.display === 'none';
                listContainer.style.display = isHidden ? 'block' : 'none';
                const arrow = collabBtn.querySelector('.nav-arrow');
                if (arrow) arrow.style.transform = isHidden ? 'rotate(90deg)' : 'rotate(0deg)';
            }
            return;
        }

        const hideBtn = e.target.closest('.hide-block-btn');
        if (hideBtn) {
            e.preventDefault(); 
            e.stopPropagation(); 
            
            const blockId = hideBtn.dataset.blockId;
            isTyping = true; clearTimeout(typingTimer); typingTimer = setTimeout(() => { isTyping = false; }, 1500);
            
            if (!currentImData._hiddenBlocks) currentImData._hiddenBlocks = {};
            currentImData._hiddenBlocks[blockId] = true;
            
            await persistData(`_hiddenBlocks.${blockId}`, true);
            renderCurrentSection(); 
            return;
        }

        const restoreBtn = e.target.closest('.restore-block-btn');
        if (restoreBtn) {
            e.preventDefault(); 
            e.stopPropagation();
            
            const blockId = restoreBtn.dataset.blockId;
            isTyping = true; clearTimeout(typingTimer); typingTimer = setTimeout(() => { isTyping = false; }, 1500);
            
            if (!currentImData._hiddenBlocks) currentImData._hiddenBlocks = {};
            currentImData._hiddenBlocks[blockId] = false;
            
            await persistData(`_hiddenBlocks.${blockId}`, false);
            renderCurrentSection(); 
            return;
        }
    });
}

function autoGrow(el) {
    const resize = () => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; };
    resize();
    el.addEventListener('input', resize);
}

function wireFileControls() {
    document.querySelectorAll('.file-upload-input').forEach(input => {
        if (input._wired) return;
        input._wired = true;
        input.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const dataPath = input.dataset.path;
            const isMultiple = input.dataset.multiple === 'true';

            const fileName = prompt("Please enter a display name for this file:", file.name);
            if (fileName === null) return; 

            const labelBtn = input.previousElementSibling;
            const originalText = labelBtn.innerHTML;
            labelBtn.innerHTML = '⏳ Uploading to Cloud...';
            labelBtn.style.opacity = '0.7';
            labelBtn.style.pointerEvents = 'none';

            try {
                const safeFileName = file.name.replace(/[^a-zA-Z0-9.]/g, '_');
                const fileRef = storageRef(storage, `im-files/${currentImId}/${Date.now()}_${safeFileName}`);
                
                await uploadBytes(fileRef, file);
                const downloadURL = await getDownloadURL(fileRef);

                const fileObj = { url: downloadURL, name: fileName, type: file.type };
                let currentFiles = getNestedValue(currentImData, dataPath);
                
                if (!Array.isArray(currentFiles)) currentFiles = currentFiles ? [currentFiles] : [];

                if (isMultiple) {
                    currentFiles.push(fileObj);
                } else {
                    currentFiles = [fileObj]; 
                }

                await persistData(dataPath, currentFiles);
                renderCurrentSection();
            } catch (error) {
                console.error("Upload failed:", error);
                alert("Upload failed. Please ensure Firebase Storage is enabled in your Firebase Console.");
            } finally {
                labelBtn.innerHTML = originalText;
                labelBtn.style.opacity = '1';
                labelBtn.style.pointerEvents = 'auto';
                input.value = ''; 
            }
        });
    });

    document.querySelectorAll('.file-remove-btn').forEach(btn => {
        if (btn._wired) return;
        btn._wired = true;
        btn.addEventListener('click', async () => {
            if (!confirm("Remove this file attachment?")) return;
            
            const blockId = btn.dataset.blockId;
            const inputEl = document.querySelector(`.file-upload-input[data-block-id="${blockId}"]`);
            if (!inputEl) return;
            
            const dataPath = inputEl.dataset.path;
            const urlToRemove = btn.dataset.url;

            let currentFiles = getNestedValue(currentImData, dataPath);
            if (!Array.isArray(currentFiles)) currentFiles = currentFiles ? [currentFiles] : [];

            currentFiles = currentFiles.filter(u => {
                const src = typeof u === 'object' ? u.url : u;
                return src !== urlToRemove;
            });

            await persistData(dataPath, currentFiles);
            renderCurrentSection();
        });
    });
}

function wireImageControls() {
    document.querySelectorAll('.img-upload-input').forEach(input => {
        if (input._wired) return;
        input._wired = true;
        input.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const dataPath = input.dataset.path;
            const isMultiple = input.dataset.multiple === 'true';

            const imageName = prompt("Please enter a name/caption for this image:", "Untitled");
            if (imageName === null) return; 

            const labelBtn = input.previousElementSibling;
            const originalText = labelBtn.innerHTML;
            labelBtn.innerHTML = '⏳ Uploading to Cloud...';
            labelBtn.style.opacity = '0.7';
            labelBtn.style.pointerEvents = 'none';

            try {
                const safeFileName = file.name.replace(/[^a-zA-Z0-9.]/g, '_');
                const fileRef = storageRef(storage, `im-images/${currentImId}/${Date.now()}_${safeFileName}`);
                
                await uploadBytes(fileRef, file);
                const downloadURL = await getDownloadURL(fileRef);

                const imageObj = { url: downloadURL, name: imageName };
                let currentUrls = getNestedValue(currentImData, dataPath);
                
                if (!Array.isArray(currentUrls)) currentUrls = currentUrls ? [currentUrls] : [];

                if (isMultiple) {
                    currentUrls.push(imageObj);
                } else {
                    currentUrls = [imageObj]; 
                }

                await persistData(dataPath, currentUrls);
                renderCurrentSection();
            } catch (error) {
                console.error("Upload failed:", error);
                alert("Upload failed. Please ensure Firebase Storage is enabled in your Firebase Console.");
            } finally {
                labelBtn.innerHTML = originalText;
                labelBtn.style.opacity = '1';
                labelBtn.style.pointerEvents = 'auto';
                input.value = ''; 
            }
        });
    });

    document.querySelectorAll('.img-remove-btn').forEach(btn => {
        if (btn._wired) return;
        btn._wired = true;
        btn.addEventListener('click', async () => {
            if (!confirm("Remove this image?")) return;
            
            const blockId = btn.dataset.blockId;
            const inputEl = document.querySelector(`.img-upload-input[data-block-id="${blockId}"]`);
            if (!inputEl) return;
            
            const dataPath = inputEl.dataset.path;
            const urlToRemove = btn.dataset.url;

            let currentUrls = getNestedValue(currentImData, dataPath);
            if (!Array.isArray(currentUrls)) currentUrls = currentUrls ? [currentUrls] : [];

            currentUrls = currentUrls.filter(u => {
                const src = typeof u === 'object' ? u.url : u;
                return src !== urlToRemove;
            });

            await persistData(dataPath, currentUrls);
            renderCurrentSection();
        });
    });
}

let activeComments = [];
let currentSelectionData = null;
let currentCommentTab = 'open'; 

function initCommentsEngine() {
    const commentsRef = collection(db, 'investment-memos', currentImId, 'comments');
    
    onSnapshot(commentsRef, (snap) => {
        activeComments = [];
        let unreadCount = 0;

        snap.forEach(doc => {
            const data = doc.data();
            activeComments.push({ id: doc.id, ...data });

            const isAssignedToMe = data.assignedTo?.some(u => u.uid === currentUserId);
            const hasIReadIt = (data.readBy || []).includes(currentUserId);
            
            if (isAssignedToMe && !hasIReadIt) {
                unreadCount++;
            }
        });

        updateNotificationUI(unreadCount);
        renderCommentsPanel();
    });

    loadUsersForComments();

    document.getElementById('comments-toggle-btn')?.addEventListener('click', () => {
        document.getElementById('comments-panel')?.classList.add('open');
        activeComments.forEach(async (c) => {
            const currentReadBy = c.readBy || []; 
            if (!currentReadBy.includes(currentUserId)) {
                const commentRef = doc(db, 'investment-memos', currentImId, 'comments', c.id);
                await updateDoc(commentRef, { readBy: [...currentReadBy, currentUserId] });
            }
        });
    });

    document.getElementById('close-comments-btn')?.addEventListener('click', () => {
        document.getElementById('comments-panel')?.classList.remove('open');
        clearHighlights();
    });

    document.querySelectorAll('.comment-tab').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.comment-tab').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            currentCommentTab = e.target.dataset.tab;
            renderCommentsPanel();
        });
    });
    document.getElementById('comment-section-filter')?.addEventListener('change', renderCommentsPanel);

    document.addEventListener('mouseup', (e) => {
        const floatBtn = document.getElementById('comment-float-btn');
        if (e.target.closest('#comments-panel') || e.target.closest('#comment-box') || e.target.closest('#comment-float-btn')) return;

        const selection = window.getSelection();
        const text = selection.toString().trim();
        const field = e.target.closest('.editor-field, .ql-editor, .table-cell');

        if (text && field && floatBtn) {
            const container = field.classList.contains('ql-editor') ? field.parentElement : field;
            const dataPath = container.dataset.path;

            if (dataPath) {
                currentSelectionData = { quotedText: text, dataPath: dataPath, sectionKey: currentSectionKey };
                
                floatBtn.style.display = 'block';
                floatBtn.style.position = 'fixed';
                floatBtn.style.zIndex = '9998';
                
                let topPos = e.clientY + 15;
                let leftPos = e.clientX + 10;
                
                if (leftPos + 150 > window.innerWidth) leftPos = window.innerWidth - 160;
                if (topPos + 50 > window.innerHeight) topPos = window.innerHeight - 60;
                
                floatBtn.style.top = topPos + 'px';
                floatBtn.style.left = leftPos + 'px';
            }
        } else {
            if (floatBtn) floatBtn.style.display = 'none';
        }
    });

    document.getElementById('comment-float-btn')?.addEventListener('click', (e) => {
        const floatBtn = document.getElementById('comment-float-btn'); 
        const box = document.getElementById('comment-box');
        
        floatBtn.style.display = 'none';
        
        if (box) {
            box.style.display = 'block';
            box.style.position = 'fixed'; 
            box.style.zIndex = '9999';
            
            let boxTop = parseInt(floatBtn.style.top, 10);
            let boxLeft = parseInt(floatBtn.style.left, 10);
            
            if (boxLeft + 300 > window.innerWidth) boxLeft = window.innerWidth - 320;
            if (boxTop + 250 > window.innerHeight) boxTop = window.innerHeight - 260;

            box.style.top = boxTop + 'px';
            box.style.left = boxLeft + 'px';
        }
        
        const quoteSpan = document.getElementById('cb-quoted-text');
        if (quoteSpan) quoteSpan.textContent = currentSelectionData.quotedText;
        
        document.getElementById('comment-input')?.focus();
    });

    document.getElementById('comment-cancel-btn')?.addEventListener('click', () => {
        const box = document.getElementById('comment-box');
        if (box) box.style.display = 'none';
        const input = document.getElementById('comment-input');
        if (input) input.value = '';
    });

    document.getElementById('comment-send-btn')?.addEventListener('click', async () => {
        const textInput = document.getElementById('comment-input').value.trim();
        if (!textInput) return alert("Comment cannot be empty.");

        const assignedCheckboxes = document.querySelectorAll('.user-assign-cb:checked');
        const assignedUsers = Array.from(assignedCheckboxes).map(cb => ({
            uid: cb.value, name: cb.dataset.name, email: cb.dataset.email
        }));

        const newComment = {
            text: textInput,
            quotedText: currentSelectionData.quotedText,
            dataPath: currentSelectionData.dataPath,
            sectionKey: currentSelectionData.sectionKey,
            status: 'open',
            assignedTo: assignedUsers,
            createdBy: currentUserName,
            createdAt: serverTimestamp(),
            readBy: [currentUserId],
            replies: []
        };

        try {
            await addDoc(collection(db, 'investment-memos', currentImId, 'comments'), newComment);
            sendEmailNotification(newComment, assignedUsers);

            document.getElementById('comment-box').style.display = 'none';
            document.getElementById('comment-input').value = '';
            document.getElementById('comments-panel')?.classList.add('open'); 
        } catch (error) {
            console.error("Error saving comment:", error);
            alert("Failed to save comment.");
        }
    });
}

function renderCommentsPanel() {
    const listEl = document.getElementById('comments-list');
    if (!listEl) return;

    const filterVal = document.getElementById('comment-section-filter')?.value || 'all';
    
    const filtered = activeComments.filter(c => {
        const matchStatus = c.status === currentCommentTab;
        const matchSection = filterVal === 'all' || c.sectionKey === currentSectionKey;
        return matchStatus && matchSection;
    });

    filtered.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));

    if (filtered.length === 0) {
        listEl.innerHTML = `<div style="opacity:0.5;text-align:center;margin-top:20px;">No ${currentCommentTab} comments.</div>`;
        return;
    }

    listEl.innerHTML = filtered.map(c => {
        const dateStr = c.createdAt?.toDate ? c.createdAt.toDate().toLocaleString() : 'Just now';
        const assignedTags = c.assignedTo?.map(u => `@${esc(u.name)}`).join(' ') || '';
        
        const repliesHtml = (c.replies || []).map(r => `
            <div style="background:var(--surface);padding:6px;margin-top:6px;border-radius:4px;font-size:11px;">
                <strong>${esc(r.createdBy)}:</strong> ${esc(r.text)}
            </div>
        `).join('');

        return `
        <div class="comment-card" data-id="${c.id}" data-path="${esc(c.dataPath)}">
            <div class="comment-meta">
                <span><strong>${esc(c.createdBy)}</strong></span>
                <span>${dateStr}</span>
            </div>
            <div class="comment-quote">"${esc(c.quotedText)}"</div>
            <div style="margin-bottom:6px;">${esc(c.text)}</div>
            ${assignedTags ? `<div style="color:var(--s-accent);font-size:11px;font-weight:600;">${assignedTags}</div>` : ''}
            ${repliesHtml}
            <div class="comment-actions">
                <button class="reply-btn" data-id="${c.id}">Reply</button>
                ${c.status === 'open' 
                    ? `<button class="resolve-btn" data-id="${c.id}">✓ Resolve</button>` 
                    : `<button class="resolve-btn" data-id="${c.id}">Re-open</button>`}
                <button class="delete-btn" data-id="${c.id}">Delete</button>
            </div>
        </div>
        `;
    }).join('');

    wireCommentCardEvents();
}

function updateNotificationUI(count) {
    const btn = document.getElementById('comments-toggle-btn');
    if (!btn) return;
    
    const oldBadge = btn.querySelector('.comment-badge');
    if (oldBadge) oldBadge.remove();

    if (count > 0) {
        const badge = document.createElement('span');
        badge.className = 'comment-badge';
        badge.textContent = count;
        btn.appendChild(badge);
    }
}
window.updateNotificationUI = updateNotificationUI;

function wireCommentCardEvents() {
    document.querySelectorAll('.comment-card').forEach(card => {
        card.addEventListener('click', async (e) => {
            if (e.target.tagName === 'BUTTON') return; 

            const commentId = card.dataset.id;
            const targetComment = activeComments.find(c => c.id === commentId);
            if (!targetComment) return;

            document.querySelectorAll('.comment-card').forEach(c => c.classList.remove('active-card'));
            card.classList.add('active-card');
            clearHighlights();

            const targetSectionKey = targetComment.sectionKey;
            const dataPath = targetComment.dataPath;

            if (targetSectionKey && targetSectionKey !== currentSectionKey) {
                navigateTo(targetSectionKey);
                setTimeout(() => performHighlight(dataPath), 300);
            } else {
                performHighlight(dataPath);
            }
        });
    });

    document.querySelectorAll('.reply-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const replyText = prompt("Type your reply:");
            if (!replyText) return;
            
            const commentId = btn.dataset.id;
            const commentRef = doc(db, 'investment-memos', currentImId, 'comments', commentId);
            const targetComment = activeComments.find(c => c.id === commentId);
            const replies = targetComment.replies || [];
            
            replies.push({ text: replyText, createdBy: currentUserName, createdAt: new Date().toISOString() });
            await updateDoc(commentRef, { replies });
        });
    });

    document.querySelectorAll('.resolve-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const commentId = btn.dataset.id;
            const targetComment = activeComments.find(c => c.id === commentId);
            const newStatus = targetComment.status === 'open' ? 'resolved' : 'open';
            
            const commentRef = doc(db, 'investment-memos', currentImId, 'comments', commentId);
            await updateDoc(commentRef, { status: newStatus });
        });
    });

    document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm("Delete this comment permanently?")) return;
            const commentId = btn.dataset.id;
            await deleteDoc(doc(db, 'investment-memos', currentImId, 'comments', commentId));
        });
    });
}

function clearHighlights() {
    document.querySelectorAll('.comment-active-glow').forEach(el => el.classList.remove('comment-active-glow'));
}

function performHighlight(dataPath) {
    const targetField = document.querySelector(`[data-path="${dataPath}"]`);
    if (targetField) {
        targetField.classList.add('comment-active-glow');
        targetField.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targetField.style.transition = 'all 0.3s ease';
    } else {
        console.warn(`Highlight failed: Field with path ${dataPath} not found on this page.`);
    }
}

async function loadUsersForComments() {
    const listEl = document.getElementById('assign-users-list');
    if (!listEl) return;
    try {
        const usersSnap = await getDocs(collection(db, 'workspace-users')); 
        let usersHtml = '';
        usersSnap.forEach(u => {
            const data = u.data();
            const name = data.displayName || data.email || 'User';
            usersHtml += `
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;">
                <input type="checkbox" class="user-assign-cb" value="${u.id}" data-name="${esc(name)}" data-email="${esc(data.email)}">
                ${esc(name)}
            </label>`;
        });
        
        if (!usersHtml) usersHtml = `<div style="font-size:12px;opacity:0.4">No users found in workspace-users.</div>`;
        listEl.innerHTML = usersHtml;
    } catch(e) {
        console.error("Error loading workspace-users:", e);
        listEl.innerHTML = `<div style="color:red;font-size:11px;">Error loading users</div>`;
    }
}

async function sendEmailNotification(commentData, assignedUsers) {
    if (assignedUsers.length === 0) return;
    
    const mailRef = collection(db, 'mail');

    for (const user of assignedUsers) {
        await addDoc(mailRef, {
            to: user.email,
            message: {
                subject: `New Mention: ${commentData.createdBy} tagged you in an IM`,
                html: `
                    <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
                        <h2 style="color: #7c5cfc;">New Comment Notification</h2>
                        <p><strong>${commentData.createdBy}</strong> tagged you in a comment:</p>
                        <blockquote style="background: #f9f9f9; border-left: 4px solid #7c5cfc; padding: 10px; font-style: italic;">
                            "${commentData.quotedText}"
                        </blockquote>
                        <p><strong>Comment:</strong> ${commentData.text}</p>
                        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                        <a href="${window.location.href}" style="background: #7c5cfc; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">View in Redwood</a>
                    </div>
                `
            }
        });
    }
    console.log("Email tasks queued in Firestore.");
}

function recalculateTableFormulas() {
  document.querySelectorAll('.computed-cell').forEach(cell => {
    const formula = cell.dataset.formula;
    if (!formula) return;

    const table = cell.closest('table');
    const recIdx = cell.dataset.row; 

    let solvedFormula = formula;

    solvedFormula = solvedFormula.replace(/SUM\([RC]*(\d+)\)/gi, (match, c) => {
        let sum = 0;
        table.querySelectorAll(`[data-col-idx="${c}"]`).forEach(input => {
            if (input === cell) return; 
            const val = parseFloat(input.value.replace(/[^0-9.-]/g, '')) || 0;
            sum += val;
        });
        return sum;
    });

    solvedFormula = solvedFormula.replace(/R(\d+)C(\d+)/gi, (match, r, c) => {
        const targetInput = table.querySelector(`[data-row="${r}"][data-col-idx="${c}"]`);
        if (targetInput === cell) return 0;
        const val = targetInput ? targetInput.value.replace(/[^0-9.-]/g, '') || '0' : '0';
        return parseFloat(val) || 0;
    });

    solvedFormula = solvedFormula.replace(/\bC(\d+)\b/gi, (match, c) => {
        const targetInput = table.querySelector(`[data-row="${recIdx}"][data-col-idx="${c}"]`);
        if (targetInput === cell) return 0;
        const val = targetInput ? targetInput.value.replace(/[^0-9.-]/g, '') || '0' : '0';
        return parseFloat(val) || 0;
    });

    try {
        const cleanFormula = solvedFormula.replace(/\s+/g, '');
        if (!/^[0-9+\-*/().]+$/.test(cleanFormula)) return;
        
        const result = new Function(`"use strict"; return (${cleanFormula})`)();
        const fmt = cell.dataset.format || 'raw';
        
        if (Number.isFinite(result)) {
            cell.value = fmt === 'percent' ? result.toLocaleString() + '%' : result.toLocaleString();
        } else {
            cell.value = '';
        }
    } catch(e) {}
  });
}