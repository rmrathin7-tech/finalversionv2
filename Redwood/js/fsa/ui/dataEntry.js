// js/fsa/ui/dataEntry.js
import { formatValue, applyLiveIndianFormat, parseFormattedNumber, formatIN } from "../utils/formatters.js";
import { buildFinancialModel } from "../core/engine.js";
import { deleteField } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let renderTimeout;

export function initDataEntry({
    currentFsaData,
    reclassMap,
    updateDocRef,
    projectId,
    fsaId,
    db,
    updatePnLTotals,
    updateBSTotals,
    scheduleFieldSave,
    configSchemas
}) {
    let currentSchema = null;
    let currentDocKey = "pnl";

    // Utility for safe HTML IDs
    const safeId = str => btoa(encodeURIComponent(str)).replace(/[^a-zA-Z0-9]/g, '');

    // ── DYNAMIC TOTAL CALCULATOR ──────────────────────────────────────
    function getLocalTotal(key, year, typeStore) {
        const model = buildFinancialModel(currentFsaData.data, year, reclassMap, configSchemas);
        return model[key] ?? model[`${currentDocKey}__${key}`] ?? 0;
    }

    // ── SCHEMA-DRIVEN ANCHORED TOTALS ─────────────────────────────────
// ── SCHEMA-DRIVEN ANCHORED TOTALS ─────────────────────────────────
    function buildAnchoredTotals(schema) {
        const anchors = {};
        (schema?.structure || []).forEach(item => {
            if (item.type === 'section') {
                // Only anchor inline section totals, NOT standalone global totals
                anchors[item.key] = (Array.isArray(item.totals) ? item.totals : []).map(t => ({
                    title: t.title,
                    key:   t.key,
                    color: t.color || '#3b82f6',
                    bg:    t.bg    || 'rgba(59,130,246,0.05)'
                }));
            }
        });
        return anchors;
    }
    // ── SCHEMA PARSING UTILS (HIERARCHY SUPPORT) ───────────────────────
    const extractItemName = (obj) => {
        if (typeof obj === 'string') return obj;
        if (!obj) return null;
        return obj.label || obj.title || obj.name || obj.item || null;
    };

    const getChildren = (obj) => {
        if (!obj || typeof obj !== 'object') return [];
        return obj.subItems || obj.items || obj.children || [];
    };

    const isStructuralWrapper = (obj) => {
        if (!obj || typeof obj !== 'object') return false;
        const n = (obj.name || obj.type || obj.key || '').toLowerCase();
        return (n === 'fixed' || n === 'dynamic' || n === 'group') && (Array.isArray(obj.items) || Array.isArray(obj.subItems));
    };

    function parseSchemaForHierarchy(itemsList, dynamicEqTopLevel) {
        let topLevel = [];
        let subItemsMap = {}; // parentName -> [subItem1, subItem2]
        let parentOf = {};    // subItemName -> parentName

        if (dynamicEqTopLevel) {
            topLevel = [...dynamicEqTopLevel];
            topLevel.forEach(tl => subItemsMap[tl] = []);
            return { topLevel, subItemsMap, parentOf };
        }

        (itemsList || []).forEach(iObj => {
            if (isStructuralWrapper(iObj)) {
                getChildren(iObj).forEach(c => {
                    const cName = extractItemName(c);
                    if (cName) {
                        topLevel.push(cName);
                        subItemsMap[cName] = [];
                        getChildren(c).forEach(cc => {
                            const ccName = extractItemName(cc);
                            if (ccName) {
                                subItemsMap[cName].push(ccName);
                                parentOf[ccName] = cName;
                            }
                        });
                    }
                });
            } else {
                const iName = extractItemName(iObj);
                if (iName) {
                    topLevel.push(iName);
                    subItemsMap[iName] = [];
                    getChildren(iObj).forEach(c => {
                        const cName = extractItemName(c);
                        if (cName) {
                            subItemsMap[iName].push(cName);
                            parentOf[cName] = iName;
                        }
                    });
                }
            }
        });
        return { topLevel, subItemsMap, parentOf };
    }


    // ── SAFE RENDER (debounced) ───────────────────────────────────────
    function safeRender(schema, type) {
        currentSchema = schema;
        currentDocKey = type;
        clearTimeout(renderTimeout);
        renderTimeout = setTimeout(() => renderDataEntry(schema, type), 50);
    }

    // ── MAIN TABLE RENDERER ───────────────────────────────────────────
    function renderDataEntry(schema, type) {
        const container = document.getElementById("data-entry-area");
        if (!container) return;

        let years = currentFsaData.years || [];
        if (window.hiddenYears) years = years.filter(y => !window.hiddenYears.includes(y));

        const _sortOrder = window.deYearSortOrder || 'none';
        if (_sortOrder === 'asc') {
            years = [...years].sort((a, b) => (parseInt(a.replace(/\D/g, '')) || 0) - (parseInt(b.replace(/\D/g, '')) || 0));
        } else if (_sortOrder === 'desc') {
            years = [...years].sort((a, b) => (parseInt(b.replace(/\D/g, '')) || 0) - (parseInt(a.replace(/\D/g, '')) || 0));
        } else {
            years = [...years]; // keep original Firestore order
        }
        if (!years.length) {
            container.innerHTML = `
                <div style="text-align:center; padding:60px; color:var(--text-muted);
                            font-size:14px; font-weight:500;
                            border:1px dashed var(--border-color);
                            border-radius:12px; background:rgba(0,0,0,0.2);">
                    No years configured. Click "+ Add Year" to begin data entry.
                </div>`;
            return;
        }

        const data = currentFsaData.data || {};
        if (!data[type]) data[type] = {};
        const store = data[type];

        const anchors = buildAnchoredTotals(schema);
        const sectionParentMaps = {}; // Expose to listeners for cascading deletes

       let html = `
            <div class="ultimate-fsa-table-wrapper">
                <div style="overflow-x: auto; width: 100%;">
                <table class="ultimate-fsa-table" style="min-width: max-content; width: 100%;">
                    <thead>
                        <tr>
                            <th style="width:35%; min-width:250px;">Particulars</th>
                            ${years.map((y, idx) => `<th style="min-width:90px; padding:10px;" class="${idx === 0 ? 'ult-year-first' : 'ult-year-sep'}">${y}</th>`).join("")}
                        </tr>
                    </thead>
                    <tbody>`;
                    
        function renderTotalRow(title, key, textColor, bgColor) {
            let row = `<tr class="ult-row-total" style="background:${bgColor} !important;">
                <td style="color:${textColor} !important;">${title}</td>`;
            years.forEach((year, idx) => {
                const val = getLocalTotal(key, year, store);
                row += `<td class="ult-tot-val ${idx === 0 ? 'ult-year-first' : 'ult-year-sep'}">
                    <span style="color:#ffffff !important;"
                          data-total-key="${key}"
                          data-year="${year}">
                        ${formatValue(key, val, configSchemas)}
                    </span>
                </td>`;
            });
            row += `</tr>`;
            return row;
        }

        // ── RENDER LOOP ───────────────────────────────────────────────
        (schema?.structure || []).forEach(section => {

            if (section.type === "group") {
                html += `<tr class="ult-row-group">
                    <td colspan="${years.length + 1}">${section.title}</td>
                </tr>`;
                return;
            }

            if (section.type === "total") {
                html += renderTotalRow(
                    section.title,
                    section.key,
                    section.color || '#3b82f6',
                    section.bg    || 'rgba(59,130,246,0.05)'
                );
                return;
            }

            const key = section.key || section.title.toLowerCase().replace(/\s+/g, '');
            if (!store[key]) store[key] = {};
            years.forEach(year => { if (!store[key][year]) store[key][year] = {}; });

            html += `<tr class="ult-row-section">
                <td colspan="${years.length + 1}">${section.title}</td>
            </tr>`;

            // Setup Dynamic Equity Items (for any document type with a dynamic section)
            let dynamicEqTopLevel = null;
            if (section.dynamic) {
                const entityKey = currentFsaData.entityType || 'pvtLtd';
                const globalEq  = configSchemas.entityTypes?.[entityKey]?.equityItems;
                if (globalEq && globalEq.length > 0) {
                    dynamicEqTopLevel = globalEq.map(extractItemName).filter(Boolean);
                }
            }

            const { topLevel, subItemsMap, parentOf } = parseSchemaForHierarchy(section.items, dynamicEqTopLevel);
            sectionParentMaps[key] = parentOf;

            // 1. Group items present in Firestore
            const activeParents = new Set();
            const activeSubItems = {}; // parent -> [subKey1, subKey2]
            
            const itemsInStore = new Set();
            years.forEach(year => {
                Object.keys(store[key]?.[year] || {}).forEach(dataItem => itemsInStore.add(dataItem));
            });

            itemsInStore.forEach(dataKey => {
                let parent = parentOf[dataKey] || null;
                if (!parent && dataKey.includes("||")) {
                    parent = dataKey.split("||")[0];
                }

                if (parent) {
                    if (!activeSubItems[parent]) activeSubItems[parent] = [];
                    activeSubItems[parent].push(dataKey);
                    activeParents.add(parent); // Force parent active if sub exists
                } else {
                    activeParents.add(dataKey);
                }
            });

            // 2. Build ordered render list maintaining Hierarchy
            const orderedItemsToRender = [];
            const renderedParents = new Set();

            // Render Schema Top-Levels first
            topLevel.forEach(pName => {
                if (activeParents.has(pName)) {
                    orderedItemsToRender.push({ dataKey: pName, displayName: pName, isSub: false, parent: null });
                    renderedParents.add(pName);

                    const subs = activeSubItems[pName] || [];
                    const schemaSubs = subItemsMap[pName] || [];
                    
                    // Maintain schema order for known sub-items
                    schemaSubs.forEach(sName => {
                        if (subs.includes(sName)) {
                            orderedItemsToRender.push({ dataKey: sName, displayName: sName, isSub: true, parent: pName });
                        }
                    });
                    // Append custom sub-items
                    subs.forEach(sKey => {
                        if (!schemaSubs.includes(sKey)) {
                            const displayName = sKey.includes("||") ? sKey.split("||")[1] : sKey;
                            orderedItemsToRender.push({ dataKey: sKey, displayName: displayName, isSub: true, parent: pName });
                        }
                    });
                }
            });

            // Render Custom Top-Levels
            activeParents.forEach(pName => {
                if (!renderedParents.has(pName)) {
                    orderedItemsToRender.push({ dataKey: pName, displayName: pName, isSub: false, parent: null });
                    const subs = activeSubItems[pName] || [];
                    subs.forEach(sKey => {
                        const displayName = sKey.includes("||") ? sKey.split("||")[1] : sKey;
                        orderedItemsToRender.push({ dataKey: sKey, displayName: displayName, isSub: true, parent: pName });
                    });
                }
            });

            const renderedItemsTracker = new Set();

            function buildItemRow(dataKey, displayName, isSub, hasSubs = false) {
                renderedItemsTracker.add(dataKey);
                
                const subBtn = !isSub 
                    ? `<button class="ult-add-sub-trigger" data-parent="${safeId(dataKey)}" style="font-size:10px; margin-left:8px; padding:2px 6px; border-radius:4px; background:var(--bg-surface-hover); border:1px solid var(--border-subtle); color:var(--text-secondary); cursor:pointer;" title="Add sub-item">+ Sub</button>`
                    : '';

                let rowHtml = `<tr class="ult-row-item${isSub ? ' ult-sub' : ''}">
                    <td style="${isSub ? 'padding-left:2.5rem;' : ''}">
                        <span>${displayName}</span>
                        ${subBtn}
                        <button class="ult-del-btn"
                                data-delete="${type}__${key}__${dataKey}"
                                title="Delete Item">✕</button>
                    </td>`;
                years.forEach((year, idx) => {
                    const yearCls = idx === 0 ? 'ult-year-first' : 'ult-year-sep';
                    if (hasSubs) {
                        // Renders a disabled/empty state instead of an input box for parent items
                        rowHtml += `<td class="${yearCls}" style="text-align: center; vertical-align: middle; color: var(--text-muted); opacity: 0.5;">—</td>`;
                    } else {
                        const value = store[key][year]?.[dataKey] ?? 0;
                        const displayVal = value ? formatIN(value, 2) : '';
                        rowHtml += `<td class="${yearCls}">
                            <input type="text"
                                   inputmode="decimal"
                                   class="ult-input"
                                   value="${displayVal}"
                                   placeholder="0"
                                   data-type="${type}"
                                   data-key="${key}"
                                   data-item="${dataKey}"
                                   data-year="${year}"
                                   data-raw="${value || 0}">
                        </td>`;
                    }
                });
                rowHtml += `</tr>`;
                return rowHtml;
            }

            function buildAddSubRow(parentDataKey, parentDisplayName) {
                const schemaSubs = subItemsMap[parentDisplayName] || [];
                const activeSubs = activeSubItems[parentDisplayName] || [];
                const availableSchemaSubs = schemaSubs.filter(s => !activeSubs.includes(s));
                
                let optionsHtml = `<option value="" disabled selected>+ Add sub-item to ${parentDisplayName}...</option>`;
                availableSchemaSubs.forEach(s => {
                    optionsHtml += `<option value="${s.replace(/"/g, '&quot;')}">${s}</option>`;
                });
                optionsHtml += `<option value="__CUSTOM_SUB__" style="color:var(--status-danger,#ef4444); font-weight:700;">+ Create Custom Sub-Item...</option>`;

                return `<tr class="ult-row-add-sub" id="add-sub-row-${safeId(parentDataKey)}" style="display:none; background: rgba(0,0,0,0.15);">
                    <td colspan="${years.length + 1}" style="padding: 6px 16px 6px 40px !important;">
                        <select class="ult-sub-select" data-select-sub="${type}__${key}__${parentDataKey}" style="width:100%; max-width:300px; padding:4px; font-size:12px; background:var(--bg-input); border:1px dashed var(--border-subtle); color:var(--text-primary); border-radius:4px;">
                            ${optionsHtml}
                        </select>
                    </td>
                </tr>`;
            }

            // 3. Render HTML iteratively, injecting Add Sub rows
            orderedItemsToRender.forEach((itemObj, index) => {
                const hasSubs = !itemObj.isSub && activeSubItems[itemObj.dataKey] && activeSubItems[itemObj.dataKey].length > 0;
                html += buildItemRow(itemObj.dataKey, itemObj.displayName, itemObj.isSub, hasSubs);

                const nextItem = orderedItemsToRender[index + 1];
                if (!itemObj.isSub) {
                    if (!nextItem || !nextItem.isSub || nextItem.parent !== itemObj.dataKey) {
                        html += buildAddSubRow(itemObj.dataKey, itemObj.displayName);
                    }
                } else {
                    if (!nextItem || !nextItem.isSub || nextItem.parent !== itemObj.parent) {
                        html += buildAddSubRow(itemObj.parent, itemObj.parent); // parentDataKey is parent
                    }
                }
            });

            // 4. Section Bottom Dropdown (Top-Level Items Only)
            const availableTopLevel = topLevel.filter(tl => !activeParents.has(tl));

            html += `<tr>
                <td colspan="${years.length + 1}" style="padding:16px 16px 24px 24px !important;">
                    <select class="ult-add-select" data-select="${type}__${key}">
                        <option value="" disabled selected>+ Add Main Line Item...</option>
                        ${availableTopLevel.map(si => `<option value="${si.replace(/"/g, '&quot;')}">${si}</option>`).join("")}
                        <option value="__CUSTOM__"
                                style="color:var(--status-danger,#ef4444); font-weight:700;">
                            + Create Custom Main Item...
                        </option>
                    </select>
                </td>
            </tr>`;

            // 5. Inject anchored total rows after this section
            (anchors[key] || []).forEach(anchor => {
                html += renderTotalRow(anchor.title, anchor.key, anchor.color, anchor.bg);
            });
        });

        html += `</tbody></table></div></div>`;
        container.innerHTML = html;
        attachUniversalListeners(type, schema, sectionParentMaps);
    }

    // ── EVENT LISTENERS ───────────────────────────────────────────────
    function attachUniversalListeners(type, schema, sectionParentMaps) {

        // Open sub-item dropdown row
        document.querySelectorAll(".ult-add-sub-trigger").forEach(btn => {
            btn.addEventListener("click", () => {
                const parentId = btn.dataset.parent;
                const row = document.getElementById(`add-sub-row-${parentId}`);
                if (row) {
                    row.style.display = row.style.display === "none" ? "table-row" : "none";
                }
            });
        });

        // Select specific sub-item
        document.querySelectorAll(".ult-sub-select").forEach(select => {
            select.addEventListener("change", () => {
                const [t, key, parentDataKey] = select.dataset.selectSub.split("__");
                let item = select.value;
                if (!item) return;

                if (item === "__CUSTOM_SUB__") {
                    let customName = prompt(`Enter Custom Sub-Item for "${parentDataKey}":`);
                    if (!customName || !customName.trim()) { select.value = ""; return; }
                    customName = customName.trim();
                    item = `${parentDataKey}||${customName}`;
                }

                const data = currentFsaData.data;
                currentFsaData.years.forEach(year => {
                    if (!data[t])           data[t]          = {};
                    if (!data[t][key])      data[t][key]     = {};
                    if (!data[t][key][year]) data[t][key][year] = {};
                    if (data[t][key][year][item] === undefined) data[t][key][year][item] = 0; 

                    // Zero out the parent item's data to avoid double counting!
                    if (data[t][key][year][parentDataKey]) {
                        data[t][key][year][parentDataKey] = 0;
                        scheduleFieldSave(projectId, fsaId, `data.${t}.${key}.${year}.${parentDataKey}`, 0);
                    }
                });

                safeRender(currentSchema, currentDocKey);
            });
        });

        // Select main top-level item
        document.querySelectorAll(".ult-add-select").forEach(select => {
            select.addEventListener("change", () => {
                const [t, key] = select.dataset.select.split("__");
                let item = select.value;
                if (!item) return;

                if (item === "__CUSTOM__") {
                    item = prompt("Enter Custom Main Line Item Name:");
                    if (!item || !item.trim()) { select.value = ""; return; }
                    item = item.trim();
                }

                const data = currentFsaData.data;
                currentFsaData.years.forEach(year => {
                    if (!data[t])           data[t]          = {};
                    if (!data[t][key])      data[t][key]     = {};
                    if (!data[t][key][year]) data[t][key][year] = {};
                    if (data[t][key][year][item] === undefined) data[t][key][year][item] = 0; 
                });

                safeRender(currentSchema, currentDocKey);
            });
        });

        // Delete line item button
        document.querySelectorAll("[data-delete]").forEach(btn => {
            btn.addEventListener("click", () => {
                const [t, key, item] = btn.dataset.delete.split("__");
                
                const data = currentFsaData.data;
                const parentMap = sectionParentMaps[key] || {};
                
                // Identify if this item has children that also need deleting
                const childrenToDelete = [];
                currentFsaData.years.forEach(year => {
                    Object.keys(data[t]?.[key]?.[year] || {}).forEach(k => {
                        if (parentMap[k] === item || k.startsWith(item + "||")) {
                            if (!childrenToDelete.includes(k)) childrenToDelete.push(k);
                        }
                    });
                });

                if (childrenToDelete.length > 0) {
                    if (!confirm(`Permanently delete "${item}" AND its ${childrenToDelete.length} sub-items from all years?`)) return;
                } else {
                    if (!confirm(`Permanently delete "${item}" from all years?`)) return;
                }

                currentFsaData.years.forEach(year => {
                    if (data[t]?.[key]?.[year]) {
                        delete data[t][key][year][item];
                        scheduleFieldSave(projectId, fsaId, `data.${t}.${key}.${year}.${item}`, deleteField());
                        
                        // Cascade delete children
                        childrenToDelete.forEach(childKey => {
                            delete data[t][key][year][childKey];
                            scheduleFieldSave(projectId, fsaId, `data.${t}.${key}.${year}.${childKey}`, deleteField());
                        });
                    }
                });

                // Clean up empty objects
                currentFsaData.years.forEach(year => {
                    if (data[t]?.[key]?.[year] && Object.keys(data[t][key][year]).length === 0) {
                        delete data[t][key][year];
                    }
                });
                if (data[t]?.[key] && Object.keys(data[t][key]).length === 0) {
                    delete data[t][key];
                }

                safeRender(currentSchema, currentDocKey);
            });
        });

        // All numeric text inputs
        document.querySelectorAll("#data-entry-area input.ult-input").forEach(input => {

            input.addEventListener("focus", () => {
                // Show raw number for easy editing
                const raw = input.dataset.raw || '0';
                input.value = parseFloat(raw) === 0 ? '' : raw;
                input.select();
            });

            input.addEventListener("input", () => {
                // Apply live Indian comma formatting and get clean value
                const value = applyLiveIndianFormat(input);

                const key   = input.dataset.key;
                const item  = input.dataset.item;
                const year  = input.dataset.year;
                const data  = currentFsaData.data;

                input.dataset.raw = String(value);

                // Skip if unchanged
                if (data[type]?.[key]?.[year]?.[item] === value) return;

                if (!data[type])           data[type]          = {};
                if (!data[type][key])      data[type][key]     = {};
                if (!data[type][key][year]) data[type][key][year] = {};
                data[type][key][year][item] = value;

                // Calculate the updated model once per keystroke
                const updatedModel = buildFinancialModel(data, year, reclassMap, configSchemas);

                const allTotalKeys = [
                    ...new Set([
                        ...(configSchemas.metricsFormulas || []).map(m => m.key),
                        ...(currentSchema?.structure || [])
                            .filter(s => s.type === 'total' && s.key)
                            .map(s => s.key),
                        ...(currentSchema?.structure || [])
                            .filter(s => s.type === 'section')
                            .flatMap(s => (Array.isArray(s.totals) ? s.totals : []).map(t => t.key).filter(Boolean)),
                        'grossProfit', 'ebitda', 'ebt', 'eat',
                        'totalAssets', 'totalLE',
                        'netCashFromOperations', 'netCashFromInvesting',
                        'netCashFromFinancing',  'netChangeInCash'
                    ])
                ];

                allTotalKeys.forEach(totKey => {
                    const val = updatedModel[totKey] ?? updatedModel[`${type}__${totKey}`] ?? 0;
                    const el  = document.querySelector(`[data-total-key="${totKey}"][data-year="${year}"]`);
                    if (el) el.innerText = formatValue(totKey, val, configSchemas);
                });

                if (type === "pnl" && typeof updatePnLTotals === 'function') updatePnLTotals();
                if (type === "bs"  && typeof updateBSTotals  === 'function') updateBSTotals();

                const crossLinks = (configSchemas.crossDocLinks || []).filter(l => l.fromDoc === type && l.fromSection === key);

                crossLinks.forEach(link => {
                    const allData = currentFsaData.data;
                    if (!allData[link.toDoc])                      allData[link.toDoc]                      = {};
                    if (!allData[link.toDoc][link.toSection])      allData[link.toDoc][link.toSection]      = {};
                    if (!allData[link.toDoc][link.toSection][year]) allData[link.toDoc][link.toSection][year] = {};

                    const targetItem = link.toItem || item;
                    const existingManual = allData[link.toDoc][link.toSection][year][targetItem];
                    if (existingManual !== undefined && existingManual !== 0) return;

                    allData[link.toDoc][link.toSection][year][targetItem] = value;
                    scheduleFieldSave(projectId, fsaId, `data.${link.toDoc}.${link.toSection}.${year}.${targetItem}`, value);

                    const cfTotalEl = document.querySelector(`[data-total-key="${link.toSection}"][data-year="${year}"]`);
                    if (cfTotalEl) {
                        cfTotalEl.innerText = formatValue(link.toSection, getLocalTotal(link.toSection, year, allData[link.toDoc]), configSchemas);
                    }
                });

                scheduleFieldSave(projectId, fsaId, `data.${type}.${key}.${year}.${item}`, value);
            });

            input.addEventListener("blur", () => {
                const raw = parseFormattedNumber(input.value);
                input.dataset.raw = String(raw);
                input.value = raw !== 0 ? formatIN(raw, 2) : '';
            });
        });
    }

    return { safeRender, getLocalTotal };
}
