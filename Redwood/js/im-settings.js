// js/im-settings.js

import { loadSchema, saveSchema, subscribeToSchema } from './im-core/schema-service.js';
import { generateId } from './im-core/utils.js';
import { auth, rtdb } from './firebase.js'; 
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { ref, onValue, set, onDisconnect, remove, serverTimestamp as rtdbTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

// --- Block Type Definitions ---
const BLOCK_TYPES = [
    { id: 'instruction',     icon: 'info',             label: 'Instruction / Note',  desc: 'Read-only guidance text' },
    { id: 'text',            icon: 'type',             label: 'Short Text',           desc: 'Single line text input' },
    { id: 'textarea',        icon: 'align-left',       label: 'Long Text',            desc: 'Multi-line text area' },
    { id: 'mixed',           icon: 'align-justify',    label: 'Fill-in-the-Blanks',  desc: 'Sentence with inline inputs' },
    { id: 'quill',           icon: 'pen-tool',         label: 'Rich Text',            desc: 'WYSIWYG editor' },
    { id: 'number',          icon: 'hash',             label: 'Number',               desc: 'Numeric values & currencies' },
    { id: 'date',            icon: 'calendar',         label: 'Date',                 desc: 'Date picker' },
    { id: 'email',           icon: 'mail',             label: 'Email',                desc: 'Email address field' },
    { id: 'select',          icon: 'list',             label: 'Dropdown',             desc: 'Single select menu' },
    { id: 'table-static',    icon: 'table-properties', label: 'Single Table',         desc: 'Fixed matrix table' },
    { id: 'table-repeating', icon: 'table',            label: 'Repeating Tables',     desc: 'Groups of dynamic tables' },
    { id: 'image',           icon: 'image',            label: 'Image Upload',         desc: 'Attach screenshots/images' },
    { id: 'h3',              icon: 'heading-3',        label: 'Heading',              desc: 'H3 Section Title' },
    { id: 'h4',              icon: 'heading-4',        label: 'Subheading',           desc: 'H4 Section Title' },
    { id: 'divider',         icon: 'minus',            label: 'Divider',              desc: 'Horizontal line' }
];

// --- Core Application State ---
class SchemaState {
    constructor() {
        this.schema = [];
        this.activeSectionId = null;
        this.activeBlockId = null;
        this.selectionType = null;
    }

    autoDataPath(sectionKey, label) {
        const camel = (label || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+(.)/g, (_, c) => c.toUpperCase());
        return camel ? `${sectionKey}.${camel}` : `${sectionKey}.field_${generateId().slice(0, 4)}`;
    }

    addSection(parentId = null) {
        const id = generateId();
        const newSec = {
            id,
            key: `sec_${id.replace(/-/g, '')}`,
            navLabel: parentId ? 'New Subsection' : 'New Section',
            heading:  parentId ? 'New Subsection' : 'New Section',
            order: this.schema.filter(s => s.parentId === parentId).length,
            parentId: parentId,
            blocks: []
        };
        this.schema.push(newSec);
        return newSec;
    }

    deleteSection(id) {
        this.schema = this.schema.filter(s => s.id !== id && s.parentId !== id);
        if (this.activeSectionId === id) this.activeSectionId = null;
    }

    addBlock(sectionId, type) {
        const section = this.schema.find(s => s.id === sectionId);
        if (!section) return null;
        const isLayout = ['h3', 'h4', 'divider', 'instruction'].includes(type);
        const base = {
            id: generateId(),
            type: type,
            label: isLayout ? (type === 'instruction' ? 'Instruction' : 'Heading Text') : 'New ' + type,
            dataPath: '',
            prefix: '',
            suffix: '',
            order: section.blocks.length
        };
        if (type === 'select') base.options = ['Option 1', 'Option 2'];
        if (type === 'instruction') { base.content = ''; base.placeholder = ''; }
        if (type === 'mixed') { base.template = 'Sentence with [text] and [select].'; base.options = ['Option 1', 'Option 2']; }
        if (type === 'image') { base.multiple = false; base.maxWidth = '100%'; base.maxHeight = ''; }
        
        // 🌟 MATRIX CONFIGURATION
        if (type === 'table-static' || type === 'table-repeating') {
            base.cols = 2;
            base.numRows = 1;
            base.baseRowCount = 1;
            base.dynamicRows = true;
            base.allowInlineInsert = false; 
            base.allowDynamicColumns = false;
            base.editableHeaders = false;
            base.colHeaders = ['Col 1', 'Col 2'];
            base.rows = [{
                id: generateId(),
                cells: [
                    {
                        id: generateId(), cellType: 'input', inputType: 'text',
                        text: '', prefix: '', suffix: '', template: '',
                        options: ['Option 1', 'Option 2'],
                        conditions: [{ label: 'Yes', template: 'Yes, [text]' }, { label: 'No', template: 'No, [text]' }],
                        colspan: 1, rowspan: 1
                    },
                    {
                        id: generateId(), cellType: 'input', inputType: 'text',
                        text: '', prefix: '', suffix: '', template: '',
                        options: ['Option 1', 'Option 2'],
                        conditions: [{ label: 'Yes', template: 'Yes, [text]' }, { label: 'No', template: 'No, [text]' }],
                        colspan: 1, rowspan: 1
                    }
                ]
            }];
        }
        if (!isLayout) {
            base.dataPath = this.autoDataPath(section.key, base.label);
        }
        section.blocks.push(base);
        return base;
    }

    deleteBlock(sectionId, blockId) {
        const sec = this.schema.find(s => s.id === sectionId);
        if (sec) {
            sec.blocks = sec.blocks.filter(b => b.id !== blockId);
            if (this.activeBlockId === blockId) this.activeBlockId = null;
        }
    }

    getSection(id) { return this.schema.find(s => s.id === id); }
    getBlock(secId, blkId) { return this.getSection(secId)?.blocks.find(b => b.id === blkId); }
}

// --- Application Controller ---
class App {
    constructor() {
        this.state = new SchemaState();
        this.els = {
            sectionList:    document.getElementById('section-list'),
            blockList:      document.getElementById('block-list'),
            inspector:      document.getElementById('inspector-panel'),
            emptyState:     document.getElementById('canvas-empty-state'),
            activeSecTitle: document.getElementById('active-section-title'),
            btnAddBlock:    document.getElementById('btn-add-block'),
            modal:          document.getElementById('block-selector-modal')
        };
        this.sortables = { sections: null, blocks: null };
        this._schemaLoadedOk = false;
        
        this.isTyping = false;
        this.unsubscribeSchema = null;

        this.currentUser = null;
        this.isReadOnly = false;
        this.lockRef = null;
        this.imId = null;
        this.schemaKey = 'im';
    }

    async boot() {
        if (window.lucide) lucide.createIcons();
        this.bindEvents();
        this.renderBlockSelector();

        // 🌟 Ensure we extract the specific IM ID
        const urlParams = new URLSearchParams(window.location.search);
        this.schemaKey = (urlParams.get('schema') || 'im').toLowerCase();
        this.imId = urlParams.get('id') || urlParams.get('im') || urlParams.get('fc');
        const lastIm = sessionStorage.getItem('last-im-url');
        const lastFc = sessionStorage.getItem('last-fc-url');

        if (!this.imId && this.schemaKey === 'im' && lastIm) {
            try { this.imId = new URL(lastIm).searchParams.get('id') || new URL(lastIm).searchParams.get('im'); } 
            catch(e) {}
        }

        const backBtn = document.getElementById('back-btn');
        if (backBtn) {
            if (this.schemaKey === 'fc') {
                backBtn.href = `fc.html?${urlParams.toString() || ''}` || 'fc.html';
                if (lastFc) backBtn.href = lastFc;
                backBtn.textContent = '← Back to FC';
            } else if (lastIm) {
                backBtn.href = lastIm;
            }
        }

        if (this.schemaKey === 'im' && !this.imId) {
            alert('⚠️ No IM ID detected in URL. Please open Settings directly from an active IM.');
            return;
        }

        // Wait for Firebase Auth
        await new Promise(resolve => onAuthStateChanged(auth, user => {
            if (user) {
                this.currentUser = user;
                resolve();
            } else {
                window.location.href = 'login.html';
            }
        }));

        // Global Typing Guard
        document.addEventListener('focusin', (e) => {
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) this.isTyping = true;
        });
        document.addEventListener('focusout', (e) => {
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) this.isTyping = false;
        });

        // Setup Realtime Database Padlock per IM
        this.lockRef = ref(rtdb, `system-locks/schema-${this.schemaKey}`);
        onValue(this.lockRef, (snap) => {
            const lockData = snap.val();
            
            if (lockData && lockData.userId !== this.currentUser.uid) {
                this.enforceReadOnly(lockData.userName);
            } else {
                this.enableEditing();
                
                if (!lockData) {
                    set(this.lockRef, {
                        userId: this.currentUser.uid,
                        userName: this.currentUser.displayName || this.currentUser.email.split('@')[0],
                        timestamp: rtdbTimestamp()
                    });
                    onDisconnect(this.lockRef).remove();
                }
            }
        });

        // Start Multiplayer Sync 
        this.unsubscribeSchema = subscribeToSchema(this.imId, (sections) => {
            if (!this.isTyping) {
                this.state.schema = sections || [];
                this._schemaLoadedOk = true;
                this.renderSections();
                this.renderBlocks();
                this.renderInspector();
            }
        }, this.schemaKey);

        const titleLabel = document.querySelector('header span.text-sm.font-semibold.text-gray-400');
        if (titleLabel) titleLabel.textContent = `${this.schemaKey.toUpperCase()} Schema Architect`;
        document.title = `${this.schemaKey.toUpperCase()} Schema Editor – Redwood`;

        window.__app = this;
    }

    enforceReadOnly(lockerName) {
        if (!this.isReadOnly) {
            this.showToast(`🔒 Read Only: ${lockerName} is currently modifying the schema.`, true);
        }
        this.isReadOnly = true;
        
        const btnSave = document.getElementById('btn-save');
        if (btnSave) {
            btnSave.disabled = true;
            btnSave.innerHTML = `🔒 Locked by ${lockerName}`;
            btnSave.className = 'flex items-center gap-2 px-4 py-1.5 rounded bg-surface-border text-sm font-bold text-gray-400 shadow-none cursor-not-allowed';
        }

        const btnImport = document.getElementById('btn-import');
        const btnAddSec = document.getElementById('btn-add-section');
        const btnAddBlk = document.getElementById('btn-add-block');
        
        if (btnImport) btnImport.style.display = 'none';
        if (btnAddSec) btnAddSec.style.display = 'none';
        if (btnAddBlk) btnAddBlk.style.display = 'none';

        if (this.sortables.sections) this.sortables.sections.options.disabled = true;
        if (this.sortables.blocks) this.sortables.blocks.options.disabled = true;

        this.renderSections(); 
        this.renderBlocks();
        this.renderInspector();
    }

    enableEditing() {
        this.isReadOnly = false;
        
        const btnSave = document.getElementById('btn-save');
        if (btnSave) {
            btnSave.disabled = false;
            btnSave.innerHTML = `<i data-lucide="save" class="w-4 h-4"></i> Deploy Schema`;
            btnSave.className = 'flex items-center gap-2 px-4 py-1.5 rounded bg-redwood-600 hover:bg-redwood-500 transition-colors text-sm font-bold text-white shadow-lg shadow-redwood-900/20';
        }

        const btnImport = document.getElementById('btn-import');
        const btnAddSec = document.getElementById('btn-add-section');
        const btnAddBlk = document.getElementById('btn-add-block');

        if (btnImport) btnImport.style.display = 'flex';
        if (btnAddSec) btnAddSec.style.display = 'block';
        if (btnAddBlk && this.state.activeSectionId) btnAddBlk.style.display = 'flex';

        if (this.sortables.sections) this.sortables.sections.options.disabled = false;
        if (this.sortables.blocks) this.sortables.blocks.options.disabled = false;

        this.renderSections();
        this.renderBlocks();
        this.renderInspector();
    }


    renderSections() {
        this.els.sectionList.innerHTML = '';
        const parents = this.state.schema.filter(s => !s.parentId).sort((a, b) => a.order - b.order);

        const appendSection = (sec, isChild) => {
            const div = document.createElement('div');
            const isActive = this.state.activeSectionId === sec.id;
            div.className = `group flex items-center justify-between p-3 rounded-lg border transition-all cursor-pointer mb-2 ${isActive ? 'bg-redwood-500/10 border-redwood-500/50' : 'bg-surface-card border-surface-border hover:border-gray-500'}`;
            if (isChild) div.style.marginLeft = '24px';
            div.dataset.id = sec.id;
            
            div.innerHTML = `
                <div class="flex items-center gap-3 overflow-hidden w-full">
                    <i data-lucide="grip-vertical" class="w-4 h-4 text-gray-500 ${this.isReadOnly ? '' : 'drag-handle hover:text-white cursor-move'} shrink-0"></i>
                    ${isChild ? `<span class="text-gray-600 font-bold shrink-0">↳</span>` : ''}
                    <div class="truncate flex-1">
                        <div class="text-sm font-bold text-white truncate">${this.esc(sec.navLabel)}</div>
                        <div class="text-[10px] text-gray-500 font-mono mt-0.5 truncate">${this.esc(sec.key)}</div>
                    </div>
                    ${!isChild && !this.isReadOnly ? `<button class="btn-add-sub text-gray-500 hover:text-white px-1 shrink-0" title="Add Subsection"><i data-lucide="plus" class="w-4 h-4"></i></button>` : ''}
                    ${!this.isReadOnly ? `<button class="text-gray-500 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity btn-delete-sec px-1 shrink-0" title="Delete"><i data-lucide="trash-2" class="w-4 h-4"></i></button>` : ''}
                </div>`;

            div.addEventListener('click', (e) => {
                if (e.target.closest('.btn-delete-sec') || e.target.closest('.btn-add-sub') || e.target.closest('.drag-handle')) return;
                this.selectSection(sec.id);
            });

            if (!this.isReadOnly) {
                div.querySelector('.btn-delete-sec')?.addEventListener('click', () => {
                    if (confirm(`Delete "${sec.navLabel}"${!isChild ? ' and all subsections?' : '?'}`)) {
                        this.state.deleteSection(sec.id);
                        this.renderSections();
                        this.renderBlocks();
                        this.renderInspector();
                    }
                });

                div.querySelector('.btn-add-sub')?.addEventListener('click', () => {
                    const sub = this.state.addSection(sec.id);
                    this.selectSection(sub.id);
                });
            }

            this.els.sectionList.appendChild(div);
        };

        parents.forEach(sec => {
            appendSection(sec, false);
            const children = this.state.schema.filter(s => s.parentId === sec.id).sort((a, b) => a.order - b.order);
            children.forEach(child => appendSection(child, true));
        });

        if (window.lucide) lucide.createIcons();

        if (typeof Sortable !== 'undefined' && !this.isReadOnly) {
            if (this.sortables.sections) this.sortables.sections.destroy();
            this.sortables.sections = new Sortable(this.els.sectionList, {
                handle: '.drag-handle',
                animation: 150,
                disabled: this.isReadOnly,
                
                // ADD THESE 4 LINES:
                forceFallback: true,     // Bypasses choppy native HTML5 drag
                scroll: true,            // Enables smart auto-scrolling
                scrollSensitivity: 80,   // Pixels from edge to trigger scroll
                scrollSpeed: 20,         // Scroll speed
                
                onEnd: (evt) => {
                    const items = Array.from(this.els.sectionList.children);
                    items.forEach((item, idx) => {
                        const sec = this.state.getSection(item.dataset.id);
                        if (sec) sec.order = idx;
                    });
                }
            });
        }
    }

    renderBlocks() {
        this.els.blockList.innerHTML = '';
        const section = this.state.getSection(this.state.activeSectionId);
        if (!section) {
            this.els.emptyState.classList.remove('hidden');
            this.els.activeSecTitle.textContent = 'Select a section';
            this.els.btnAddBlock.classList.add('hidden');
            return;
        }
        this.els.emptyState.classList.add('hidden');
        this.els.activeSecTitle.textContent = section.heading;
        if (!this.isReadOnly) this.els.btnAddBlock.classList.remove('hidden');

        if (!section.blocks || section.blocks.length === 0) {
            this.els.blockList.innerHTML = `<div class="text-center p-8 border-2 border-dashed border-surface-border rounded-xl text-gray-500 text-sm">No blocks in this section. Add one to begin.</div>`;
            return;
        }

        section.blocks.sort((a, b) => a.order - b.order).forEach((blk, index) => {
            const div = document.createElement('div');
            const isActive = this.state.activeBlockId === blk.id;
            const typeDef = BLOCK_TYPES.find(t => t.id === blk.type);
            div.className = `group bg-surface-card border rounded-xl overflow-hidden transition-all ${isActive ? 'border-redwood-500 shadow-[0_0_15px_rgba(239,68,68,0.1)]' : 'border-surface-border hover:border-gray-500'}`;
            div.dataset.id = blk.id;
            
            div.innerHTML = `
                <div class="flex items-center justify-between p-3 bg-surface-panel/50 border-b border-surface-border">
                    <div class="flex items-center gap-3">
                        <i data-lucide="grip-horizontal" class="w-4 h-4 text-gray-500 ${this.isReadOnly ? '' : 'drag-handle hover:text-white cursor-move'}" title="Drag to reorder"></i>
                        <span class="px-2 py-0.5 rounded bg-surface-base text-xs font-bold text-redwood-400 border border-surface-border flex items-center gap-1">
                            <i data-lucide="${typeDef?.icon || 'box'}" class="w-3 h-3"></i> ${typeDef?.label || blk.type}
                        </span>
                    </div>
                    ${!this.isReadOnly ? `
                    <div class="flex items-center gap-1">
                        <button class="text-gray-500 hover:text-white transition-colors btn-move-up p-1" title="Move Up" ${index === 0 ? 'disabled style="opacity:0.3;cursor:not-allowed"' : ''}><i data-lucide="arrow-up" class="w-4 h-4"></i></button>
                        <button class="text-gray-500 hover:text-white transition-colors btn-move-down p-1" title="Move Down" ${index === section.blocks.length - 1 ? 'disabled style="opacity:0.3;cursor:not-allowed"' : ''}><i data-lucide="arrow-down" class="w-4 h-4"></i></button>
                        <div class="w-px h-4 bg-surface-border mx-1"></div>
                        <button class="text-gray-500 hover:text-red-500 transition-colors btn-delete-blk p-1" title="Delete"><i data-lucide="x" class="w-4 h-4"></i></button>
                    </div>` : ''}
                </div>
                <div class="p-4 cursor-pointer" id="blk-click-${blk.id}">
                    <div class="font-bold text-white text-lg mb-1">${this.esc(blk.label)}</div>
                    ${blk.dataPath ? `<div class="text-[10px] text-gray-500 font-mono">path: ${this.esc(blk.dataPath)}</div>` : ''}
                    ${this.renderBlockPreview(blk)}
                </div>`;

            if (!this.isReadOnly) {
                div.querySelector('.btn-delete-blk')?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.state.deleteBlock(section.id, blk.id);
                    this.renderBlocks();
                    this.renderInspector();
                });

                const btnUp = div.querySelector('.btn-move-up');
                if (btnUp) btnUp.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (index > 0) {
                        const temp = section.blocks[index];
                        section.blocks[index] = section.blocks[index - 1];
                        section.blocks[index - 1] = temp;
                        section.blocks.forEach((b, i) => b.order = i);
                        this.renderBlocks();
                    }
                });

                const btnDown = div.querySelector('.btn-move-down');
                if (btnDown) btnDown.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (index < section.blocks.length - 1) {
                        const temp = section.blocks[index];
                        section.blocks[index] = section.blocks[index + 1];
                        section.blocks[index + 1] = temp;
                        section.blocks.forEach((b, i) => b.order = i);
                        this.renderBlocks();
                    }
                });
            }

            div.querySelector(`#blk-click-${blk.id}`).addEventListener('click', () => this.selectBlock(blk.id));
            this.els.blockList.appendChild(div);
        });

        if (window.lucide) lucide.createIcons();

        if (typeof Sortable !== 'undefined' && !this.isReadOnly) {
            if (this.sortables.blocks) this.sortables.blocks.destroy();
            this.sortables.blocks = new Sortable(this.els.blockList, {
                handle: '.drag-handle',
                animation: 150,
                disabled: this.isReadOnly,
                
                // ADD THESE 4 LINES:
                forceFallback: true,
                scroll: true,
                scrollSensitivity: 80,
                scrollSpeed: 20,
                
                onEnd: (evt) => {
                    const items = Array.from(this.els.blockList.children);
                    items.forEach((item, idx) => {
                        const blk = this.state.getBlock(section.id, item.dataset.id);
                        if (blk) blk.order = idx;
                    });
                    section.blocks.sort((a, b) => a.order - b.order);
                    this.renderBlocks();
                }
            });
        }
    }

    renderBlockPreview(blk) {
        const placeholder = blk.placeholder ? ` placeholder="${this.esc(blk.placeholder)}"` : '';
        const pre = blk.prefix ? blk.prefix : '';
        const suf = blk.suffix ? blk.suffix : '';
        switch (blk.type) {
            case 'instruction': {
                const displayContent = blk.content || blk.placeholder || 'Instruction text will appear here...';
                return `<div class="mt-3 w-full bg-green-900/20 border-l-4 border-green-500 rounded p-3 text-sm text-green-400 opacity-80">${this.esc(displayContent)}</div>`;
            }
            case 'textarea':
            case 'quill':
                return `<div class="mt-3 w-full h-16 border border-surface-border bg-surface-base rounded border-dashed opacity-50 flex items-center justify-center text-xs text-gray-500">Text Area Simulation</div>`;
            case 'mixed': {
                const mixedDisplay = (blk.template || 'Sentence Setup.').replace(/\[(text|number|date|select)\]/gi, '▢');
                return `<div class="mt-3 w-full bg-surface-base border border-surface-border rounded p-2 text-sm text-blue-400 font-mono opacity-80">${this.esc(mixedDisplay)}</div>`;
            }
            case 'select':
                return `<div class="mt-3 w-full bg-surface-base border border-surface-border rounded p-2 text-sm text-gray-400 opacity-80 pointer-events-none">${this.esc(pre)} Dropdown: ${blk.options ? blk.options[0] : 'Select...'} ${this.esc(suf)}</div>`;
            case 'image':
                return `<div class="mt-3 w-full h-12 border border-surface-border bg-surface-base rounded border-dashed opacity-50 flex items-center justify-center text-xs text-gray-500"><i data-lucide="image" class="w-4 h-4 mr-2"></i> Image Upload Area</div>`;
            case 'table-static':
            case 'table-repeating':
                return `<div class="mt-3 w-full h-16 border border-surface-border bg-surface-base rounded flex items-center justify-center text-xs font-mono text-blue-400 bg-blue-900/10 border-blue-900/50">Matrix Data Table</div>`;
            case 'h3':
            case 'h4':
            case 'divider':
                return `<div class="mt-2 w-full border-t border-surface-border opacity-50"></div>`;
            default:
                return `<div class="mt-3 w-full bg-surface-base border border-surface-border rounded p-2 text-sm text-gray-400 opacity-80 pointer-events-none">${this.esc(pre)} ${blk.type} input ${this.esc(suf)}</div>`;
        }
    }

    renderInspector() {
        const panel = this.els.inspector;
        panel.innerHTML = '';

        if (this.state.selectionType === 'section') {
            const sec = this.state.getSection(this.state.activeSectionId);
            if (!sec) return;
            panel.innerHTML = `
                <div class="space-y-5 fade-in">
                    <div>
                        <label class="inspector-label">Navigation Label</label>
                        <input type="text" class="inspector-input" value="${this.esc(sec.navLabel)}" id="prop-navLabel">
                    </div>
                    <div>
                        <label class="inspector-label">Heading Display</label>
                        <input type="text" class="inspector-input" value="${this.esc(sec.heading)}" id="prop-heading">
                    </div>
                    <div>
                        <label class="inspector-label">Data Key (System)</label>
                        <input type="text" class="inspector-input font-mono text-redwood-400" value="${this.esc(sec.key)}" id="prop-key">
                        <p class="text-[10px] text-gray-500 mt-1">Unique identifier for database object mapping.</p>
                    </div>
                </div>`;

            ['navLabel', 'heading', 'key'].forEach(prop => {
                document.getElementById(`prop-${prop}`)?.addEventListener('input', (e) => {
                    sec[prop] = e.target.value;
                    if (prop === 'navLabel') {
                        const hi = document.getElementById('prop-heading');
                        if (hi && sec.heading === sec.navLabel) { hi.value = e.target.value; sec.heading = e.target.value; }
                        this.els.activeSecTitle.textContent = sec.heading;
                        sec.key = e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
                        sec.id = sec.key;
                        document.getElementById('prop-key').value = sec.key;
                    }
                    if (prop === 'heading') this.els.activeSecTitle.textContent = sec.heading;
                    this.renderSections();
                });
            });

        } else if (this.state.selectionType === 'block') {
            const blk = this.state.getBlock(this.state.activeSectionId, this.state.activeBlockId);
            if (!blk) return;
            const isLayout = ['h3', 'h4', 'divider', 'instruction'].includes(blk.type);

            let html = `
                <div class="space-y-5 fade-in">
                    <div class="flex items-center gap-2 mb-6 border-b border-surface-border pb-4">
                        <div class="p-2 bg-redwood-500/10 rounded text-redwood-500"><i data-lucide="${BLOCK_TYPES.find(t => t.id === blk.type)?.icon || 'box'}" class="w-5 h-5"></i></div>
                        <div>
                            <h3 class="font-bold text-white text-sm">Block Properties</h3>
                            <p class="text-xs text-gray-400 uppercase tracking-wider">${blk.type}</p>
                        </div>
                    </div>
                    <div>
                        <label class="inspector-label">${isLayout ? (blk.type === 'instruction' ? 'Label (Hidden)' : 'Text Field Label') : 'Field Label'}</label>
                        <input type="text" class="inspector-input" value="${this.esc(blk.label)}" id="prop-label">
                    </div>`;

            if (blk.type === 'instruction') {
                html += `
                    <div>
                        <label class="inspector-label">Instructional Text</label>
                        <textarea class="inspector-input h-32 resize-y" id="prop-content" placeholder="Enter instructional guidance here...">${this.esc(blk.content)}</textarea>
                    </div>
                    <div>
                        <label class="inspector-label">Placeholder Reference Name</label>
                        <input type="text" class="inspector-input" id="prop-placeholder" value="${this.esc(blk.placeholder)}" placeholder="e.g., Note about Q3 financials...">
                    </div>`;
            }

            if (!isLayout) {
                html += `
                    <div>
                        <label class="inspector-label">Data Path</label>
                        <input type="text" class="inspector-input font-mono text-blue-400" value="${this.esc(blk.dataPath)}" id="prop-dataPath">
                    </div>`;
            }

            if (['text', 'number', 'textarea', 'email', 'date', 'select'].includes(blk.type)) {
                html += `
                    <div>
                        <label class="inspector-label">Placeholder</label>
                        <input type="text" class="inspector-input" value="${this.esc(blk.placeholder)}" id="prop-placeholder">
                    </div>`;
            }

            if (['text', 'number', 'email', 'date', 'select'].includes(blk.type)) {
                html += `
                    <div class="flex gap-2 bg-surface-base p-2 border border-surface-border rounded-lg mt-3">
                        <div class="flex-1">
                            <label class="inspector-label">Prefix (Fixed)</label>
                            <input type="text" class="inspector-input text-xs py-1" value="${this.esc(blk.prefix)}" id="prop-prefix" placeholder="e.g. $">
                        </div>
                        <div class="flex-1">
                            <label class="inspector-label">Suffix (Fixed)</label>
                            <input type="text" class="inspector-input text-xs py-1" value="${this.esc(blk.suffix)}" id="prop-suffix" placeholder="e.g. %">
                        </div>
                    </div>`;
            }

            if (blk.type === 'mixed') {
                html += `
                    <div>
                        <label class="inspector-label">Sentence Template</label>
                        <textarea id="prop-template" class="inspector-input text-xs h-20" placeholder="e.g. As of [date], revenue was [number]m.">${this.esc(blk.template)}</textarea>
                        <div class="text-[10px] text-gray-400 mt-1 leading-tight">Create blanks by typing<br>
                            <b class="text-white">[text]</b> for short text<br>
                            <b class="text-white">[number]</b> for numbers<br>
                            <b class="text-white">[date]</b> for date picker<br>
                            <b class="text-white">[select]</b> for dropdown menus
                        </div>
                    </div>`;
            }

            if (blk.type === 'quill') {
                html += `
                    <div>
                        <label class="inspector-label">Guide (Optional tip for users)</label>
                        <textarea class="inspector-input h-20 resize-y" id="prop-guide">${this.esc(blk.guide)}</textarea>
                    </div>`;
            }

            if (blk.type === 'select' || blk.type === 'mixed') {
                html += `
                    <div class="mt-4 pt-4 border-t border-surface-border">
                        <label class="inspector-label">Dropdown Options <span class="normal-case opacity-60 text-[10px]">(For Selects & select)</span></label>
                        <div id="prop-options-container" class="space-y-2 mb-3"></div>
                        <button id="prop-add-option" class="text-xs font-bold text-redwood-500 hover:text-redwood-400">+ Add Option</button>
                    </div>`;
            }

            if (blk.type === 'image') {
                html += `
                    <div class="flex gap-2">
                        <div class="flex-1">
                            <label class="inspector-label">Max Width</label>
                            <input type="text" class="inspector-input" value="${this.esc(blk.maxWidth || '100%')}" id="prop-maxw">
                        </div>
                        <div class="flex-1">
                            <label class="inspector-label">Max Height</label>
                            <input type="text" class="inspector-input" value="${this.esc(blk.maxHeight)}" id="prop-maxh">
                        </div>
                    </div>
                    <label class="flex items-center gap-3 p-3 bg-surface-base border border-surface-border rounded-lg cursor-pointer hover:border-redwood-500 transition-colors">
                        <input type="checkbox" id="prop-multiple" class="w-4 h-4 accent-redwood-500" ${blk.multiple ? 'checked' : ''}>
                        <span class="text-sm font-semibold text-white">Allow Multiple Images</span>
                    </label>`;
            }

            if (blk.type === 'table-static' || blk.type === 'table-repeating') {
                html += `
                    <div class="mt-6 pt-6 border-t border-surface-border">
                        <div class="flex gap-2 mb-4">
                            <div class="flex-1">
                                <label class="inspector-label">Cols</label>
                                <input type="number" class="inspector-input" value="${blk.cols || 2}" id="prop-cols" min="1" max="50">
                            </div>
                            <div class="flex-1">
                                <label class="inspector-label">Rows</label>
                                <input type="number" class="inspector-input" value="${blk.numRows || 1}" id="prop-numrows" min="1" max="100">
                            </div>
                            
                        </div>
                        <label class="flex items-center justify-between p-3 bg-surface-base border border-surface-border rounded-lg cursor-pointer mb-4 hover:border-redwood-500 transition-colors">
                            <div>
                                <span class="text-xs font-bold text-white block">Dynamic Records (+/-)</span>
                                <span class="text-[10px] text-gray-500">Allow users to add entire chunks</span>
                            </div>
                            <input type="checkbox" id="prop-dynrows" class="w-4 h-4 accent-redwood-500" ${blk.dynamicRows !== false ? 'checked' : ''}>
                        </label>
                        <!-- 🌟 NEW: Matrix Inner Insert -->
                        <label class="flex items-center justify-between p-3 bg-surface-base border border-surface-border rounded-lg cursor-pointer mb-4 hover:border-redwood-500 transition-colors">
                            <div>
                                <span class="text-xs font-bold text-white block">Inline Matrix Insert (+/-)</span>
                                <span class="text-[10px] text-gray-500">Allow inserting inner rows into template</span>
                            </div>
                            <input type="checkbox" id="prop-inlineinsert" class="w-4 h-4 accent-redwood-500" ${blk.allowInlineInsert ? 'checked' : ''}>
                        </label>
                        <!-- 🌟 NEW: Editable Headers -->
                        <label class="flex items-center justify-between p-3 bg-surface-base border border-surface-border rounded-lg cursor-pointer mb-4 hover:border-redwood-500 transition-colors">
                            <div>
                                <span class="text-xs font-bold text-white block">Editable Headers</span>
                                <span class="text-[10px] text-gray-500">Allow renaming columns in workspace</span>
                            </div>
                            <input type="checkbox" id="prop-editableheaders" class="w-4 h-4 accent-redwood-500" ${blk.editableHeaders ? 'checked' : ''}>
                        </label>
                        
                        <label class="flex items-center justify-between p-3 bg-surface-base border border-surface-border rounded-lg cursor-pointer mb-4 hover:border-redwood-500 transition-colors">
                            <div>
                                <span class="text-xs font-bold text-white block">Dynamic Columns (+/-)</span>
                                <span class="text-[10px] text-gray-500">Allow users to add/remove columns</span>
                            </div>
                            <input type="checkbox" id="prop-dyncols" class="w-4 h-4 accent-redwood-500" ${blk.allowDynamicColumns ? 'checked' : ''}>
                        </label>

                        <div class="mb-4">
                            <label class="inspector-label">Column Headers</label>
                            <div id="inspector-table-headers" class="flex gap-2 overflow-x-auto pb-2"></div>
                        </div>
                        <div>
                            <label class="inspector-label">Matrix Template (Click to edit cell)</label>
                            <div id="inspector-table-grid" class="mb-4 overflow-x-auto bg-surface-base p-2 border border-surface-border rounded"></div>
                        </div>
                        <div id="inspector-cell-config" class="hidden bg-surface-base border border-surface-border p-4 rounded-lg mt-4 shadow-xl"></div>
                    </div>`;
            }

            html += `</div>`;
            panel.innerHTML = html;
            if (window.lucide) lucide.createIcons();

            // --- Generic Bindings ---
            document.getElementById('prop-label')?.addEventListener('input', (e) => {
                blk.label = e.target.value;
                if (!isLayout && !blk.dataPath.includes('.')) {
                    const sec = this.state.getSection(this.state.activeSectionId);
                    blk.dataPath = this.state.autoDataPath(sec.key, e.target.value);
                    document.getElementById('prop-dataPath').value = blk.dataPath;
                }
                this.renderBlocks();
            });
            document.getElementById('prop-content')?.addEventListener('input', (e) => { blk.content = e.target.value; this.renderBlocks(); });
            document.getElementById('prop-placeholder')?.addEventListener('input', (e) => { blk.placeholder = e.target.value; this.renderBlocks(); });
            document.getElementById('prop-dataPath')?.addEventListener('input', (e) => { blk.dataPath = e.target.value; });
            document.getElementById('prop-guide')?.addEventListener('input', (e) => { blk.guide = e.target.value; });
            document.getElementById('prop-multiple')?.addEventListener('change', (e) => { blk.multiple = e.target.checked; });
            document.getElementById('prop-maxw')?.addEventListener('input', (e) => { blk.maxWidth = e.target.value; });
            document.getElementById('prop-maxh')?.addEventListener('input', (e) => { blk.maxHeight = e.target.value; });
            document.getElementById('prop-prefix')?.addEventListener('input', (e) => { blk.prefix = e.target.value; this.renderBlocks(); });
            document.getElementById('prop-suffix')?.addEventListener('input', (e) => { blk.suffix = e.target.value; this.renderBlocks(); });
            document.getElementById('prop-template')?.addEventListener('input', (e) => { blk.template = e.target.value; this.renderBlocks(); });

            if (blk.type === 'select' || blk.type === 'mixed') {
                const renderOpts = () => {
                    const container = document.getElementById('prop-options-container');
                    container.innerHTML = '';
                    (blk.options || []).forEach((opt, i) => {
                        const row = document.createElement('div');
                        row.className = 'flex items-center gap-2';
                        row.innerHTML = `<input type="text" class="inspector-input text-xs py-1 flex-1" value="${this.esc(opt)}" data-index="${i}">
                                         <button class="text-red-500 hover:text-red-400 font-bold px-2" data-delete="${i}">×</button>`;
                        container.appendChild(row);
                    });
                    container.querySelectorAll('input').forEach(inp => inp.addEventListener('input', (e) => { blk.options[e.target.dataset.index] = e.target.value; this.renderBlocks(); }));
                    container.querySelectorAll('[data-delete]').forEach(btn => btn.addEventListener('click', (e) => { blk.options.splice(e.currentTarget.dataset.delete, 1); renderOpts(); this.renderBlocks(); }));
                };
                document.getElementById('prop-add-option').addEventListener('click', () => { if (!blk.options) blk.options = []; blk.options.push('New Option'); renderOpts(); this.renderBlocks(); });
                renderOpts();
            }

            if (blk.type === 'table-static' || blk.type === 'table-repeating') {
                document.getElementById('prop-cols')?.addEventListener('change', (e) => { blk.cols = Math.max(1, parseInt(e.target.value) || 1); this.ensureGrid(blk); this.renderTableHeadersUI(blk); this.renderTableGridUI(blk); });
                document.getElementById('prop-numrows')?.addEventListener('change', (e) => { blk.numRows = Math.max(1, parseInt(e.target.value) || 1); this.ensureGrid(blk); this.renderTableGridUI(blk); });
                document.getElementById('prop-dynrows')?.addEventListener('change', (e) => { blk.dynamicRows = e.target.checked; });
                document.getElementById('prop-inlineinsert')?.addEventListener('change', (e) => { blk.allowInlineInsert = e.target.checked; });
                document.getElementById('prop-editableheaders')?.addEventListener('change', (e) => { blk.editableHeaders = e.target.checked; });
                document.getElementById('prop-dyncols')?.addEventListener('change', (e) => { blk.allowDynamicColumns = e.target.checked; });
                this.ensureGrid(blk);
                this.renderTableHeadersUI(blk);
                this.renderTableGridUI(blk);
            }
        }
    }

    ensureGrid(blk) {
        const rows = Math.max(1, parseInt(blk.numRows) || 1);
        const cols = Math.max(1, parseInt(blk.cols) || 2);
        if (!blk.rows) blk.rows = [];
        const newRows = [];
        for (let r = 0; r < rows; r++) {
            const rowId = blk.rows[r] ? blk.rows[r].id : generateId();
            const oldCells = blk.rows[r] ? blk.rows[r].cells : [];
            const newCells = [];
            for (let c = 0; c < cols; c++) {
                let cell = oldCells[c] || {
                    id: generateId(), cellType: 'input', inputType: 'text',
                    text: '', placeholder: '', options: ['Option 1', 'Option 2'],
                    formula: '', prefix: '', suffix: '', template: '',
                    conditions: [{ label: 'Yes', template: 'Yes, [text]' }, { label: 'No', template: 'No, [text]' }],
                    colspan: 1, rowspan: 1
                };
                cell.colspan = Math.min(Math.max(1, cell.colspan || 1), cols - c);
                cell.rowspan = Math.min(Math.max(1, cell.rowspan || 1), rows - r);
                newCells.push(cell);
            }
            newRows.push({ id: rowId, cells: newCells });
        }
        blk.rows = newRows;
    }

    renderTableHeadersUI(blk) {
        const container = document.getElementById('inspector-table-headers');
        if (!container) return;
        container.innerHTML = '';
        if (!blk.colHeaders) blk.colHeaders = Array.from({ length: blk.cols }, (_, i) => `Col ${i + 1}`);
        while (blk.colHeaders.length < blk.cols) blk.colHeaders.push(`Col ${blk.colHeaders.length + 1}`);
        blk.colHeaders = blk.colHeaders.slice(0, blk.cols);
        blk.colHeaders.forEach((val, i) => {
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.className = 'inspector-input w-24 shrink-0 text-xs py-1';
            inp.value = val;
            inp.placeholder = `Header ${i + 1}`;
            inp.addEventListener('input', (e) => { blk.colHeaders[i] = e.target.value; });
            container.appendChild(inp);
        });
    }

    renderTableGridUI(blk, activeRi = -1, activeCi = -1) {
        const grid = document.getElementById('inspector-table-grid');
        if (!grid) return;
        grid.innerHTML = '';
        const table = document.createElement('table');
        table.className = 'w-full border-collapse text-[10px] table-fixed';
        const numRows = blk.rows.length;
        const numCols = blk.cols;
        const occupied = Array.from({ length: numRows }, () => new Array(numCols).fill(false));

        blk.rows.forEach((row, ri) => {
            const tr = document.createElement('tr');
            row.cells.forEach((cell, ci) => {
                if (occupied[ri][ci]) return;
                const cs = cell.colspan || 1;
                const rs = cell.rowspan || 1;
                for (let r = ri; r < ri + rs; r++) for (let c = ci; c < ci + cs; c++) { if (r < numRows && c < numCols) occupied[r][c] = true; }

                const td = document.createElement('td');
                td.colSpan = cs;
                td.rowSpan = rs;
                let bgClass = 'bg-surface-card hover:bg-surface-hover text-gray-300';
                if (cell.cellType === 'fixed')        bgClass = 'bg-orange-500/10 hover:bg-orange-500/20 text-orange-200';
                if (cell.cellType === 'computed')     bgClass = 'bg-green-500/10 hover:bg-green-500/20 text-green-200';
                if (cell.cellType === 'mixed')        bgClass = 'bg-purple-500/10 hover:bg-purple-500/20 text-purple-200';
                if (cell.cellType === 'smart-select') bgClass = 'bg-pink-500/10 hover:bg-pink-500/20 text-pink-200';
                td.className = `border border-surface-border p-1.5 cursor-pointer transition-colors overflow-hidden ${bgClass}`;
                if (ri === activeRi && ci === activeCi) td.classList.add('ring-1', 'ring-redwood-500', 'ring-inset');

                let icon = `<i data-lucide="pencil" class="w-3 h-3 inline"></i>`;
                if (cell.cellType === 'fixed')        icon = `<i data-lucide="lock" class="w-3 h-3 inline"></i>`;
                if (cell.cellType === 'computed')     icon = `<i data-lucide="zap" class="w-3 h-3 inline"></i>`;
                if (cell.cellType === 'mixed')        icon = `<i data-lucide="align-justify" class="w-3 h-3 inline"></i>`;
                if (cell.cellType === 'smart-select') icon = `<i data-lucide="git-branch" class="w-3 h-3 inline"></i>`;

                let displayVal = cell.text || '';
                if (cell.cellType === 'input') {
                    const pre = cell.prefix || ''; const suf = cell.suffix || '';
                    displayVal = cell.inputType === 'textarea' ? `${pre}[Multi-line]${suf}` : `${pre}[${cell.inputType || 'text'}]${suf}`;
                }
                if (cell.cellType === 'mixed')        displayVal = (cell.template || 'Sentence Setup.').replace(/\[(text|number|date|select)\]/gi, '▢');
                if (cell.cellType === 'smart-select') displayVal = 'Conditional Dropdown';

                td.innerHTML = `<div class="opacity-50 font-bold mb-0.5 whitespace-nowrap">${icon} ${cell.cellType}</div><div class="font-mono truncate" style="white-space:pre-wrap">${this.esc(displayVal)}</div>`;
                td.addEventListener('click', () => { this.renderTableGridUI(blk, ri, ci); this.openCellConfig(blk, ri, ci); });
                tr.appendChild(td);
            });
            table.appendChild(tr);
        });
        grid.appendChild(table);
        if (window.lucide) lucide.createIcons();
    }

    openCellConfig(blk, ri, ci) {
        const cell = blk.rows[ri].cells[ci];
        const cfg = document.getElementById('inspector-cell-config');
        cfg.classList.remove('hidden');

        cfg.innerHTML = `
            <div class="flex justify-between items-center mb-4 border-b border-surface-border pb-2">
                <span class="font-bold text-white text-xs">Inner Cell Logic</span>
                <span class="bg-redwood-500/20 text-redwood-400 px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase">Row ${ri + 1} / Col ${ci + 1}</span>
            </div>
            <div class="space-y-3">
                <div>
                    <label class="inspector-label">Cell Type</label>
                    <select id="cfg-celltype" class="inspector-input text-xs py-1">
                        <option value="input"        ${cell.cellType === 'input'        ? 'selected' : ''}>Input (Single)</option>
                        <option value="mixed"        ${cell.cellType === 'mixed'        ? 'selected' : ''}>Fill-in-the-Blanks (Multi)</option>
                        <option value="smart-select" ${cell.cellType === 'smart-select' ? 'selected' : ''}>Smart Dropdown (Conditional)</option>
                        <option value="fixed"        ${cell.cellType === 'fixed'        ? 'selected' : ''}>Fixed text</option>
                        <option value="computed"     ${cell.cellType === 'computed'     ? 'selected' : ''}>Computed (Formula)</option>
                    </select>
                </div>
                <div id="cfg-wrap-fixed"   ${cell.cellType !== 'fixed'        ? 'class="hidden"' : ''}>
                    <label class="inspector-label">Fixed Text</label>
                    <input type="text" id="cfg-text" class="inspector-input text-xs py-1" value="${this.esc(cell.text)}">
                </div>
                <div id="cfg-wrap-mixed"   ${cell.cellType !== 'mixed'        ? 'class="hidden space-y-3"' : 'class="space-y-3"'}>
                    <div>
                        <label class="inspector-label">Sentence Template</label>
                        <textarea id="cfg-template" class="inspector-input text-xs h-20" placeholder="e.g. As of [date], revenue was [number]m.">${this.esc(cell.template)}</textarea>
                        <div class="text-[10px] text-gray-400 mt-1 leading-tight">
                            <b class="text-white">[text]</b> short text &nbsp; <b class="text-white">[number]</b> number &nbsp; <b class="text-white">[date]</b> date &nbsp; <b class="text-white">[select]</b> dropdown
                        </div>
                    </div>
                </div>
                <div id="cfg-wrap-smart"   ${cell.cellType !== 'smart-select' ? 'class="hidden space-y-3 border-t border-surface-border pt-3 mt-3"' : 'class="space-y-3 border-t border-surface-border pt-3 mt-3"'}>
                    <label class="inspector-label text-pink-400">Smart Conditions: If X → then Y</label>
                    <div class="text-[10px] text-gray-400 mb-2 leading-tight">Set what happens when a user picks a specific option.<br>Use <b class="text-white">[text]</b>, <b class="text-white">[number]</b>, etc. in the THEN templates.</div>
                    <div id="cfg-conditions-container" class="space-y-3 mb-2"></div>
                    <button id="cfg-add-condition" class="text-xs font-bold text-pink-500 hover:text-pink-400">+ Add Condition</button>
                </div>
                <div id="cfg-wrap-input"   ${cell.cellType !== 'input'        ? 'class="hidden space-y-3"' : 'class="space-y-3"'}>
                    <div>
                        <label class="inspector-label">Input Type</label>
                        <select id="cfg-inputtype" class="inspector-input text-xs py-1">
                            <option value="text"     ${cell.inputType === 'text'     ? 'selected' : ''}>Short Text</option>
                            <option value="textarea" ${cell.inputType === 'textarea' ? 'selected' : ''}>Long Text</option>
                            <option value="number"   ${cell.inputType === 'number'   ? 'selected' : ''}>Number</option>
                            <option value="date"     ${cell.inputType === 'date'     ? 'selected' : ''}>Date</option>
                            <option value="select"   ${cell.inputType === 'select'   ? 'selected' : ''}>Dropdown</option>
                        </select>
                    </div>
                    <div>
                        <label class="inspector-label">Placeholder</label>
                        <input type="text" id="cfg-placeholder" class="inspector-input text-xs py-1" value="${this.esc(cell.placeholder)}">
                    </div>
                    <div class="flex gap-2 bg-surface-base p-2 border border-surface-border rounded-lg">
                        <div class="flex-1">
                            <label class="inspector-label">Prefix (Fixed Text)</label>
                            <input type="text" id="cfg-prefix" class="inspector-input text-xs py-1" placeholder="e.g. As of " value="${this.esc(cell.prefix)}">
                        </div>
                        <div class="flex-1">
                            <label class="inspector-label">Suffix (Fixed Text)</label>
                            <input type="text" id="cfg-suffix" class="inspector-input text-xs py-1" placeholder="e.g. Days" value="${this.esc(cell.suffix)}">
                        </div>
                    </div>
                </div>
                <div id="cfg-wrap-select"  ${!(cell.cellType === 'input' && cell.inputType === 'select') && cell.cellType !== 'mixed' ? 'class="hidden border-t border-surface-border pt-3 mt-3"' : 'class="border-t border-surface-border pt-3 mt-3"'}>
                    <label class="inspector-label">Dropdown Options <span class="normal-case opacity-60 text-[10px]">(For Selects & select)</span></label>
                    <div id="cfg-options-container" class="space-y-2 mb-2"></div>
                    <button id="cfg-add-option" class="text-xs font-bold text-redwood-500 hover:text-redwood-400">+ Add Option</button>
                </div>
                <div id="cfg-wrap-computed" ${cell.cellType !== 'computed' ? 'class="hidden space-y-3"' : 'class="space-y-3"'}>
                    <!-- 🌟 NEW FORMULA HELPER TEXT -->
                    <div>
                        <label class="inspector-label">Formula <span class="opacity-50">e.g. C0 * C1 or SUM(C0)</span></label>
                        <input type="text" id="cfg-formula" class="inspector-input text-xs py-1 font-mono text-green-400" value="${this.esc(cell.formula)}">
                    </div>
                    <div>
                        <label class="inspector-label">Display Format</label>
                        <select id="cfg-format" class="inspector-input text-xs py-1">
                            <option value="raw"     ${cell.format === 'raw'     || !cell.format ? 'selected' : ''}>Raw Number</option>
                            <option value="percent" ${cell.format === 'percent' ? 'selected' : ''}>Percentage (%)</option>
                        </select>
                    </div>
                </div>
                <div class="flex gap-2 border-t border-surface-border pt-3 mt-3">
                    <div class="flex-1">
                        <label class="inspector-label">Colspan</label>
                        <input type="number" id="cfg-colspan" class="inspector-input text-xs py-1" min="1" max="${blk.cols - ci}" value="${cell.colspan || 1}">
                    </div>
                    <div class="flex-1">
                        <label class="inspector-label">Rowspan</label>
                        <input type="number" id="cfg-rowspan" class="inspector-input text-xs py-1" min="1" max="${blk.numRows - ri}" value="${cell.rowspan || 1}">
                    </div>
                </div>
                <div class="flex justify-end pt-2">
                    <button id="cfg-done" class="bg-surface-border hover:bg-gray-600 text-white font-bold py-1 px-4 rounded text-xs transition-colors">Apply</button>
                </div>
            </div>`;

        // Cell config bindings
        document.getElementById('cfg-celltype').addEventListener('change', (e) => {
            cell.cellType = e.target.value;
            document.getElementById('cfg-wrap-fixed').classList.toggle('hidden',   cell.cellType !== 'fixed');
            document.getElementById('cfg-wrap-input').classList.toggle('hidden',   cell.cellType !== 'input');
            document.getElementById('cfg-wrap-computed').classList.toggle('hidden', cell.cellType !== 'computed');
            document.getElementById('cfg-wrap-mixed').classList.toggle('hidden',   cell.cellType !== 'mixed');
            document.getElementById('cfg-wrap-smart').classList.toggle('hidden',   cell.cellType !== 'smart-select');
            document.getElementById('cfg-wrap-select').classList.toggle('hidden',  !(cell.cellType === 'input' && cell.inputType === 'select') && cell.cellType !== 'mixed');
            this.renderTableGridUI(blk, ri, ci);
        });
        document.getElementById('cfg-inputtype').addEventListener('change', (e) => {
            cell.inputType = e.target.value;
            document.getElementById('cfg-wrap-select').classList.toggle('hidden', !(cell.cellType === 'input' && cell.inputType === 'select') && cell.cellType !== 'mixed');
            this.renderTableGridUI(blk, ri, ci);
        });
        document.getElementById('cfg-text').addEventListener('input',        (e) => { cell.text      = e.target.value; this.renderTableGridUI(blk, ri, ci); });
        document.getElementById('cfg-template').addEventListener('input',    (e) => { cell.template  = e.target.value; this.renderTableGridUI(blk, ri, ci); });
        document.getElementById('cfg-placeholder').addEventListener('input', (e) => { cell.placeholder = e.target.value; });
        document.getElementById('cfg-formula').addEventListener('input',     (e) => { cell.formula   = e.target.value; });
        document.getElementById('cfg-format')?.addEventListener('change',    (e) => { cell.format    = e.target.value; });
        document.getElementById('cfg-prefix').addEventListener('input',      (e) => { cell.prefix    = e.target.value; this.renderTableGridUI(blk, ri, ci); });
        document.getElementById('cfg-suffix').addEventListener('input',      (e) => { cell.suffix    = e.target.value; this.renderTableGridUI(blk, ri, ci); });
        document.getElementById('cfg-colspan').addEventListener('input',     (e) => { cell.colspan   = parseInt(e.target.value) || 1; this.renderTableGridUI(blk, ri, ci); });
        document.getElementById('cfg-rowspan').addEventListener('input',     (e) => { cell.rowspan   = parseInt(e.target.value) || 1; this.renderTableGridUI(blk, ri, ci); });
        document.getElementById('cfg-done').addEventListener('click', () => { cfg.classList.add('hidden'); this.renderTableGridUI(blk); this.renderBlocks(); });

        const renderCellConditions = () => {
            const container = document.getElementById('cfg-conditions-container');
            if (!container) return;
            container.innerHTML = '';
            if (!cell.conditions) cell.conditions = [];
            cell.conditions.forEach((cond, i) => {
                const row = document.createElement('div');
                row.className = 'p-2 bg-surface-card border border-surface-border rounded relative';
                row.innerHTML = `
                    <div class="flex items-center gap-2 mb-2">
                        <span class="text-[10px] font-bold text-gray-500 w-10">IF</span>
                        <input type="text" class="inspector-input text-xs py-1 flex-1 cond-label" value="${this.esc(cond.label)}" data-index="${i}" placeholder="Dropdown Option">
                        <button class="text-red-500 hover:text-red-400 font-bold px-2 cond-delete" data-index="${i}">×</button>
                    </div>
                    <div class="flex items-start gap-2">
                        <span class="text-[10px] font-bold text-gray-500 w-10 mt-1">THEN</span>
                        <textarea class="inspector-input text-xs flex-1 h-12 cond-template" data-index="${i}" placeholder="Template e.g. Reason: [text]">${this.esc(cond.template)}</textarea>
                    </div>`;
                container.appendChild(row);
            });
            container.querySelectorAll('.cond-label').forEach(inp => inp.addEventListener('input', (e) => { cell.conditions[e.target.dataset.index].label = e.target.value; }));
            container.querySelectorAll('.cond-template').forEach(inp => inp.addEventListener('input', (e) => { cell.conditions[e.target.dataset.index].template = e.target.value; }));
            container.querySelectorAll('.cond-delete').forEach(btn => btn.addEventListener('click', (e) => { cell.conditions.splice(e.target.dataset.index, 1); renderCellConditions(); }));
        };
        document.getElementById('cfg-add-condition')?.addEventListener('click', () => { if (!cell.conditions) cell.conditions = []; cell.conditions.push({ label: 'New Option', template: '' }); renderCellConditions(); });
        renderCellConditions();

        const renderCellOpts = () => {
            const container = document.getElementById('cfg-options-container');
            if (!container) return;
            container.innerHTML = '';
            (cell.options || []).forEach((opt, i) => {
                const row = document.createElement('div');
                row.className = 'flex items-center gap-2';
                row.innerHTML = `<input type="text" class="inspector-input text-xs py-1 flex-1" value="${this.esc(opt)}" data-index="${i}">
                                  <button class="text-red-500 hover:text-red-400 font-bold px-2" data-delete="${i}">×</button>`;
                container.appendChild(row);
            });
            container.querySelectorAll('input').forEach(inp => inp.addEventListener('input', (e) => { cell.options[e.target.dataset.index] = e.target.value; }));
            container.querySelectorAll('[data-delete]').forEach(btn => btn.addEventListener('click', (e) => { cell.options.splice(e.currentTarget.dataset.delete, 1); renderCellOpts(); }));
        };
        document.getElementById('cfg-add-option')?.addEventListener('click', () => { if (!cell.options) cell.options = []; cell.options.push('New Option'); renderCellOpts(); });
        renderCellOpts();
    }

    renderBlockSelector() {
        const grid = document.getElementById('block-types-grid');
        grid.innerHTML = BLOCK_TYPES.map(t => `
            <button class="block-type-btn flex flex-col items-center justify-center p-4 bg-surface-base border border-surface-border rounded-lg text-center" data-type="${t.id}">
                <i data-lucide="${t.icon}" class="w-8 h-8 text-gray-400 mb-2"></i>
                <span class="text-sm font-bold text-white mb-1">${t.label}</span>
                <span class="text-[10px] text-gray-500 leading-tight">${t.desc}</span>
            </button>`).join('');
        grid.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                if (this.isReadOnly) return;
                const newBlk = this.state.addBlock(this.state.activeSectionId, btn.dataset.type);
                this.els.modal.classList.add('hidden');
                this.renderBlocks();
                if (newBlk) this.selectBlock(newBlk.id);
            });
        });
    }

    selectSection(id) {
        this.state.activeSectionId = id;
        this.state.activeBlockId = null;
        this.state.selectionType = 'section';
        this.renderSections();
        this.renderBlocks();
        this.renderInspector();
    }

    selectBlock(id) {
        this.state.activeBlockId = id;
        this.state.selectionType = 'block';
        this.renderBlocks();
        this.renderInspector();
    }

    async saveSchemaToDB() {
        if (!this.state.schema || this.state.schema.length === 0) {
            this.showToast('⚠️ Schema is empty — save blocked to prevent data loss. Refresh and try again.', true);
            return;
        }
        
        // 🌟 REQUIRED GUARD: Without this ID, schema-service.js will explicitly throw an error!
        if (!this.imId && this.schemaKey === 'im') {
            this.showToast('⚠️ No IM ID found in URL. Cannot map this schema to the database.', true);
            return;
        }

        const btn = document.getElementById('btn-save');
        btn.disabled = true;
        const origText = btn.innerHTML;
        btn.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin"></i> Saving...`;
        if (window.lucide) lucide.createIcons();

        try {
            this.state.schema.sort((a, b) => a.order - b.order).forEach((sec, i) => {
                sec.order = i;
                if (!sec.key) sec.key = `sec_${sec.id.replace(/-/g, '')}`;
                sec.blocks.sort((a, b) => a.order - b.order).forEach((b, j) => {
                    b.order = j;
                    const isLayout = ['h3', 'h4', 'divider', 'instruction'].includes(b.type);
                    if (!isLayout && !b.dataPath) {
                        const validLabel = (b.label || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+(.)/g, (_, c) => c.toUpperCase());
                        b.dataPath = validLabel ? `${sec.key}.${validLabel}` : `${sec.key}.block_${b.id.replace(/-/g, '')}`;
                    }
                });
            });

            await saveSchema(this.imId, this.state.schema, this.schemaKey);
            
            this._schemaLoadedOk = true;
            this.showToast('Schema deployed to workspace successfully!');
        } catch (e) {
            console.error(e);
            this.showToast('Save failed: ' + e.message, true);
        } finally {
            btn.disabled = false;
            btn.innerHTML = origText;
            if (window.lucide) lucide.createIcons();
        }
    }

    exportSchema() {
        const exportData = [...this.state.schema.sort((a, b) => a.order - b.order).map((sec, i) => {
            sec.order = i;
            if (!sec.key) sec.key = `sec_${sec.id.replace(/-/g, '')}`;
            return { ...sec, blocks: [...sec.blocks.sort((a, b) => a.order - b.order).map((b, j) => { b.order = j; return b; })] };
        })];
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const dateStr = new Date().toISOString().split('T')[0];
        a.href = url;
        a.download = `im-schema-backup-${dateStr}.json`;
        a.click();
        URL.revokeObjectURL(url);
        this.showToast('Schema exported successfully.');
    }

    importSchema(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                const parsed = JSON.parse(event.target.result);
                if (!Array.isArray(parsed)) throw new Error('Schema must be an array of sections.');
                if (confirm('This will OVERWRITE your entire schema configuration. Are you absolutely sure?')) {
                    this.state.schema = parsed;
                    this.state.activeSectionId = null;
                    this.state.activeBlockId = null;
                    this.state.selectionType = null;
                    await this.saveSchemaToDB();
                    this.renderSections();
                    this.renderBlocks();
                    this.renderInspector();
                    this.showToast('Schema successfully imported and saved.');
                }
            } catch (err) {
                this.showToast('Failed to import schema: ' + err.message, true);
            }
            e.target.value = '';
        };
        reader.readAsText(file);
    }

    bindEvents() {
        document.getElementById('btn-add-section')?.addEventListener('click', () => {
            if (this.isReadOnly) return;
            const sec = this.state.addSection();
            this.selectSection(sec.id);
        });

        this.els.btnAddBlock?.addEventListener('click', () => {
            if (this.isReadOnly) return;
            this.els.modal.classList.remove('hidden');
        });
        document.getElementById('btn-close-modal')?.addEventListener('click', () => this.els.modal.classList.add('hidden'));
        document.getElementById('btn-save')?.addEventListener('click', () => {
            if (this.isReadOnly) return;
            this.saveSchemaToDB();
        });
        document.getElementById('btn-export')?.addEventListener('click', () => this.exportSchema());
        document.getElementById('btn-import')?.addEventListener('click', () => {
            if (this.isReadOnly) return;
            document.getElementById('import-input').click();
        });
        document.getElementById('import-input')?.addEventListener('change', e => this.importSchema(e));

        const toggleBtn = document.getElementById('sidebar-toggle');
        if (toggleBtn) toggleBtn.addEventListener('click', () => document.body.classList.toggle('sidebar-collapsed'));
    }

    showToast(msg, isError = false) {
        const toast = document.getElementById('toast');
        if (!toast) return; // Prevent crash if toast HTML isn't set up
        const p = document.getElementById('toast-message');
        toast.className = `fixed bottom-4 right-6 bg-surface-card border-l-4 ${isError ? 'border-red-500' : 'border-green-500'} text-white px-6 py-4 rounded shadow-2xl transition-all duration-300 z-[100]`;
        p.innerHTML = `<i data-lucide="${isError ? 'alert-circle' : 'check-circle'}" class="w-5 h-5 ${isError ? 'text-red-500' : 'text-green-500'}"></i> ${this.esc(msg)}`;
        if (window.lucide) lucide.createIcons();
        toast.style.transform = 'translateY(0)';
        toast.style.opacity = '1';
        setTimeout(() => { toast.style.transform = 'translateY(20px)'; toast.style.opacity = '0'; }, 3000);
    }

    esc(str) {
        return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
    }
}

const app = new App();
app.boot();
