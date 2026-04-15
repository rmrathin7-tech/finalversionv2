// js/im-core/renderer.js

import { getNestedValue } from './utils.js';

export function renderSection(sectionSchema, canvas, imData) {
    if (!sectionSchema) {
        canvas.innerHTML = `<div class="im-empty-state">Section not found in schema.</div>`;
        return [];
    }

    const quillTargets = [];
    const blocks = [...(sectionSchema.blocks || [])].sort((a, b) => a.order - b.order);

    canvas.innerHTML = `
        <div class="memo-section">
            <h2>${esc(sectionSchema.heading)}</h2>
            ${blocks.map(b => renderBlock(b, imData, quillTargets)).join('\n')}
        </div>
    `;

    canvas.querySelectorAll('.guide-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault(); 
            e.stopPropagation();
            const box = document.getElementById(btn.dataset.guide);
            if (box) {
                const isHidden = box.style.display === 'none';
                box.style.display = isHidden ? 'block' : 'none';
                
                btn.innerHTML = isHidden ? '🙈 HIDE GUIDE' : '💡 GUIDE';
                btn.style.color = isHidden ? '#ef4444' : '#3b82f6';
                btn.style.background = isHidden ? 'rgba(239, 68, 68, 0.15)' : 'rgba(59, 130, 246, 0.15)';
            }
        });
    });

    return quillTargets;
}

// ── Block dispatcher ──────────────────────────────────────────────────────────
function renderBlock(block, imData, quillTargets) {
    const isHidden = getNestedValue(imData, `_hiddenBlocks.${block.id}`);
    
    if (isHidden) {
        return `
        <div class="field-group excluded-block" style="padding: 10px 16px; border: 1px dashed var(--border); background: var(--surface2); display: flex; justify-content: space-between; align-items: center; border-radius: 6px; margin-bottom: 16px;">
            <span style="font-size: 12px; color: var(--text2); opacity: 0.8;">🚫 <strong>${esc(block.label || 'Unnamed Block')}</strong> is excluded from this deal.</span>
            <button class="restore-block-btn" data-block-id="${esc(block.id)}" style="font-size: 11px; padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='var(--border)'" onmouseout="this.style.background='var(--surface)'">↺ Bring Back</button>
        </div>`;
    }

    const visibilityAttr = block.showCondition ? ` data-show-condition="${esc(block.showCondition)}"` : '';
    const actionBtn = `<span class="hide-block-btn" data-block-id="${esc(block.id)}" style="cursor:pointer; color:var(--text2); font-size:11px; font-weight:normal; margin-left:auto; transition:color 0.2s; padding-left:12px;" title="Exclude this block from the memo" onmouseover="this.style.color='#ef4444';" onmouseout="this.style.color='var(--text2)';">🗑️ Exclude</span>`;

    switch (block.type) {
        case 'instruction':
            return `
                <div class="field-group instruction-block"${visibilityAttr} style="padding: 12px 16px; background: rgba(16, 185, 129, 0.1); border-left: 4px solid #10b981; border-radius: 4px; margin-bottom: 16px; display: flex; flex-direction: column;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        ${block.label ? `<strong style="font-size:13px; color:#10b981; margin-bottom:6px;">${esc(block.label)}</strong>` : ''}
                        ${actionBtn}
                    </div>
                    <div style="font-size:13px; color:var(--text); line-height:1.5; white-space:pre-wrap;">${esc(block.content || block.placeholder || '')}</div>
                </div>`;
        case 'text':
        case 'email':
        case 'number':
        case 'date':            return renderInput(block, imData, visibilityAttr, actionBtn);
        case 'checkbox':        return renderCheckbox(block, imData, visibilityAttr, actionBtn);
        case 'textarea':        return renderTextarea(block, imData, visibilityAttr, actionBtn);
        case 'quill':           return renderQuill(block, imData, quillTargets, visibilityAttr, actionBtn);
        case 'select':          return renderSelect(block, imData, visibilityAttr, actionBtn);
        case 'mixed':           return renderMixed(block, imData, visibilityAttr, actionBtn);
        case 'h3':              return `<div style="display:flex; align-items:center; width:100%;"${visibilityAttr}><h3>${esc(block.label)}</h3>${actionBtn}</div>`;
        case 'h4':              return `<div style="display:flex; align-items:center; width:100%;"${visibilityAttr}><h4>${esc(block.label)}</h4>${actionBtn}</div>`;
        case 'divider':         return `<div style="display:flex; align-items:center; width:100%;"${visibilityAttr}><div class="field-divider" style="flex:1;">${esc(block.label || '')}</div>${actionBtn}</div>`;
        case 'table-static':    return renderSingleDynamicTable(block, imData, visibilityAttr, actionBtn); 
        case 'table':           
        case 'table-repeating': return renderRepeatingTableGroups(block, imData, visibilityAttr, actionBtn); 
        case 'image':           return renderImage(block, imData, visibilityAttr, actionBtn);
        case 'file':            return renderFile(block, imData, visibilityAttr, actionBtn);
        default:                return '';
    }
}

