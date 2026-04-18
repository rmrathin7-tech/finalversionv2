// js/fsa/ui/analysis.js  ─── complete rebuild
import { buildFinancialModel, applyReclassifications } from "../core/engine.js";
import { formatValue, formatIN }        from "../utils/formatters.js";
import { doc }                          from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db }                           from "../../firebase.js";

// ── Module-level singletons ────────────────────────────────────────
let _chart           = null;
let _ratioPairs      = [{ id: 1, setA: [], setB: [] }];
let _sharedDenomOn   = false;
let _sharedDenom     = [];
let _quill           = null;
let _pickerTarget    = null;

const PALETTE = [
    '#6366F1','#10B981','#F59E0B','#EF4444','#06B6D4',
    '#8B5CF6','#EC4899','#84CC16','#F97316','#14B8A6'
];

// ── Export ─────────────────────────────────────────────────────────
export function initAnalysis({
    currentFsaData,
    reclassMap,
    updateDocRef,
    projectId,
    fsaId,
    pnlSchema,
    balanceSheetSchema,
    customRatios = [],
    configSchemas
}) {
    // Use configSchemas.documents if available; fall back to legacy pnlSchema/bsSchema pair
    const allDocSchemas = configSchemas?.documents?.length
        ? configSchemas.documents
        : [pnlSchema, balanceSheetSchema].filter(Boolean);

    const engineConfig          = configSchemas || { pnlSchema, bsSchema: balanceSheetSchema, customRatios };
    const effectiveCustomRatios = configSchemas?.customRatios ?? customRatios ?? [];

    // ── Helpers ───────────────────────────────────────────────────

    /** Compute period-over-period % change; returns null when prev is 0 */
    function calcYoY(val, prev) {
        return prev !== 0 ? ((val - prev) / Math.abs(prev)) * 100 : null;
    }

    function yoyCls(yoy) { return yoy === null ? '' : yoy >= 0 ? 'aw2-pos' : 'aw2-neg'; }

    function getDocSource(sectionKey) {
        for (const d of allDocSchemas) {
            if ((d?.structure || []).find(s => s.key === sectionKey)) return d.key;
        }
        return null;
    }

    function getMetricValue(key, year) {
        const model = buildFinancialModel(currentFsaData.data, year, reclassMap, engineConfig);
        if (key.includes('__')) {
            const sep    = key.indexOf('__');
            const secKey = key.slice(0, sep);
            const itKey  = key.slice(sep + 2);
            const docKey = getDocSource(secKey);
            // Apply reclassification to line-item lookup so reclassified items show correct value
            const rawVal = currentFsaData.data?.[docKey]?.[secKey]?.[year]?.[itKey] ?? 0;
            // If this item was reclassified OUT of this section, return 0
            if (reclassMap?.[docKey]?.[secKey]?.[itKey]) return 0;
            // If this item was reclassified INTO this section from another section, add inbound value
            let inbound = 0;
            const docMap = reclassMap?.[docKey] || {};
            Object.entries(docMap).forEach(([fromSec, items]) => {
                if (items[itKey] === secKey) {
                    inbound += currentFsaData.data?.[docKey]?.[fromSec]?.[year]?.[itKey] ?? 0;
                }
            });
            return rawVal + inbound;
        }
        if (key.startsWith('cr__')) return computeCustomRatio(key.slice(4), year);
        return model[key] ?? 0;
    }

    function computeCustomRatio(ratioKey, year) {
        const ratio = effectiveCustomRatios.find(r => r.key === ratioKey);
        if (!ratio) return 0;
        const model = buildFinancialModel(currentFsaData.data, year, reclassMap, engineConfig);
        const sum   = arr => (arr || []).reduce((s, k) => s + (model[k] || 0), 0);
        const den   = sum(ratio.denominator);
        return den !== 0 ? sum(ratio.numerator) / den : 0;
    }

    function getSectionTitle(sectionKey) {
        for (const d of allDocSchemas) {
            const f = (d?.structure || []).find(s => s.key === sectionKey);
            if (f) return f.title;
        }
        return sectionKey;
    }

    function getMetricLabel(key) {
        if (key.includes('__')) {
            const sep  = key.indexOf('__');
            const sec  = key.slice(0, sep);
            const item = key.slice(sep + 2);
            const disp = item.includes('||') ? item.split('||')[1] : item;
            return getSectionTitle(sec) + ' \u203a ' + disp;
        }
        if (key.startsWith('cr__')) return effectiveCustomRatios.find(r => r.key === key.slice(4))?.label || key;
        const m = (engineConfig?.metricsFormulas || []).find(f => f.key === key);
        if (m) return m.label;
        return getSectionTitle(key) || key;
    }

    function getMode() {
        return document.querySelector('input[name="aw2-mode-radio"]:checked')?.value || 'raw';
    }

    function getSelectedMetrics() {
        return Array.from(document.querySelectorAll('#aw2-metric-tree input[type="checkbox"]:checked')).map(cb => cb.value);
    }

    function getSelectedYears() {
        return Array.from(document.querySelectorAll('#aw2-year-pills .aw2-year-pill.selected')).map(el => el.dataset.year);
    }

    function esc(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── Metric Tree ───────────────────────────────────────────────
    function buildMetricTree(container, preSelected = []) {
        if (!container) return;
        container.innerHTML = '';

        allDocSchemas.forEach(docSchema => {
            if (!docSchema || !(docSchema.structure || []).some(s => s.type === 'section')) return;
            const g = mkEl('div', 'aw2-tree-group');
            g.innerHTML = '<div class="aw2-tree-group-label">' + esc(docSchema.title || docSchema.key) + '</div>';

            (docSchema.structure || []).filter(s => s.type === 'section').forEach(section => {
                const sec = mkEl('div', 'aw2-tree-section');
                sec.appendChild(makeCheckRow(section.title + ' (Total)', section.key, preSelected.includes(section.key), true));

                const store = currentFsaData.data?.[docSchema.key]?.[section.key] || {};
                const items = new Set();
                (currentFsaData.years || []).forEach(y => Object.keys(store[y] || {}).forEach(i => items.add(i)));
                if (items.size) {
                    const itemsEl = mkEl('div', 'aw2-tree-items');
                    [...items].forEach(ik => {
                        const vk   = section.key + '__' + ik;
                        const sub  = ik.includes('||');
                        const disp = sub ? ik.split('||')[1] : ik;
                        itemsEl.appendChild(makeCheckRow(disp, vk, preSelected.includes(vk), false, sub));
                    });
                    sec.appendChild(itemsEl);
                }
                (section.totals || []).forEach(t => sec.appendChild(makeCheckRow('\u21b3 ' + t.title, t.key, preSelected.includes(t.key), false, false, true)));
                g.appendChild(sec);
            });
            container.appendChild(g);
        });

        const formulas = engineConfig?.metricsFormulas || [];
        if (formulas.length) {
            const g = mkEl('div', 'aw2-tree-group');
            g.innerHTML = '<div class="aw2-tree-group-label">KPI Formulas</div>';
            formulas.forEach(m => g.appendChild(makeCheckRow(m.label, m.key, preSelected.includes(m.key), false, false, true)));
            container.appendChild(g);
        }

        if (effectiveCustomRatios.length) {
            const g = mkEl('div', 'aw2-tree-group');
            g.innerHTML = '<div class="aw2-tree-group-label">Custom Ratios</div>';
            effectiveCustomRatios.forEach(r => {
                g.appendChild(makeCheckRow(r.label, 'cr__' + r.key, preSelected.includes('cr__' + r.key)));
            });
            container.appendChild(g);
        }

        container.addEventListener('change', updateMetricBadge);
    }

    function mkEl(tag, cls) { const el = document.createElement(tag); if (cls) el.className = cls; return el; }

    function makeCheckRow(label, value, checked, isTotal, isSub, isFormula) {
        const row = mkEl('label', 'aw2-tree-row' + (isTotal ? ' aw2-tree-total' : '') + (isSub ? ' aw2-tree-sub' : '') + (isFormula ? ' aw2-tree-formula' : ''));
        const cb  = document.createElement('input');
        cb.type = 'checkbox'; cb.value = value; cb.checked = !!checked;
        const sp  = document.createElement('span'); sp.textContent = label;
        row.appendChild(cb); row.appendChild(sp);
        return row;
    }

    function updateMetricBadge() {
        const n = document.querySelectorAll('#aw2-metric-tree input:checked').length;
        const b = document.getElementById('aw2-metric-badge');
        if (b) { b.textContent = n ? n + ' selected' : ''; b.style.display = n ? '' : 'none'; }
    }

    // ── Year Pills ────────────────────────────────────────────────
    function buildYearPills(container, preSelected = []) {
        if (!container) return;
        const sorted = [...(currentFsaData?.years ?? [])].sort(
            (a, b) => (parseInt(a.replace(/\D/g,'')) || 0) - (parseInt(b.replace(/\D/g,'')) || 0)
        );
        container.innerHTML = '';

        const allBtn = mkYearPill('All', null);
        allBtn.classList.add('aw2-year-all');
        allBtn.addEventListener('click', () => {
            const pills = container.querySelectorAll('.aw2-year-pill[data-year]');
            const anyOff = [...pills].some(p => !p.classList.contains('selected'));
            pills.forEach(p => p.classList.toggle('selected', anyOff));
            updateYearBadge();
        });
        container.appendChild(allBtn);

        sorted.forEach(y => {
            const p = mkYearPill(y, y);
            if (preSelected.includes(y)) p.classList.add('selected');
            p.addEventListener('click', () => { p.classList.toggle('selected'); updateYearBadge(); });
            container.appendChild(p);
        });
        updateYearBadge();
    }

    function mkYearPill(label, year) {
        const btn = document.createElement('button');
        btn.className = 'aw2-year-pill'; btn.type = 'button'; btn.textContent = label;
        if (year) btn.dataset.year = year;
        return btn;
    }

    function updateYearBadge() {
        const y = getSelectedYears();
        const b = document.getElementById('aw2-year-badge');
        if (b) { b.textContent = y.length ? y.length + ' yrs' : ''; b.style.display = y.length ? '' : 'none'; }
    }

    // ── Mode Cards ────────────────────────────────────────────────
    function initModeCards() {
        document.querySelectorAll('.aw2-mode-card').forEach(card => {
            const radio = card.querySelector('input[type="radio"]');
            if (radio?.checked) card.classList.add('selected');
            card.addEventListener('click', () => {
                document.querySelectorAll('.aw2-mode-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                updateTabLocks();
            });
        });
        // Reclass toggle inside mode panel
        document.getElementById('aw2-mode-reclass-cb')?.addEventListener('change', updateTabLocks);
    }

    // ── Ratio Pairs ───────────────────────────────────────────────
    function renderRatioPairs() {
        const container = document.getElementById('aw2-ratio-pairs');
        if (!container) return;
        container.innerHTML = '';

        const sharedToggle = mkEl('div', 'aw2-ratio-shared-toggle');
        sharedToggle.innerHTML = '<label class="aw2-toggle-label">' +
            '<input type="checkbox" id="aw2-shared-denom-cb"' + (_sharedDenomOn ? ' checked' : '') + ' />' +
            '<span class="aw2-toggle-track"></span>' +
            '<span class="aw2-toggle-text">Use a shared Denominator (Set B) for <strong>all pairs</strong></span>' +
            '</label>';
        container.appendChild(sharedToggle);

        document.getElementById('aw2-shared-denom-cb')?.addEventListener('change', e => {
            _sharedDenomOn = e.target.checked; renderRatioPairs();
        });

        if (_sharedDenomOn) {
            const box = mkEl('div', 'aw2-ratio-denom-box');
            box.innerHTML = '<div class="aw2-slot-label"><span class="aw2-badge aw2-badge-denom">Shared Denominator (Set B)</span></div>' +
                '<div class="aw2-chips" id="aw2-shared-chips"></div>' +
                '<button class="aw2-add-metric-btn" data-target="shared">+ Add to Shared Denominator</button>';
            container.appendChild(box);
            renderChipsInto('aw2-shared-chips', _sharedDenom, 'shared');
        }

        _ratioPairs.forEach((pair, pi) => {
            const card = mkEl('div', 'aw2-ratio-pair-card');
            const denomHtml = _sharedDenomOn
                ? '<div class="aw2-shared-notice">\u2713 Using Shared Denominator defined above</div>'
                : '<div class="aw2-chips" id="aw2-pair' + pi + '-setb"></div>' +
                  '<button class="aw2-add-metric-btn" data-target="pair' + pi + '-setb">+ Add to Denominator</button>';

            card.innerHTML =
                '<div class="aw2-pair-header">' +
                    '<span class="aw2-pair-title">Pair ' + (pi + 1) + '</span>' +
                    (_ratioPairs.length > 1 ? '<button class="aw2-pair-remove" data-pair="' + pi + '" title="Remove pair">\u2715 Remove</button>' : '') +
                '</div>' +
                '<div class="aw2-pair-body">' +
                    '<div class="aw2-pair-slot">' +
                        '<div class="aw2-slot-label"><span class="aw2-badge aw2-badge-num">Numerator (Set A)</span><small>What you are measuring</small></div>' +
                        '<div class="aw2-chips" id="aw2-pair' + pi + '-seta"></div>' +
                        '<button class="aw2-add-metric-btn" data-target="pair' + pi + '-seta">+ Add to Numerator</button>' +
                    '</div>' +
                    '<div class="aw2-pair-divider">\u00f7</div>' +
                    '<div class="aw2-pair-slot">' +
                        '<div class="aw2-slot-label"><span class="aw2-badge aw2-badge-denom">Denominator (Set B)</span><small>The base to compare against</small></div>' +
                        denomHtml +
                    '</div>' +
                '</div>';
            container.appendChild(card);
            renderChipsInto('aw2-pair' + pi + '-seta', pair.setA, 'pair' + pi + '-seta');
            if (!_sharedDenomOn) renderChipsInto('aw2-pair' + pi + '-setb', pair.setB, 'pair' + pi + '-setb');
        });

        const addBtn = mkEl('button', 'aw2-add-pair-btn');
        addBtn.type = 'button'; addBtn.innerHTML = '+ Add Another Pair';
        container.appendChild(addBtn);

        container.querySelectorAll('.aw2-pair-remove').forEach(btn =>
            btn.addEventListener('click', () => { _ratioPairs.splice(parseInt(btn.dataset.pair), 1); renderRatioPairs(); })
        );
        addBtn.addEventListener('click', () => { _ratioPairs.push({ id: Date.now(), setA: [], setB: [] }); renderRatioPairs(); });
        container.querySelectorAll('.aw2-add-metric-btn').forEach(btn =>
            btn.addEventListener('click', () => openMetricPicker(btn.dataset.target))
        );
        container.querySelectorAll('.aw2-chip-del').forEach(btn =>
            btn.addEventListener('click', () => { removeFromTarget(btn.dataset.target, btn.dataset.key); renderRatioPairs(); })
        );
    }

    function renderChipsInto(elId, keys, target) {
        const el = document.getElementById(elId);
        if (!el) return;
        if (!keys.length) { el.innerHTML = '<span class="aw2-chips-empty">None selected</span>'; return; }
        el.innerHTML = keys.map(k =>
            '<span class="aw2-chip"><span class="aw2-chip-label">' + esc(getMetricLabel(k)) + '</span>' +
            '<button class="aw2-chip-del" data-target="' + esc(target) + '" data-key="' + esc(k) + '" type="button">\u2715</button></span>'
        ).join('');
    }

    function removeFromTarget(target, key) {
        if (target === 'shared') {
            _sharedDenom = _sharedDenom.filter(k => k !== key);
        } else {
            const m = target.match(/^pair(\d+)-(seta|setb)$/);
            if (!m) return;
            const idx = parseInt(m[1]);
            if (m[2] === 'seta') _ratioPairs[idx].setA = _ratioPairs[idx].setA.filter(k => k !== key);
            else                  _ratioPairs[idx].setB = _ratioPairs[idx].setB.filter(k => k !== key);
        }
    }

    // ── Metric Picker Modal ───────────────────────────────────────
    function openMetricPicker(target) {
        _pickerTarget = target;
        const modal = document.getElementById('aw2-picker-modal');
        if (!modal) return;
        buildMetricTree(document.getElementById('aw2-picker-tree'), []);
        const s = document.getElementById('aw2-picker-search');
        if (s) s.value = '';
        filterPickerTree('');
        modal.classList.add('open');
    }

    function filterPickerTree(q) {
        const lq = q.toLowerCase();
        document.querySelectorAll('#aw2-picker-tree .aw2-tree-row').forEach(row => {
            row.style.display = (!lq || row.textContent.toLowerCase().includes(lq)) ? '' : 'none';
        });
        document.querySelectorAll('#aw2-picker-tree .aw2-tree-group').forEach(g => {
            g.style.display = [...g.querySelectorAll('.aw2-tree-row')].some(r => r.style.display !== 'none') ? '' : 'none';
        });
    }

    function initMetricPickerModal() {
        document.getElementById('aw2-picker-cancel')?.addEventListener('click', () =>
            document.getElementById('aw2-picker-modal')?.classList.remove('open'));
        document.getElementById('aw2-picker-confirm')?.addEventListener('click', () => {
            const selected = Array.from(document.querySelectorAll('#aw2-picker-tree input:checked')).map(cb => cb.value);
            if (_pickerTarget === 'shared') {
                _sharedDenom = [...new Set([..._sharedDenom, ...selected])];
            } else {
                const m = (_pickerTarget || '').match(/^pair(\d+)-(seta|setb)$/);
                if (m) {
                    const idx = parseInt(m[1]);
                    if (m[2] === 'seta') _ratioPairs[idx].setA = [...new Set([..._ratioPairs[idx].setA, ...selected])];
                    else                  _ratioPairs[idx].setB = [...new Set([..._ratioPairs[idx].setB, ...selected])];
                }
            }
            document.getElementById('aw2-picker-modal')?.classList.remove('open');
            renderRatioPairs();
        });
        document.getElementById('aw2-picker-search')?.addEventListener('input', e => filterPickerTree(e.target.value));
        document.getElementById('aw2-picker-modal')?.addEventListener('click', e => {
            if (e.target === document.getElementById('aw2-picker-modal'))
                e.target.classList.remove('open');
        });
    }

    // ── Metric Search ─────────────────────────────────────────────
    function initMetricSearch() {
        document.getElementById('aw2-metric-search')?.addEventListener('input', e => {
            const q = e.target.value.toLowerCase();
            document.querySelectorAll('#aw2-metric-tree .aw2-tree-row').forEach(row => {
                row.style.display = (!q || row.textContent.toLowerCase().includes(q)) ? '' : 'none';
            });
            document.querySelectorAll('#aw2-metric-tree .aw2-tree-group').forEach(g => {
                g.style.display = [...g.querySelectorAll('.aw2-tree-row')].some(r => r.style.display !== 'none') ? '' : 'none';
            });
        });
    }

    // ── Reclassification ─────────────────────────────────────────
    function initReclassification() {
        const fromSel    = document.getElementById('aw2-reclass-from');
        const toSel      = document.getElementById('aw2-reclass-to');
        const itemsWrap  = document.getElementById('aw2-reclass-items-wrap');
        if (!fromSel || !toSel || !itemsWrap) return;

        const sections = allDocSchemas.flatMap(d =>
            (d?.structure || []).filter(s => s.type === 'section').map(s => ({ key: s.key, title: s.title, docKey: d.key }))
        );
        fromSel.innerHTML = ''; toSel.innerHTML = '';
        sections.forEach(s => {
            fromSel.innerHTML += '<option value="' + s.key + '">' + esc(s.title) + '</option>';
            toSel.innerHTML   += '<option value="' + s.key + '">' + esc(s.title) + '</option>';
        });

        function buildItemCheckboxes() {
            const secKey = fromSel.value;
            const docKey = getDocSource(secKey);
            const store  = currentFsaData.data?.[docKey]?.[secKey] || {};
            const items  = new Set();
            Object.values(store).forEach(yr => Object.keys(yr || {}).forEach(i => items.add(i)));
            if (!items.size) {
                itemsWrap.innerHTML = '<span class="aw2-reclass-items-empty">No items in this section</span>';
                return;
            }
            itemsWrap.innerHTML = [...items].map(i => {
                const display = i.includes('||') ? i.split('||')[1] : i;
                return '<label class="aw2-reclass-cb-item">' +
                    '<input type="checkbox" value="' + esc(i) + '" />' +
                    '<span>' + esc(display) + '</span></label>';
            }).join('');
        }

        fromSel.addEventListener('change', buildItemCheckboxes);
        setTimeout(buildItemCheckboxes, 0);

        document.getElementById('aw2-reclass-apply')?.addEventListener('click', () => {
            const from  = fromSel.value;
            const to    = toSel.value;
            const items = Array.from(itemsWrap.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
            if (!items.length) { showToast('Select at least one line item to reclassify.'); return; }
            if (from === to)   { showToast('Source and destination sections must be different.'); return; }
            const src = getDocSource(from);
            if (!reclassMap[src]) reclassMap[src] = {};
            if (!reclassMap[src][from]) reclassMap[src][from] = {};
            items.forEach(i => { reclassMap[src][from][i] = to; });
            // Uncheck applied items
            itemsWrap.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
            renderReclassChips();
        });

        document.getElementById('aw2-reclass-clear')?.addEventListener('click', () => {
            Object.keys(reclassMap).forEach(k => { reclassMap[k] = {}; });
            renderReclassChips();
        });
        renderReclassChips();
    }

    function renderReclassChips() {
        const container = document.getElementById('aw2-reclass-active');
        if (!container) return;
        const all = [];
        Object.entries(reclassMap).forEach(([, sections]) => {
            Object.entries(sections || {}).forEach(([from, items]) => {
                Object.entries(items || {}).forEach(([item, to]) => all.push({ from, item, to }));
            });
        });
        if (!all.length) { container.innerHTML = '<span class="aw2-reclass-empty">No active reclassifications</span>'; return; }
        container.innerHTML = all.map(r =>
            '<span class="aw2-reclass-chip">' +
            '<span class="aw2-rc-from">' + esc(getSectionTitle(r.from)) + '</span>' +
            ' \u203a <span class="aw2-rc-item">' + esc(r.item) + '</span>' +
            ' \u2192 <span class="aw2-rc-to">' + esc(getSectionTitle(r.to)) + '</span>' +
            '</span>'
        ).join('');
    }

    function flashBtn(id, text, color) {
        const btn = document.getElementById(id);
        if (!btn) return;
        const orig = btn.textContent; const origBg = btn.style.background;
        btn.textContent = text; btn.style.background = color;
        setTimeout(() => { btn.textContent = orig; btn.style.background = origBg; }, 1800);
    }

    // ── Step Tabs ─────────────────────────────────────────────────
    function initStepTabs() {
        const tabs   = document.querySelectorAll('.aw2-step-tab');
        const panels = document.querySelectorAll('.aw2-step-panel');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                if (tab.classList.contains('locked')) return;
                tabs.forEach(t => t.classList.remove('active'));
                panels.forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById('aw2-step-' + tab.dataset.step)?.classList.add('active');
            });
        });
    }

    function updateTabLocks() {
        const mode       = getMode();
        const reclassOn  = document.getElementById('aw2-mode-reclass-cb')?.checked ?? false;
        const ratiosTab  = document.querySelector('.aw2-step-tab[data-step="ratios"]');
        const reclassTab = document.querySelector('.aw2-step-tab[data-step="reclass"]');

        if (ratiosTab) {
            const lock = mode !== 'ratios';
            ratiosTab.classList.toggle('locked', lock);
            ratiosTab.setAttribute('aria-disabled', lock ? 'true' : 'false');
            ratiosTab.title = lock ? 'Select "Ratio Analysis" mode to unlock' : '';
            // If currently active and now locked, jump back to mode
            if (lock && ratiosTab.classList.contains('active')) {
                document.querySelectorAll('.aw2-step-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.aw2-step-panel').forEach(p => p.classList.remove('active'));
                document.querySelector('.aw2-step-tab[data-step="mode"]')?.classList.add('active');
                document.getElementById('aw2-step-mode')?.classList.add('active');
            }
        }
        if (reclassTab) {
            const lock = !reclassOn;
            reclassTab.classList.toggle('locked', lock);
            reclassTab.setAttribute('aria-disabled', lock ? 'true' : 'false');
            reclassTab.title = lock ? 'Enable "Include Reclassification" in Mode step to unlock' : '';
            if (lock && reclassTab.classList.contains('active')) {
                document.querySelectorAll('.aw2-step-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.aw2-step-panel').forEach(p => p.classList.remove('active'));
                document.querySelector('.aw2-step-tab[data-step="mode"]')?.classList.add('active');
                document.getElementById('aw2-step-mode')?.classList.add('active');
            }
        }
    }

    // ── Run Analysis ──────────────────────────────────────────────
    function runAnalysis() {
        const mode      = getMode();
        const metrics   = getSelectedMetrics();
        const years     = getSelectedYears();
        // Treat reclass as "on" if the toggle is checked OR if there are active reclassifications
        const toggleOn  = document.getElementById('aw2-mode-reclass-cb')?.checked ?? false;
        const hasActiveReclass = Object.values(reclassMap).some(doc =>
            Object.values(doc || {}).some(sec => Object.keys(sec || {}).length > 0)
        );
        const reclassOn = toggleOn || hasActiveReclass;
        if (!years.length) { showToast('Select at least one year.'); return; }
        if (mode === 'yoy' && years.length < 2) { showToast('YoY analysis requires at least 2 years.'); return; }
        // Metrics are only required for raw/yoy/both modes when reclass is NOT active
        if (mode !== 'ratios' && !reclassOn && !metrics.length) {
            showToast('Select at least one metric.'); return;
        }
        document.getElementById('aw2-output-wrap')?.classList.add('visible');
        if (mode === 'ratios') {
            renderRatioOutput(years);
        } else if (reclassOn && !metrics.length) {
            // No metrics selected — show full reclassified statements
            renderReclassOutput(years);
        } else {
            renderTableOutput(metrics, years, mode);
            renderChartOutput(metrics, years, mode);
        }
    }

    // ── Table Renderer ────────────────────────────────────────────
    function renderTableOutput(metrics, years, mode) {
        const container = document.getElementById('aw2-table-area');
        if (!container) return;
        // Ensure chart card is visible (may have been hidden by renderReclassOutput)
        document.getElementById('aw2-chart')?.closest('.aw2-chart-card')?.style.removeProperty('display');
        const modeLabel = { raw: 'Raw Values', yoy: 'Year-on-Year Change', both: 'Raw + YoY Change' }[mode] || '';

        let html = '<div class="aw2-table-label">' + modeLabel + '</div><div class="aw2-table-scroll">' +
            '<table class="aw2-table"><thead><tr>' +
            '<th class="aw2-col-fixed">Metric</th>' +
            years.map((y, i) => {
                if (mode === 'raw')  return '<th>' + esc(y) + '</th>';
                if (mode === 'yoy')  return i === 0 ? '<th>' + esc(y) + '<br><small>Base</small></th>' : '<th>' + esc(years[i-1]) + '\u2192' + esc(y) + '</th>';
                return '<th>' + esc(y) + '</th>';
            }).join('') +
            '</tr></thead><tbody>';

        metrics.forEach(key => {
            const rawVals = years.map(y => getMetricValue(key, y));
            html += '<tr><td class="aw2-col-fixed">' + esc(getMetricLabel(key)) + '</td>';
            years.forEach((y, i) => {
                const val = rawVals[i];
                const fmt = formatValue(key, val, engineConfig);
                if (mode === 'raw') {
                    html += '<td>' + fmt + '</td>';
                } else if (mode === 'yoy') {
                    if (i === 0) { html += '<td class="aw2-base-cell">' + fmt + '</td>'; }
                    else {
                        const yoy = calcYoY(val, rawVals[i-1]);
                        const cls = yoyCls(yoy);
                        html += '<td class="' + cls + '">' + (yoy === null ? '\u2014' : (yoy >= 0 ? '+' : '') + yoy.toFixed(1) + '%') + '</td>';
                    }
                } else {
                    if (i === 0) { html += '<td>' + fmt + '</td>'; }
                    else {
                        const yoy   = calcYoY(val, rawVals[i-1]);
                        const cls   = yoyCls(yoy);
                        const badge = yoy === null ? '' : '<span class="aw2-yoy-badge ' + cls + '">' + (yoy >= 0 ? '\u25b2' : '\u25bc') + Math.abs(yoy).toFixed(1) + '%</span>';
                        html += '<td>' + fmt + ' ' + badge + '</td>';
                    }
                }
            });
            html += '</tr>';
        });
        html += '</tbody></table></div>';
        container.innerHTML = html;
    }

    // ── Chart Renderer ────────────────────────────────────────────
    function renderChartOutput(metrics, years, mode) {
        const canvas = document.getElementById('aw2-chart');
        if (!canvas) return;
        if (_chart) { _chart.destroy(); _chart = null; }
        const isYoY = mode === 'yoy'; const isBoth = mode === 'both';
        const cc = chartColors();
        const datasets = [];

        metrics.forEach((key, idx) => {
            const color   = PALETTE[idx % PALETTE.length];
            const label   = getMetricLabel(key);
            const rawVals = years.map(y => getMetricValue(key, y));
            if (mode === 'raw' || isBoth) {
                datasets.push({ label, data: rawVals, type: 'bar',
                    backgroundColor: color + '33', borderColor: color, borderWidth: 2, borderRadius: 4, yAxisID: 'y' });
            }
            if (isYoY || isBoth) {
                datasets.push({ label: label + ' (YoY %)',
                    data: rawVals.map((v, i) => { if (i === 0) return null; return calcYoY(v, rawVals[i-1]); }),
                    type: 'line', borderColor: color, backgroundColor: 'transparent',
                    borderWidth: 2, tension: 0.35, pointRadius: 4, pointBackgroundColor: color, spanGaps: false,
                    yAxisID: isBoth ? 'y1' : 'y' });
            }
        });

        _chart = new Chart(canvas.getContext('2d'), { data: { labels: years, datasets }, options: buildChartOpts(cc, isBoth) });
    }

    function buildChartOpts(cc, dual) {
        return {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top', labels: { color: cc.text, font: { size: 11 }, padding: 14, usePointStyle: true, pointStyleWidth: 8 } },
                tooltip: { backgroundColor: cc.bg, titleColor: cc.title, bodyColor: cc.text, borderColor: cc.border, borderWidth: 1, padding: 10 }
            },
            scales: {
                x:  { ticks: { color: cc.text, font: { size: 11 } }, grid: { color: cc.grid } },
                y:  { type: 'linear', position: 'left', ticks: { color: cc.text }, grid: { color: cc.grid } },
                y1: { type: 'linear', position: 'right', display: !!dual,
                    ticks: { color: cc.text, callback: v => v.toFixed(1) + '%' }, grid: { drawOnChartArea: false } }
            }
        };
    }

    function chartColors() {
        const dark = document.documentElement.getAttribute('data-theme') !== 'light';
        return { text: dark ? '#94A3B8' : '#475569', grid: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)',
                 bg:   dark ? '#181B27' : '#FFFFFF', title: dark ? '#EEF2FF' : '#0F172A',
                 border: dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' };
    }

    // ── Ratio Output ──────────────────────────────────────────────
    function renderRatioOutput(years) {
        const container = document.getElementById('aw2-table-area');
        if (!container) return;
        if (_chart) { _chart.destroy(); _chart = null; }
        // Ensure chart card is visible
        document.getElementById('aw2-chart')?.closest('.aw2-chart-card')?.style.removeProperty('display');
        const canvas = document.getElementById('aw2-chart');
        const pairs = _ratioPairs.filter(p => p.setA.length > 0);
        if (!pairs.length) { container.innerHTML = '<div class="aw2-empty">Configure numerator (Set A) in Step 4 before running.</div>'; return; }

        const cc = chartColors();
        const ratioDatasets = [];
        let html = '<div class="aw2-table-label">Ratio Analysis (A \u00f7 B)</div><div class="aw2-table-scroll">' +
            '<table class="aw2-table"><thead><tr><th class="aw2-col-fixed">Description</th>' +
            years.map(y => '<th>' + esc(y) + '</th>').join('') + '</tr></thead><tbody>';

        pairs.forEach((pair, pi) => {
            const denom   = _sharedDenomOn ? _sharedDenom : pair.setB;
            const numVals = years.map(y => pair.setA.reduce((s, k) => s + getMetricValue(k, y), 0));
            const denVals = years.map(y => denom.reduce((s,  k) => s + getMetricValue(k, y), 0));
            const ratios  = numVals.map((n, i) => denVals[i] !== 0 ? (n / denVals[i]) * 100 : null);

            html +=
                '<tr class="aw2-ratio-group-head"><td colspan="' + (years.length + 1) + '">Pair ' + (pi+1) + ' &mdash; ' +
                esc(pair.setA.map(getMetricLabel).join(' + ')) + ' \u00f7 ' +
                esc((denom.length ? denom : ['\u2014']).map(getMetricLabel).join(' + ')) + '</td></tr>' +
                '<tr><td class="aw2-col-fixed"><span class="aw2-badge aw2-badge-num">Numerator (A)</span><br><small>' +
                esc(pair.setA.map(getMetricLabel).join(', ') || '\u2014') + '</small></td>' +
                numVals.map(v => '<td>' + formatIN(v) + '</td>').join('') + '</tr>' +
                '<tr><td class="aw2-col-fixed"><span class="aw2-badge aw2-badge-denom">Denominator (B)</span><br><small>' +
                esc(denom.map(getMetricLabel).join(', ') || '\u2014') + '</small></td>' +
                denVals.map(v => '<td>' + formatIN(v) + '</td>').join('') + '</tr>' +
                '<tr class="aw2-ratio-result"><td class="aw2-col-fixed"><strong>Ratio A\u00f7B</strong></td>' +
                ratios.map(v => '<td><strong>' + (v === null ? '\u2014' : v.toFixed(2) + '%') + '</strong></td>').join('') + '</tr>';

            const col = PALETTE[pi % PALETTE.length];
            ratioDatasets.push({ label: 'Pair ' + (pi+1),
                data: ratios, type: 'line', borderColor: col, backgroundColor: col + '33',
                borderWidth: 2, tension: 0.35, pointRadius: 5, pointBackgroundColor: col, spanGaps: false, yAxisID: 'y' });
        });

        html += '</tbody></table></div>';
        container.innerHTML = html;

        if (canvas && ratioDatasets.length) {
            _chart = new Chart(canvas.getContext('2d'), {
                data: { labels: years, datasets: ratioDatasets },
                options: { ...buildChartOpts(cc, false),
                    scales: { x: { ticks: { color: cc.text }, grid: { color: cc.grid } },
                              y: { ticks: { color: cc.text, callback: v => v.toFixed(1)+'%' }, grid: { color: cc.grid } } } }
            });
        }
    }

    // ── Reclassification Statement Output ────────────────────────
    function renderReclassOutput(years) {
        const container = document.getElementById('aw2-table-area');
        if (!container) return;
        if (_chart) { _chart.destroy(); _chart = null; }
        // Hide chart canvas since we show a statement table instead
        const canvas = document.getElementById('aw2-chart');
        if (canvas) canvas.closest('.aw2-chart-card')?.style.setProperty('display', 'none');

        let html = '';
        allDocSchemas.forEach(docSchema => {
            const sections = (docSchema.structure || []).filter(s => s.type === 'section');
            if (!sections.length) return;

            // Build reclassified snapshots per year
            const reclassedByYear = {};
            years.forEach(y => {
                const clone = JSON.parse(JSON.stringify(currentFsaData.data?.[docSchema.key] || {}));
                applyReclassifications(clone, y, docSchema.key, reclassMap);
                reclassedByYear[y] = clone;
            });

            html += '<div class="aw2-reclass-doc-heading">' + esc(docSchema.title || docSchema.key.toUpperCase()) + '</div>';
            html += '<div class="aw2-table-scroll"><table class="aw2-table">';
            html += '<thead><tr><th class="aw2-col-fixed">Line Item</th>' +
                years.map(y => '<th>' + esc(y) + '</th>').join('') + '</tr></thead><tbody>';

            sections.forEach(section => {
                html += '<tr class="aw2-reclass-sec-head"><td colspan="' + (years.length + 1) + '">' + esc(section.title) + '</td></tr>';

                // Collect all line items across all years for this section
                const allItems = new Set();
                years.forEach(y => {
                    Object.keys(reclassedByYear[y][section.key]?.[y] || {}).forEach(i => allItems.add(i));
                });

                allItems.forEach(item => {
                    const displayName = item.includes('||') ? item.split('||')[1] : item;
                    html += '<tr><td class="aw2-col-fixed aw2-reclass-li">' + esc(displayName) + '</td>';
                    years.forEach(y => {
                        const val = reclassedByYear[y][section.key]?.[y]?.[item] ?? 0;
                        html += '<td>' + (val !== 0 ? formatIN(val) : '&mdash;') + '</td>';
                    });
                    html += '</tr>';
                });

                // Section total using the reclassified model
                html += '<tr class="aw2-reclass-sec-total"><td class="aw2-col-fixed"><strong>' + esc(section.title) + ' Total</strong></td>';
                years.forEach(y => {
                    const model = buildFinancialModel(currentFsaData.data, y, reclassMap, engineConfig);
                    const val = model[section.key] ?? 0;
                    html += '<td><strong>' + formatIN(val) + '</strong></td>';
                });
                html += '</tr>';
            });

            html += '</tbody></table></div>';
        });

        container.innerHTML = html || '<div class="aw2-empty">No document sections found to display.</div>';
    }

    // ── Toast ─────────────────────────────────────────────────────
    function showToast(msg) {
        const el = document.getElementById('aw2-toast');
        if (!el) { alert(msg); return; }
        el.textContent = msg; el.classList.add('show');
        clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 3000);
    }

    // ── Quill Notes ───────────────────────────────────────────────
    async function initNotes() {
        const container = document.getElementById('aw2-notes-editor');
        if (!container) return;
        if (typeof Quill === 'undefined') await loadQuill().catch(() => null);
        if (typeof Quill !== 'undefined') {
            try {
                _quill = new Quill('#aw2-notes-editor', {
                    theme: 'snow',
                    placeholder: 'Add analysis notes, observations, and commentary here\u2026',
                    modules: { toolbar: [['bold','italic','underline'],
                        [{ list:'ordered' },{ list:'bullet' }],[{ header:[2,3,false] }],['clean']] }
                });
                return;
            } catch(e) { /* fall through to textarea */ }
        }
        container.innerHTML = '<textarea class="aw2-notes-ta" placeholder="Add analysis notes, observations, and commentary here\u2026"></textarea>';
    }

    function loadQuill() {
        return new Promise(resolve => {
            if (document.querySelector('script[src*="quill"]')) { resolve(); return; }
            const link = document.createElement('link');
            link.rel = 'stylesheet'; link.href = 'https://cdn.quilljs.com/1.3.7/quill.snow.css';
            document.head.appendChild(link);
            const s = document.createElement('script');
            s.src = 'https://cdn.quilljs.com/1.3.7/quill.min.js'; s.onload = resolve; s.onerror = resolve;
            document.head.appendChild(s);
        });
    }

    function getNotes() {
        if (_quill) return _quill.root.innerHTML;
        return document.querySelector('.aw2-notes-ta')?.value || '';
    }

    function setNotes(html) {
        if (_quill) { _quill.root.innerHTML = html || ''; return; }
        const ta = document.querySelector('.aw2-notes-ta'); if (ta) ta.value = html || '';
    }

    // ── Save / Load ───────────────────────────────────────────────
    async function saveAnalysis() {
        const ni   = document.getElementById('aw2-save-name');
        const name = ni?.value?.trim() || 'Analysis ' + new Date().toISOString().split('T')[0];
        const payload = {
            name, createdAt: new Date().toISOString(),
            config: { metrics: getSelectedMetrics(), years: getSelectedYears(), mode: getMode(),
                      ratioPairs: JSON.parse(JSON.stringify(_ratioPairs)),
                      sharedDenomOn: _sharedDenomOn, sharedDenom: [..._sharedDenom] },
            reclassMap: JSON.parse(JSON.stringify(reclassMap)), notes: getNotes()
        };
        if (!currentFsaData.savedAnalyses) currentFsaData.savedAnalyses = [];
        currentFsaData.savedAnalyses.push(payload);
        try {
            await updateDocRef(doc(db, 'projects', projectId, 'fsa', fsaId), { savedAnalyses: currentFsaData.savedAnalyses });
            if (ni) ni.value = '';
            renderSavedList();
            flashBtn('aw2-save-btn', '\u2713 Saved', 'var(--positive, #10b981)');
        } catch(e) { showToast('Save failed \u2014 please try again.'); }
    }

    function loadAnalysis(index) {
        const saved = currentFsaData.savedAnalyses?.[index];
        if (!saved) return;
        const cfg = saved.config || {};
        const sel = cfg.metrics || cfg.metricsA || [];
        document.querySelectorAll('#aw2-metric-tree input[type="checkbox"]').forEach(cb => { cb.checked = sel.includes(cb.value); });
        updateMetricBadge();
        document.querySelectorAll('#aw2-year-pills .aw2-year-pill[data-year]').forEach(p => {
            p.classList.toggle('selected', (cfg.years || []).includes(p.dataset.year));
        });
        updateYearBadge();
        let mode = cfg.mode || 'raw';
        if (cfg.setMode === 'compare') mode = 'ratios';
        document.querySelectorAll('input[name="aw2-mode-radio"]').forEach(r => {
            r.checked = r.value === mode;
            r.closest('.aw2-mode-card')?.classList.toggle('selected', r.checked);
        });
        _ratioPairs    = cfg.ratioPairs || (cfg.metricsB?.length ? [{ id:1, setA: sel, setB: cfg.metricsB }] : [{ id:1, setA:[], setB:[] }]);
        _sharedDenomOn = cfg.sharedDenomOn || false;
        _sharedDenom   = cfg.sharedDenom   || [];
        renderRatioPairs();
        // Restore reclass toggle state if saved
        const reclassCb = document.getElementById('aw2-mode-reclass-cb');
        if (reclassCb) reclassCb.checked = !!(saved.reclassMap && Object.keys(saved.reclassMap).some(k => Object.keys(saved.reclassMap[k] || {}).length > 0));
        if (saved.reclassMap) { Object.assign(reclassMap, saved.reclassMap); renderReclassChips(); }
        updateTabLocks();
        setNotes(saved.notes || saved.context || '');
        runAnalysis();
        document.getElementById('aw2-output-wrap')?.scrollIntoView({ behavior: 'smooth' });
    }

    async function deleteAnalysis(index) {
        if (!confirm('Delete this saved analysis?')) return;
        currentFsaData.savedAnalyses.splice(index, 1);
        await updateDocRef(doc(db, 'projects', projectId, 'fsa', fsaId), { savedAnalyses: currentFsaData.savedAnalyses });
        renderSavedList();
    }

    function renderSavedList() {
        const container = document.getElementById('aw2-saved-list');
        if (!container) return;
        const list = currentFsaData.savedAnalyses || [];
        if (!list.length) { container.innerHTML = '<div class="aw2-saved-empty">No saved analyses yet. Configure and save one above.</div>'; return; }
        container.innerHTML = list.map((a, i) =>
            '<div class="aw2-saved-card">' +
            '<div class="aw2-saved-body" onclick="window._aw2Load(' + i + ')">' +
            '<div class="aw2-saved-name">' + esc(a.name) + '</div>' +
            '<div class="aw2-saved-meta"><span>' + (a.config?.metrics || a.config?.metricsA || []).length + ' metrics</span>' +
            '<span>\u00b7</span><span>' + (a.config?.years || []).length + ' years</span>' +
            '<span>\u00b7</span><span>' + new Date(a.createdAt).toLocaleDateString('en-IN') + '</span></div></div>' +
            '<button class="aw2-saved-del" onclick="event.stopPropagation();window._aw2Delete(' + i + ')" title="Delete">\u2715</button>' +
            '</div>'
        ).join('');
    }

    // ── Reset ─────────────────────────────────────────────────────
    function resetAnalysis() {
        document.querySelectorAll('#aw2-metric-tree input').forEach(cb => { cb.checked = false; });
        updateMetricBadge();
        document.querySelectorAll('#aw2-year-pills .aw2-year-pill.selected').forEach(p => p.classList.remove('selected'));
        updateYearBadge();
        document.querySelectorAll('input[name="aw2-mode-radio"]').forEach((r, i) => {
            r.checked = i === 0; r.closest('.aw2-mode-card')?.classList.toggle('selected', i === 0);
        });
        const reclassCb = document.getElementById('aw2-mode-reclass-cb');
        if (reclassCb) reclassCb.checked = false;
        _ratioPairs = [{ id:1, setA:[], setB:[] }]; _sharedDenomOn = false; _sharedDenom = [];
        renderRatioPairs();
        Object.keys(reclassMap).forEach(k => { reclassMap[k] = {}; });
        renderReclassChips();
        setNotes('');
        if (_chart) { _chart.destroy(); _chart = null; }
        document.getElementById('aw2-output-wrap')?.classList.remove('visible');
        document.getElementById('aw2-table-area')?.replaceChildren();
        updateTabLocks();
    }

    // ── Init ──────────────────────────────────────────────────────
    function initializeAnalysisWorkbench() {
        _chart = null; _ratioPairs = [{ id:1, setA:[], setB:[] }];
        _sharedDenomOn = false; _sharedDenom = []; _quill = null;

        initStepTabs();
        buildMetricTree(document.getElementById('aw2-metric-tree'));
        buildYearPills(document.getElementById('aw2-year-pills'));
        initModeCards();
        initMetricSearch();
        renderRatioPairs();
        initReclassification();
        initMetricPickerModal();
        initNotes();
        updateTabLocks(); // apply initial lock state

        document.getElementById('aw2-run-btn')?.addEventListener('click',   runAnalysis);
        document.getElementById('aw2-reset-btn')?.addEventListener('click', resetAnalysis);
        document.getElementById('aw2-save-btn')?.addEventListener('click',  saveAnalysis);

        window._aw2Load           = loadAnalysis;
        window._aw2Delete         = deleteAnalysis;
        window.loadSavedAnalysis  = loadAnalysis;
        window.deleteSavedAnalysis= deleteAnalysis;

        renderSavedList();
    }

    // ── HTML Template ─────────────────────────────────────────────
    function getHtmlTemplate() {
        return `<div class="aw2-wrap">
<!-- Header -->
<div class="aw2-header">
  <div class="aw2-header-left"><span class="aw2-header-icon">&#128202;</span><span class="aw2-header-title">Analysis Workbench</span></div>
  <div class="aw2-header-right">
    <button class="aw2-btn-ghost" id="aw2-reset-btn">&#8635; Reset</button>
    <button class="aw2-btn-primary" id="aw2-run-btn">&#9654; Run Analysis</button>
  </div>
</div>
<!-- Config Panel -->
<div class="aw2-config-panel">
  <div class="aw2-steps">
    <button class="aw2-step-tab active" data-step="mode">
      <span class="aw2-step-num">1</span><span class="aw2-step-label">Analysis Mode</span>
    </button>
    <button class="aw2-step-tab" data-step="metrics">
      <span class="aw2-step-num">2</span><span class="aw2-step-label">Select Metrics</span>
      <span class="aw2-step-badge" id="aw2-metric-badge" style="display:none"></span>
    </button>
    <button class="aw2-step-tab" data-step="years">
      <span class="aw2-step-num">3</span><span class="aw2-step-label">Select Years</span>
      <span class="aw2-step-badge" id="aw2-year-badge" style="display:none"></span>
    </button>
    <button class="aw2-step-tab locked" data-step="ratios">
      <span class="aw2-step-num">4</span><span class="aw2-step-label">Ratio Pairs (A&#247;B)</span>
    </button>
    <button class="aw2-step-tab locked" data-step="reclass">
      <span class="aw2-step-num">5</span><span class="aw2-step-label">Reclassification</span>
    </button>
  </div>
  <!-- Step 1 — Analysis Mode -->
  <div class="aw2-step-panel active" id="aw2-step-mode">
    <p class="aw2-step-hint">Choose how to view the data. Ratio mode uses Step 4 pairs. Enable reclassification to unlock Step 5.</p>
    <div class="aw2-mode-grid">
      <label class="aw2-mode-card selected"><input type="radio" name="aw2-mode-radio" value="raw" checked />
        <div class="aw2-mode-content"><span class="aw2-mode-icon">&#128203;</span><span class="aw2-mode-name">Raw Data</span><span class="aw2-mode-desc">Actual values &middot; Bar chart</span></div>
      </label>
      <label class="aw2-mode-card"><input type="radio" name="aw2-mode-radio" value="yoy" />
        <div class="aw2-mode-content"><span class="aw2-mode-icon">&#128200;</span><span class="aw2-mode-name">Year-on-Year</span><span class="aw2-mode-desc">% change vs prior year &middot; Line chart</span></div>
      </label>
      <label class="aw2-mode-card"><input type="radio" name="aw2-mode-radio" value="both" />
        <div class="aw2-mode-content"><span class="aw2-mode-icon">&#128202;</span><span class="aw2-mode-name">Raw + YoY</span><span class="aw2-mode-desc">Values with change badges &middot; Combo chart</span></div>
      </label>
      <label class="aw2-mode-card"><input type="radio" name="aw2-mode-radio" value="ratios" />
        <div class="aw2-mode-content"><span class="aw2-mode-icon">&#247;</span><span class="aw2-mode-name">Ratio Analysis</span><span class="aw2-mode-desc">A &#247; B pairs &mdash; unlocks Step 4</span></div>
      </label>
    </div>
    <div class="aw2-mode-reclass-row">
      <label class="aw2-toggle-label aw2-mode-reclass-toggle">
        <input type="checkbox" id="aw2-mode-reclass-cb" />
        <span class="aw2-toggle-track"></span>
        <span class="aw2-toggle-text">Include Reclassification &mdash; unlocks Step 5</span>
      </label>
    </div>
  </div>
  <!-- Step 2 — Select Metrics -->
  <div class="aw2-step-panel" id="aw2-step-metrics">
    <p class="aw2-step-hint">Choose section totals, line items, sub-items, KPI formulas, or custom ratios from all your documents.</p>
    <input type="search" class="aw2-search-input" id="aw2-metric-search" placeholder="&#128269;  Filter metrics&hellip;" />
    <div class="aw2-metric-tree" id="aw2-metric-tree"></div>
  </div>
  <!-- Step 3 — Select Years -->
  <div class="aw2-step-panel" id="aw2-step-years">
    <p class="aw2-step-hint">Click year pills to select. "All" toggles the full range.</p>
    <div class="aw2-year-pills" id="aw2-year-pills"></div>
  </div>
  <!-- Step 4 — Ratio Pairs -->
  <div class="aw2-step-panel" id="aw2-step-ratios">
    <p class="aw2-step-hint">Define one or more Numerator (Set A) &#247; Denominator (Set B) pairs. Optionally share one denominator across all pairs.</p>
    <div id="aw2-ratio-pairs"></div>
  </div>
  <!-- Step 5 — Reclassification -->
  <div class="aw2-step-panel" id="aw2-step-reclass">
    <p class="aw2-step-hint">Reclassify line items between sections before running analysis. If no metrics are selected, Run Analysis will show the full reclassified statement.</p>
    <div class="aw2-reclass-row">
      <div class="aw2-reclass-col">
        <label class="aw2-field-label">From Section</label>
        <select id="aw2-reclass-from" class="aw2-select"></select>
      </div>
      <div class="aw2-reclass-col aw2-reclass-items">
        <label class="aw2-field-label">Line Items</label>
        <div id="aw2-reclass-items-wrap" class="aw2-reclass-cb-list"></div>
      </div>
      <span class="aw2-reclass-arrow">&#8594;</span>
      <div class="aw2-reclass-col">
        <label class="aw2-field-label">To Section</label>
        <select id="aw2-reclass-to" class="aw2-select"></select>
      </div>
      <div class="aw2-reclass-actions">
        <button id="aw2-reclass-apply" class="aw2-btn-primary aw2-btn-sm">&#10003; Apply</button>
        <button id="aw2-reclass-clear" class="aw2-btn-ghost aw2-btn-sm">&#215; Clear All</button>
      </div>
    </div>
    <div class="aw2-reclass-chips-row"><span class="aw2-field-label">Active:</span><div id="aw2-reclass-active"></div></div>
  </div>
</div>
<!-- Toast -->
<div class="aw2-toast" id="aw2-toast"></div>
<!-- Output -->
<div class="aw2-output-wrap" id="aw2-output-wrap">
  <div class="aw2-output-header">Analysis Output</div>
  <div class="aw2-chart-card"><div class="aw2-chart-inner"><canvas id="aw2-chart"></canvas></div></div>
  <div class="aw2-table-card" id="aw2-table-area"></div>
</div>
<!-- Notes -->
<div class="aw2-notes-card">
  <div class="aw2-notes-header"><span class="aw2-notes-title">&#128221; Analysis Notes</span></div>
  <div id="aw2-notes-editor" class="aw2-notes-editor"></div>
</div>
<!-- Save Bar -->
<div class="aw2-save-bar">
  <input type="text" id="aw2-save-name" class="aw2-save-input" placeholder="Name this analysis&hellip;" />
  <button id="aw2-save-btn" class="aw2-btn-save">&#128190; Save Analysis</button>
</div>
<!-- Saved Analyses -->
<div class="aw2-saved-section">
  <div class="aw2-saved-title">Saved Analyses</div>
  <div id="aw2-saved-list" class="aw2-saved-list"></div>
</div>
<!-- Picker Modal -->
<div class="aw2-modal-overlay" id="aw2-picker-modal">
  <div class="aw2-modal">
    <div class="aw2-modal-head">
      <span class="aw2-modal-title">Select Metrics</span>
      <input type="search" id="aw2-picker-search" class="aw2-modal-search" placeholder="&#128269;  Filter&hellip;" />
    </div>
    <div class="aw2-metric-tree aw2-modal-tree" id="aw2-picker-tree"></div>
    <div class="aw2-modal-foot">
      <button id="aw2-picker-cancel" class="aw2-btn-ghost">Cancel</button>
      <button id="aw2-picker-confirm" class="aw2-btn-primary">Add Selected</button>
    </div>
  </div>
</div>
</div>`;
    }

    return { initializeAnalysisWorkbench, getHtmlTemplate };
}