function renderCheckbox(block, imData, visibilityAttr, actionBtn) {
    const val = getNestedValue(imData, block.dataPath);
    const isChecked = !!val;
    return `
        <div class="field-group"${visibilityAttr} style="display:flex; align-items:center; justify-content:space-between; flex-direction:row;">
            <div style="display:flex; align-items:center; gap:10px;">
                <input type="checkbox" class="editor-field" data-path="${esc(block.dataPath)}" ${isChecked ? 'checked' : ''} style="width:18px;height:18px;cursor:pointer;margin:0;">
                ${block.label ? `<label style="margin:0;cursor:pointer;font-weight:600;">${esc(block.label)}</label>` : ''}
            </div>
            ${actionBtn}
        </div>`;
}

function renderInput(block, imData, visibilityAttr, actionBtn) {
    const val = esc(getNestedValue(imData, block.dataPath) ?? '');
    const pre = block.prefix ? `<span style="opacity:0.6;font-weight:800;font-size:13px;">${esc(block.prefix)}</span>` : '';
    const suf = block.suffix ? `<span style="opacity:0.6;font-weight:800;font-size:13px;">${esc(block.suffix)}</span>` : '';
    
    let inputEl = `<input type="${block.type}" class="editor-field flex-1" data-path="${esc(block.dataPath)}" value="${val}" placeholder="${esc(block.placeholder || '')}" style="${pre||suf ? 'box-shadow:none; border:none; background:transparent; padding:0;' : ''}">`;
    if (pre || suf) {
        inputEl = `<div class="editor-field flex items-center gap-3" style="display:flex; align-items:center; gap:8px;">${pre}${inputEl}${suf}</div>`;
    }
    return `
        <div class="field-group"${visibilityAttr}>
            ${block.label 
                ? `<label style="display:flex; align-items:center; width:100%;">${esc(block.label)}${actionBtn}</label>` 
                : `<div style="display:flex; justify-content:flex-end; width:100%; margin-bottom:4px;">${actionBtn}</div>`}
            ${inputEl}
        </div>`;
}

function renderTextarea(block, imData, visibilityAttr, actionBtn) {
    const val = esc(getNestedValue(imData, block.dataPath) ?? '');
    return `
        <div class="field-group"${visibilityAttr}>
            ${block.label 
                ? `<label style="display:flex; align-items:center; width:100%;">${esc(block.label)}${actionBtn}</label>` 
                : `<div style="display:flex; justify-content:flex-end; width:100%; margin-bottom:4px;">${actionBtn}</div>`}
            <textarea class="editor-field" data-path="${esc(block.dataPath)}" placeholder="${esc(block.placeholder || '')}">${val}</textarea>
        </div>`;
}

function renderQuill(block, imData, quillTargets, visibilityAttr, actionBtn) {
    const editorId = `qe-${block.id}`;
    const initial  = getNestedValue(imData, block.dataPath) ?? '';
    quillTargets.push({ editorId, dataPath: block.dataPath, initialContent: initial });

    const guideId = `${editorId}-guide`;
    const guideToggleHtml = block.guide 
        ? `<span class="guide-toggle" data-guide="${guideId}" style="cursor:pointer; color:#3b82f6; font-size:10px; font-weight:800; letter-spacing:0.5px; text-transform:uppercase; margin-left:10px; padding:3px 8px; border-radius:12px; background:rgba(59, 130, 246, 0.15); transition:all 0.2s; display:inline-flex; align-items:center;" onmouseover="this.style.background='rgba(59, 130, 246, 0.25)'" onmouseout="this.style.background='rgba(59, 130, 246, 0.15)'">💡 GUIDE</span>` 
        : '';
    const guideBoxHtml = block.guide 
        ? `<div id="${guideId}" class="guide-box" style="display:none; margin:10px 0 16px 0; padding:14px 16px; background:rgba(59, 130, 246, 0.08); border-left:4px solid #3b82f6; border-radius:6px; font-size:13px; color:var(--text); line-height:1.6; white-space:pre-wrap;">${esc(block.guide)}</div>` 
        : '';

    return `
        <div class="field-group"${visibilityAttr}>
            ${block.label
                ? `<label style="display:flex; align-items:center; width:100%;">${esc(block.label)}${guideToggleHtml}${actionBtn}</label>`
                : `<div style="display:flex; align-items:center; width:100%; margin-bottom:8px;">${guideToggleHtml}${actionBtn}</div>`
            }
            ${guideBoxHtml}
            <div class="quill-editor" id="${editorId}" data-path="${esc(block.dataPath)}" data-placeholder="${esc(block.placeholder || '')}"></div>
        </div>`;
}

function renderSelect(block, imData, visibilityAttr, actionBtn) {
    const val = getNestedValue(imData, block.dataPath);
    const options = block.options || [];
    const isCustomValue = val && !options.includes(val);
    const pre = block.prefix ? `<span style="opacity:0.6;font-weight:800;font-size:13px;">${esc(block.prefix)}</span>` : '';
    const suf = block.suffix ? `<span style="opacity:0.6;font-weight:800;font-size:13px;">${esc(block.suffix)}</span>` : '';

    let selectEl = `
        <select class="editor-field select-with-custom flex-1" data-path="${esc(block.dataPath)}" style="${pre||suf ? 'box-shadow:none; border:none; background:transparent; padding:0;' : ''}">
            <option value="">Select...</option>
            ${options.map(o => `<option value="${esc(o)}" ${val === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
            ${isCustomValue ? `<option value="${esc(val)}" selected>${esc(val)}</option>` : ''}
            <option value="__CUSTOM__" style="color:var(--s-accent); font-weight:bold;">+ Custom...</option>
        </select>`;

    if (pre || suf) {
        selectEl = `<div class="editor-field flex items-center gap-3" style="display:flex; align-items:center; gap:8px;">${pre}${selectEl}${suf}</div>`;
    }

    return `
        <div class="field-group"${visibilityAttr}>
            ${block.label 
                ? `<label style="display:flex; align-items:center; width:100%;">${esc(block.label)}${actionBtn}</label>` 
                : `<div style="display:flex; justify-content:flex-end; width:100%; margin-bottom:4px;">${actionBtn}</div>`}
            ${selectEl}
        </div>`;
}

function renderMixed(block, imData, visibilityAttr, actionBtn) {
    const val = getNestedValue(imData, block.dataPath);
    let mixedValues = Array.isArray(val) ? val : [];
    let blankIndex = 0;
    
    let formattedMixed = (block.template || '').replace(/\[(text|number|date|select)\]/gi, (match, type) => {
        const currentVal = mixedValues[blankIndex] || '';
        const idx = blankIndex++;
        const typeLower = type.toLowerCase();
        
        if (typeLower === 'select') {
            const options = block.options || [];
            const isCustomValue = currentVal && !options.includes(currentVal);
            const opts = options.map(opt => `<option value="${esc(opt)}" ${currentVal === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('');

            return `<select class="editor-field"
                    data-path="${esc(block.dataPath)}" data-mixed-idx="${idx}"
                    style="display:inline-block; width:auto; padding:6px 12px; margin:0 6px; background:var(--surface2); border:1px solid var(--border); border-radius:6px; outline:none; color:inherit; font-family:inherit; cursor:pointer;">
                <option value="">— Select —</option>
                ${opts}
                ${isCustomValue ? `<option value="${esc(currentVal)}" selected>${esc(currentVal)}</option>` : ''}
                <option value="__CUSTOM__" style="color:var(--s-accent); font-weight:bold;">+ Custom...</option>
            </select>`;
        } else {
            const width = typeLower === 'date' ? '140px' : '100px';
            return `<input type="${typeLower}" class="editor-field"
                   data-path="${esc(block.dataPath)}" data-mixed-idx="${idx}"
                   value="${esc(currentVal)}"
                   style="display:inline-block; width:${width}; padding:6px 12px; margin:0 6px; background:var(--surface2); border:1px solid var(--border); border-radius:6px; outline:none; color:var(--text); text-align:center; font-family:inherit;">`;
        }
    });

    return `
        <div class="field-group"${visibilityAttr}>
            ${block.label 
                ? `<label style="display:flex; align-items:center; width:100%;">${esc(block.label)}${actionBtn}</label>` 
                : `<div style="display:flex; justify-content:flex-end; width:100%; margin-bottom:4px;">${actionBtn}</div>`}
            <div class="editor-field" style="line-height:2.4; font-size:15px; white-space:pre-wrap;">
                ${formattedMixed}
            </div>
        </div>`;
}

// ── Core Engine: Generates the actual rows based on the Grid configuration ────
function generateGridBodyHTML(block, records, targetDataPath, dynRows) {
    const numRows = block.rows.length;
    const cols = block.cols || 2;

    const totalExtraCols = (block.allowInlineInsert ? 1 : 0) + (dynRows ? 1 : 0);

    if (!records || records.length === 0) {
        return `<tbody><tr><td colspan="${cols + totalExtraCols}" style="text-align:center; padding: 20px; font-size: 12px; opacity: 0.5;">No records. Click '+ Add Record' to begin.</td></tr></tbody>`;
    }

    return records.map((record, recIdx) => {
        const occupied = Array.from({ length: numRows }, () => new Array(cols).fill(false));
        let recordRowsHTML = '';

       block.rows.forEach((row, ri) => {
            let cellsHTML = '';
            row.cells.forEach((cell, ci) => {
                if (occupied[ri][ci]) return;

                const cs = Math.min(Math.max(1, cell.colspan || 1), cols - ci);
                const rs = Math.min(Math.max(1, cell.rowspan || 1), numRows - ri);

                for (let r = ri; r < ri + rs; r++) {
                    for (let c = ci; c < ci + cs; c++) {
                        if (r < numRows && c < cols) occupied[r][c] = true;
                    }
                }

                const tdStyle = `border:1px solid var(--border);padding:0;`;
                const tdAttrs = `colspan="${cs}" rowspan="${rs}" style="${tdStyle}"`;
                const fieldVal = record[cell.id] ?? '';

                if (cell.cellType === 'fixed') {
                    cellsHTML += `<td ${tdAttrs}><div class="fixed-cell" style="padding:7px 10px;height:100%;box-sizing:border-box;">${esc(cell.text || '')}</div></td>`;
                } else if (cell.cellType === 'computed') {
                    cellsHTML += `<td ${tdAttrs}>
                        <input type="text" class="table-cell editor-field computed-cell" readonly
                               data-block-id="${esc(block.id)}" data-path="${esc(targetDataPath)}"
                               data-row="${recIdx}" data-col="${esc(cell.id)}" data-col-idx="${ci}" data-formula="${esc(cell.formula || '')}"
                               value="${esc(fieldVal)}"
                               style="cursor:not-allowed;height:100%;width:100%;box-sizing:border-box;padding:7px 10px;border:none;">
                    </td>`;
                } else if (cell.cellType === 'smart-select') {
                    let fieldArr = Array.isArray(fieldVal) ? fieldVal : (fieldVal ? [fieldVal] : []);
                    let selectedOpt = fieldArr[0] || '';
                    
                    let opts = (cell.conditions || []).map(cond => 
                        `<option value="${esc(cond.label)}" ${selectedOpt === cond.label ? 'selected' : ''}>${esc(cond.label)}</option>`
                    ).join('');

                    let selectElement = `<select class="table-cell editor-field smart-select-main"
                        data-block-id="${esc(block.id)}" data-path="${esc(targetDataPath)}"
                        data-row="${recIdx}" data-col="${esc(cell.id)}" data-col-idx="${ci}" data-mixed-idx="0"
                        style="display:inline-block; width:auto; max-width:140px; padding:2px 6px; margin:0 4px; background:var(--surface2); border:1px solid var(--border); border-radius:4px; outline:none; color:inherit; font-family:inherit; cursor:pointer;">
                        <option value="">— Select —</option>
                        ${opts}
                    </select>`;

                    let templatesHtml = (cell.conditions || []).map(cond => {
                        let isMatch = selectedOpt === cond.label;
                        let displayStyle = isMatch ? 'inline-block' : 'none';
                        let blankIndex = 0;
                        
                        let formatted = (cond.template || '').replace(/\[(text|number|date|select)\]/gi, (match, type) => {
                            const currentVal = isMatch ? (fieldArr[blankIndex + 1] || '') : '';
                            const idx = blankIndex + 1;
                            blankIndex++;
                            const typeLower = type.toLowerCase();
                            
                            if (typeLower === 'select') {
                                return `<select class="table-cell editor-field smart-cond-input"
                                       data-block-id="${esc(block.id)}" data-path="${esc(targetDataPath)}"
                                       data-row="${recIdx}" data-col="${esc(cell.id)}" data-col-idx="${ci}" data-mixed-idx="${idx}"
                                       style="display:inline-block; width:auto; padding:2px 6px; margin:0 4px; background:var(--surface2); border:1px solid var(--border); border-radius:4px; outline:none; color:inherit; cursor:pointer;">
                                    <option value="">— Select —</option>
                                    <option value="${esc(currentVal)}" selected>${esc(currentVal)}</option>
                                </select>`;
                            } else {
                                const width = typeLower === 'date' ? '120px' : '80px';
                                return `<input type="${typeLower}" class="table-cell editor-field smart-cond-input"
                                       data-block-id="${esc(block.id)}" data-path="${esc(targetDataPath)}"
                                       data-row="${recIdx}" data-col="${esc(cell.id)}" data-col-idx="${ci}" data-mixed-idx="${idx}"
                                       value="${esc(currentVal)}"
                                       style="display:inline-block; width:${width}; padding:2px 6px; margin:0 4px; background:var(--surface2); border:1px solid var(--border); border-radius:4px; outline:none; color:var(--text); text-align:center; font-family:inherit;">`;
                            }
                        });

                        return `<span class="smart-template-body" data-condition="${esc(cond.label)}" style="display:${displayStyle}; align-items:center;">${formatted}</span>`;
                    }).join('');

                    cellsHTML += `<td ${tdAttrs}>
                        <div style="padding:7px 10px; height:100%; box-sizing:border-box; line-height:2.4; font-size:13px; display:flex; align-items:center; flex-wrap:wrap;">
                            ${selectElement}
                            ${templatesHtml}
                        </div>
                    </td>`;
                } else if (cell.cellType === 'mixed') {
                    let mixedValues = Array.isArray(fieldVal) ? fieldVal : [];
                    let blankIndex = 0;
                    
                    let formattedMixed = (cell.template || '').replace(/\[(text|number|date|select)\]/gi, (match, type) => {
                        const currentVal = mixedValues[blankIndex] || '';
                        const idx = blankIndex++;
                        const typeLower = type.toLowerCase();
                        
                        if (typeLower === 'select') {
                            const options = cell.options || [];
                            const isCustomValue = currentVal && !options.includes(currentVal);
                            const opts = options.map(opt => `<option value="${esc(opt)}" ${currentVal === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('');

                            return `<select class="table-cell editor-field"
                                data-block-id="${esc(block.id)}" data-path="${esc(targetDataPath)}"
                                data-row="${recIdx}" data-col="${esc(cell.id)}" data-col-idx="${ci}" data-mixed-idx="${idx}"
                                style="display:inline-block; width:auto; max-width:140px; padding:2px 6px; margin:0 4px; background:var(--surface2); border:1px solid var(--border); border-radius:4px; outline:none; color:inherit; font-family:inherit; cursor:pointer;">
                                <option value="">— Select —</option>
                                ${opts}
                                ${isCustomValue ? `<option value="${esc(currentVal)}" selected>${esc(currentVal)}</option>` : ''}
                                <option value="__CUSTOM__" style="color:var(--s-accent); font-weight:bold;">+ Custom...</option>
                            </select>`;
                        } else {
                            const width = typeLower === 'date' ? '140px' : '100px';
                            return `<input type="${typeLower}" class="table-cell editor-field"
                                   data-block-id="${esc(block.id)}" data-path="${esc(targetDataPath)}"
                                   data-row="${recIdx}" data-col="${esc(cell.id)}" data-col-idx="${ci}" data-mixed-idx="${idx}"
                                   value="${esc(currentVal)}"
                                   style="display:inline-block; width:${width}; padding:6px 12px; margin:0 6px; background:var(--surface2); border:1px solid var(--border); border-radius:6px; outline:none; color:var(--text); text-align:center; font-family:inherit;">`;
                        }
                    });

                    cellsHTML += `<td ${tdAttrs}>
                        <div style="padding:7px 10px; height:100%; box-sizing:border-box; line-height:2.4; font-size:13px; white-space:pre-wrap;">
                            ${formattedMixed}
                        </div>
                    </td>`;
                } else {
                    const pre = cell.prefix ? `<span style="padding-right:6px; opacity:0.6; font-size:12px; font-weight:700; white-space:nowrap;">${esc(cell.prefix)}</span>` : '';
                    const suf = cell.suffix ? `<span style="padding-left:6px; opacity:0.6; font-size:12px; font-weight:700; white-space:nowrap;">${esc(cell.suffix)}</span>` : '';
                    
                    let inputElement = '';
                    
                    if (cell.inputType === 'textarea') {
                        inputElement = `<textarea class="table-cell editor-field"
                               data-block-id="${esc(block.id)}" data-path="${esc(targetDataPath)}"
                               data-row="${recIdx}" data-col="${esc(cell.id)}" data-col-idx="${ci}" placeholder="${esc(cell.placeholder || '—')}"
                               style="flex:1; resize:vertical; min-height:60px; box-sizing:border-box; padding:7px 0; font-family:inherit; background:transparent; border:none; outline:none;">${esc(fieldVal)}</textarea>`;
                    } else if (cell.inputType === 'select') {
                        const options = cell.options || [];
                        const isCustomValue = fieldVal && !options.includes(fieldVal);
                        const opts = options.map(opt => `<option value="${esc(opt)}" ${fieldVal === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('');

                        inputElement = `<select class="table-cell editor-field"
                            data-block-id="${esc(block.id)}" data-path="${esc(targetDataPath)}"
                            data-row="${recIdx}" data-col="${esc(cell.id)}" data-col-idx="${ci}"
                            style="flex:1; box-sizing:border-box; padding:7px 0; background:transparent; border:none; outline:none; color:inherit; cursor:pointer;">
                            <option value="">— Select —</option>
                            ${opts}
                            ${isCustomValue ? `<option value="${esc(fieldVal)}" selected>${esc(fieldVal)}</option>` : ''}
                            <option value="__CUSTOM__" style="color:var(--s-accent); font-weight:bold;">+ Custom...</option>
                        </select>`;
                    } else {
                        inputElement = `<input type="${cell.inputType || 'text'}" class="table-cell editor-field"
                               data-block-id="${esc(block.id)}" data-path="${esc(targetDataPath)}"
                               data-row="${recIdx}" data-col="${esc(cell.id)}" data-col-idx="${ci}"
                               value="${esc(fieldVal)}" placeholder="${esc(cell.placeholder || '—')}"
                               style="flex:1; box-sizing:border-box; padding:7px 0; background:transparent; border:none; outline:none; min-width:50px;">`;
                    }

                    cellsHTML += `<td ${tdAttrs}>
                        <div style="display:flex; align-items:${cell.inputType === 'textarea' ? 'flex-start' : 'center'}; padding:0 10px; height:100%; width:100%; box-sizing:border-box;">
                            ${pre}${inputElement}${suf}
                        </div>
                    </td>`;
                }
            });

            let delCellHTML = '';

            // 🌟 1. INNER MATRIX ACTION COLUMN (+/-)
            if (block.allowInlineInsert) {
                delCellHTML += `<td style="text-align:center;border:1px solid var(--border);border-left:none;width:54px;background:var(--surface2);">
                    <div style="display:flex; justify-content:center; gap:8px; opacity:0.3; transition:opacity 0.2s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.3'">
                        <span class="insert-inner-row-btn" data-block-id="${esc(block.id)}" data-ri="${ri}" style="cursor:pointer;color:var(--text2);font-size:16px;font-weight:bold;transition:color 0.2s;" onmouseover="this.style.color='var(--s-accent)'" onmouseout="this.style.color='var(--text2)'" title="Insert Template Row Below">+</span>
                        <span class="remove-inner-row-btn" data-block-id="${esc(block.id)}" data-ri="${ri}" style="cursor:pointer;color:var(--text2);font-size:18px;font-weight:bold;line-height:0.9;transition:color 0.2s;" onmouseover="this.style.color='var(--s-accent)'" onmouseout="this.style.color='var(--text2)'" title="Delete Template Row">×</span>
                    </div>
                </td>`;
            }

            // 🌟 2. ENTIRE RECORD ACTION COLUMN (+/-)
            if ((dynRows || block.allowDynamicColumns) && ri === 0) {
                const actionColWidth = block.allowInlineInsert ? '54px' : '40px';
                const rowDeleteHtml = dynRows ? `<span class="remove-row-btn" data-block-id="${esc(block.id)}" data-row="${recIdx}" data-path="${esc(targetDataPath)}" style="cursor:pointer;color:var(--text2);font-size:18px;font-weight:bold;line-height:0.9;transition:color 0.2s;" onmouseover="this.style.color='var(--s-accent)'" onmouseout="this.style.color='var(--text2)'" title="Delete Entire Record">×</span>` : '';
                
                delCellHTML += `<td rowspan="${numRows}" style="text-align:center;border:1px solid var(--border);border-left:none;width:${actionColWidth};background:var(--surface2);">
                    <div style="display:flex; justify-content:center; align-items:center; opacity:0.3; transition:opacity 0.2s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.3'">
                        ${rowDeleteHtml}
                    </div>
                </td>`;
            }

            recordRowsHTML += `<tr style="height:40px">${cellsHTML}${delCellHTML}</tr>`;
        });

        return `<tbody class="repeater-record" data-record="${recIdx}">${recordRowsHTML}</tbody>`;
    }).join('');
}

// ── 1. Single Dynamic Table ───────────────────────────────────────────────────
function renderSingleDynamicTable(block, imData, visibilityAttr, actionBtn) {
    if (!block.rows || block.rows.length === 0) return `<div style="opacity:0.4;font-size:12px;padding:8px">Template not configured yet.</div>`;

    const dynRows = block.dynamicRows !== false;
    let records = getNestedValue(imData, block.dataPath);
    
    if (records && typeof records === 'object' && !Array.isArray(records)) {
        records = Object.keys(records).sort((a,b)=>a-b).map(k => records[k]);
    }
    
    if (records === '' || records == null) {
        records = Array.from({ length: block.baseRowCount || 1 }, () => ({}));
    } else if (!Array.isArray(records)) {
        records = [];
    }

    const headersHTML = (block.colHeaders || []).map((h, i) => {
        if (block.editableHeaders) {
            let userHeader = '';
            const existingHeaders = getNestedValue(imData, `${block.dataPath}_headers`);
            if (Array.isArray(existingHeaders) && existingHeaders[i]) userHeader = existingHeaders[i];
            
            return `<th><input type="text" class="editable-header-input" data-path="${esc(block.dataPath)}_headers" data-col-idx="${i}" placeholder="${esc(h)}" value="${esc(userHeader || h)}" style="background:transparent; border:none; color:inherit; font-weight:bold; text-align:center; width:100%; outline:none;" /></th>`;
        }
        return `<th>${esc(h)}</th>`;
    }).join('');
    
    const innerInsertCol = block.allowInlineInsert ? `<th style="width:54px"></th>` : '';
const dynColsBtn = block.allowDynamicColumns ? `<span class="add-col-btn" data-block-id="${esc(block.id)}" style="cursor:pointer; color:var(--s-accent); font-size:16px; margin-right:8px;" title="Add Column">+</span><span class="remove-col-btn" data-block-id="${esc(block.id)}" style="cursor:pointer; color:var(--text2); font-size:18px; line-height:0.9;" title="Remove Last Column">×</span>` : '';
const deleteCol = (dynRows || block.allowDynamicColumns) ? `<th style="width:${block.allowInlineInsert ? '54px' : '40px'}; text-align:center;">${dynColsBtn}</th>` : '';
    const bodyHTML = generateGridBodyHTML(block, records, block.dataPath, dynRows);

    return `
        <div class="field-group"${visibilityAttr} data-table-wrap="${esc(block.id)}">
            ${block.label 
                ? `<label style="display:flex; align-items:center; width:100%;">${esc(block.label)}${actionBtn}</label>` 
                : `<div style="display:flex; justify-content:flex-end; width:100%; margin-bottom:4px;">${actionBtn}</div>`}
            <div class="dynamic-table-container">
                <table class="committee-table" data-block-id="${esc(block.id)}" data-path="${esc(block.dataPath)}">
                    <thead><tr>${headersHTML}${innerInsertCol}${deleteCol}</tr></thead>
                    ${bodyHTML}
                </table>
            </div>
            ${dynRows ? `<button class="add-row-btn" data-block-id="${esc(block.id)}" data-path="${esc(block.dataPath)}">+ Add Record</button>` : ''}        </div>`;
}

// ── 2. Repeating Table Groups ─────────────────────────────────────────────────
function renderRepeatingTableGroups(block, imData, visibilityAttr, actionBtn) {
    if (!block.rows || block.rows.length === 0) return `<div style="opacity:0.4;font-size:12px;padding:8px">Template not configured yet.</div>`;

    let tableGroups = getNestedValue(imData, block.dataPath);
    
    if (tableGroups && typeof tableGroups === 'object' && !Array.isArray(tableGroups)) {
        tableGroups = Object.keys(tableGroups).sort((a,b)=>a-b).map(k => tableGroups[k]);
    }
    
    if (tableGroups === '' || tableGroups == null) {
        tableGroups = [ { rows: Array.from({ length: block.baseRowCount || 1 }, () => ({})) } ]; 
    } else if (!Array.isArray(tableGroups)) {
        tableGroups = [];
    }

    const dynRows = block.dynamicRows !== false;
    
    const headersHTML = (block.colHeaders || []).map((h, i) => {
        if (block.editableHeaders) {
            let userHeader = '';
            const existingHeaders = getNestedValue(imData, `${block.dataPath}_headers`);
            if (Array.isArray(existingHeaders) && existingHeaders[i]) userHeader = existingHeaders[i];
            
            return `<th><input type="text" class="editable-header-input" data-path="${esc(block.dataPath)}_headers" data-col-idx="${i}" placeholder="${esc(h)}" value="${esc(userHeader || h)}" style="background:transparent; border:none; color:inherit; font-weight:bold; text-align:center; width:100%; outline:none;" /></th>`;
        }
        return `<th>${esc(h)}</th>`;
    }).join('');
    
    const innerInsertCol = block.allowInlineInsert ? `<th style="width:54px"></th>` : '';
const dynColsBtn = block.allowDynamicColumns ? `<span class="add-col-btn" data-block-id="${esc(block.id)}" style="cursor:pointer; color:var(--s-accent); font-size:16px; margin-right:8px;" title="Add Column">+</span><span class="remove-col-btn" data-block-id="${esc(block.id)}" style="cursor:pointer; color:var(--text2); font-size:18px; line-height:0.9;" title="Remove Last Column">×</span>` : '';
const deleteCol = (dynRows || block.allowDynamicColumns) ? `<th style="width:${block.allowInlineInsert ? '54px' : '40px'}; text-align:center;">${dynColsBtn}</th>` : '';
    const groupsHTML = tableGroups.map((group, tIdx) => {
        let records = group.rows; 
        if (!Array.isArray(records)) records = Object.values(records || {});
        
        if (group.rows === '' || group.rows == null) {
            records = Array.from({ length: block.baseRowCount || 1 }, () => ({}));
        } else if (!Array.isArray(records)) {
            records = [];
        }

        const tableDataPath = `${block.dataPath}.${tIdx}.rows`; 
        const bodyHTML = generateGridBodyHTML(block, records, tableDataPath, dynRows);

        // 🌟 Editable Group Label (e.g. "Education 1" becomes typed input)
        const groupLabelVal = group.groupLabel || (block.label ? block.label + ' ' + (tIdx + 1) : 'Table ' + (tIdx + 1));

        return `
            <div class="table-instance" style="margin-bottom: 24px; padding: 16px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border); box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                    <input type="text" class="editable-group-label" 
                        data-path="${esc(block.dataPath)}" data-index="${tIdx}" 
                        value="${esc(groupLabelVal)}" 
                        style="background:transparent; border:none; outline:none; font-weight:700; font-size:14px; color:var(--text); width:100%;" 
                        placeholder="Enter table name..." />
                    ${tIdx > 0 ? `<button class="remove-table-btn" data-path="${esc(block.dataPath)}" data-index="${tIdx}" style="background:transparent; color:var(--s-accent); border:1px solid var(--s-accent); white-space:nowrap; margin-left:12px; padding: 4px 12px; border-radius: 4px; font-size: 11px;">Remove Table</button>` : ''}
                </div>
                <div class="dynamic-table-container" style="margin-bottom:10px;">
                    <table class="committee-table" data-block-id="${esc(block.id)}" data-path="${esc(tableDataPath)}">
                        <thead><tr>${headersHTML}${innerInsertCol}${deleteCol}</tr></thead>
                        ${bodyHTML}
                    </table>
                </div>
                ${dynRows ? `<button class="add-row-btn" data-block-id="${esc(block.id)}" data-path="${esc(tableDataPath)}">+ Add Record</button>` : ''}        `;
    }).join('');

    return `
        <div class="field-group"${visibilityAttr} data-table-wrap="${esc(block.id)}">
            ${block.label 
                ? `<label style="display:flex; align-items:center; width:100%;">${esc(block.label)}${actionBtn}</label>` 
                : `<div style="display:flex; justify-content:flex-end; width:100%; margin-bottom:4px;">${actionBtn}</div>`}
            ${groupsHTML}
            <button class="add-table-btn" data-block-id="${esc(block.id)}" data-path="${esc(block.dataPath)}" style="width: 100%; border: 1px dashed var(--s-accent); background: rgba(239,68,68,0.05); color: var(--s-accent); padding: 12px; margin-top: 8px; font-size: 13px;">+ Add Entire Table Group</button>
        </div>`;
}

// ── File Uploads ─────────────────────────────────────────────────────────────
function renderFile(block, imData, visibilityAttr, actionBtn) {
    const raw     = getNestedValue(imData, block.dataPath);
    const fileList = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    const inputId = `file-input-${block.id}`;

    const filesHTML = fileList.map(f => {
        const src = typeof f === 'object' ? f.url : f;
        const name = typeof f === 'object' ? f.name : 'Attached Document';
        
        return `
        <div style="position:relative;display:inline-flex;align-items:center;gap:8px;padding:8px 12px;margin-right:12px;margin-bottom:8px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:13px;">
            📄 <a href="${esc(src)}" target="_blank" style="color:var(--text);text-decoration:none;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(name)}</a>
            <span class="file-remove-btn"
                  data-block-id="${esc(block.id)}"
                  data-url="${esc(src)}"
                  style="cursor:pointer;color:var(--s-accent);font-weight:bold;margin-left:8px;" title="Remove File">×</span>
        </div>`;
    }).join('');

    const btnText = fileList.length 
        ? (block.multiple ? '+ Add Another File' : 'Replace File') 
        : 'Upload File';

    return `
        <div class="field-group"${visibilityAttr} data-file-wrap="${esc(block.id)}">
            ${block.label 
                ? `<label style="display:flex; align-items:center; width:100%;">${esc(block.label)}${actionBtn}</label>` 
                : `<div style="display:flex; justify-content:flex-end; width:100%; margin-bottom:4px;">${actionBtn}</div>`}
            <div id="file-preview-${esc(block.id)}" style="display:flex;flex-wrap:wrap;${fileList.length ? 'margin-bottom:8px' : ''}">
                ${filesHTML}
            </div>
            <label for="${inputId}"
                   style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:var(--surface2);border:1px dashed var(--border);border-radius:6px;cursor:pointer;font-size:12px;color:var(--text);font-weight:700;transition:all 0.2s" onmouseover="this.style.borderColor='var(--s-accent)'; this.style.color='var(--s-accent)';" onmouseout="this.style.borderColor='var(--border)'; this.style.color='var(--text)';">
                📎 ${btnText}
            </label>
            <input type="file"
                   id="${inputId}"
                   class="file-upload-input"
                   data-block-id="${esc(block.id)}"
                   data-path="${esc(block.dataPath)}"
                   data-multiple="${block.multiple ? 'true' : 'false'}"
                   accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
                   ${block.multiple ? 'multiple' : ''}
                   style="display:none">
        </div>`;
}

// ── Image ─────────────────────────────────────────────────────────────────────
function renderImage(block, imData, visibilityAttr, actionBtn) {
    const raw     = getNestedValue(imData, block.dataPath);
    const urlList = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    const inputId = `img-input-${block.id}`;

    const previews = urlList.map(img => {
        const src = typeof img === 'object' ? img.url : img;
        const name = typeof img === 'object' ? img.name : '';
        
        return `
        <div style="position:relative;display:inline-block;margin-right:12px;margin-bottom:8px;text-align:center;">
            <img src="${esc(src)}"
                 style="max-width:${esc(block.maxWidth || '100%')};${block.maxHeight ? `max-height:${esc(block.maxHeight)};` : ''}border-radius:6px;border:1px solid var(--border);display:block">
            ${name ? `<div style="font-size:11px;margin-top:6px;opacity:0.8;font-weight:600;">${esc(name)}</div>` : ''}
            <span class="img-remove-btn"
                  data-block-id="${esc(block.id)}"
                  data-url="${esc(src)}"
                  style="position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.7);color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px;font-weight:bold;line-height:1;transition:background 0.2s;" onmouseover="this.style.background='var(--s-accent)'" onmouseout="this.style.background='rgba(0,0,0,0.7)'">×</span>
        </div>`;
    }).join('');

    const btnText = urlList.length 
        ? (block.multiple ? '+ Add Another Image' : 'Replace Image') 
        : 'Upload Image';

    return `
        <div class="field-group"${visibilityAttr} data-image-wrap="${esc(block.id)}">
            ${block.label 
                ? `<label style="display:flex; align-items:center; width:100%;">${esc(block.label)}${actionBtn}</label>` 
                : `<div style="display:flex; justify-content:flex-end; width:100%; margin-bottom:4px;">${actionBtn}</div>`}
            <div id="img-preview-${esc(block.id)}" style="display:flex;flex-wrap:wrap;gap:8px;${urlList.length ? 'margin-bottom:12px' : ''}">
                ${previews}
            </div>
            <label for="${inputId}"
                   style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:var(--surface2);border:1px dashed var(--border);border-radius:6px;cursor:pointer;font-size:12px;color:var(--text);font-weight:700;transition:all 0.2s" onmouseover="this.style.borderColor='var(--s-accent)'; this.style.color='var(--s-accent)';" onmouseout="this.style.borderColor='var(--border)'; this.style.color='var(--text)';">
                📎 ${btnText}
            </label>
            <input type="file"
                   id="${inputId}"
                   class="img-upload-input"
                   data-block-id="${esc(block.id)}"
                   data-path="${esc(block.dataPath)}"
                   data-multiple="${block.multiple ? 'true' : 'false'}"
                   accept="image/*"
                   ${block.multiple ? 'multiple' : ''}
                   style="display:none">
        </div>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(str) {
    return String(str ?? '')
        .replace(/&/g,  '&amp;')
        .replace(/"/g,  '&quot;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;');
}