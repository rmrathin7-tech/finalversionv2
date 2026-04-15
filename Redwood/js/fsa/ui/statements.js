// js/fsa/ui/statements.js
import { buildFinancialModel } from "../core/engine.js";
import { formatValue } from "../utils/formatters.js";

export function initStatements({
    currentFsaData,
    reclassMap,
    configSchemas // 🌟 Uses global config
}) {

    // ── SCHEMA RESOLUTION (Matches Engine & Data Entry) ──────────────────
    const pnlDocDef = configSchemas?.documents?.find(d => d.key === 'pnl');
    const bsDocDef  = configSchemas?.documents?.find(d => d.key === 'bs');

    const pnlStructure = configSchemas?.chartOfAccounts?.['shared']?.[pnlDocDef?.id] 
                      || configSchemas?.chartOfAccounts?.['shared']?.['pnl']
                      || pnlDocDef?.structure 
                      || configSchemas?.pnlSchema?.structure 
                      || [];

    const bsStructure = configSchemas?.chartOfAccounts?.['shared']?.[bsDocDef?.id] 
                     || configSchemas?.chartOfAccounts?.['shared']?.['bs']
                     || bsDocDef?.structure 
                     || configSchemas?.bsSchema?.structure 
                     || [];

    // ── SCHEMA PARSING UTILS (Matches Data Entry Hierarchy) ──────────────
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
        let subItemsMap = {}; 
        let parentOf = {};    

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

    // ── CORE RENDERERS ───────────────────────────────────────────────────
    function renderStatements(canvas) {
        const years = currentFsaData.years || [];

        canvas.innerHTML = `
            <div class="fsa-card">
                <h2>Statements</h2>
                <button id="full-view-btn" class="fsa-btn">Full</button>
                <button id="summary-view-btn" class="fsa-btn">Summary</button>
                <div id="statement-area" style="margin-top:20px;"></div>
            </div>
        `;

        document.getElementById("full-view-btn").onclick = () => renderFullStatements(years);
        document.getElementById("summary-view-btn").onclick = () => renderSummaryStatements(years);
    }

    // Helper to generate a unified table structure for both P&L and BS
    function buildStatementTableHTML(title, structure, docKey, dataStore, years) {
        let html = `
            <div class="statement-block">
            <h3>${title}</h3>
            <table class="statement-table">
            <tr>
                <th style="width:40%;">Particulars</th>
                ${years.map(y=>`<th>${y}</th>`).join("")}
            </tr>
        `;

        (structure || []).forEach(item => {
            if (item.type === "group") {
                html += `<tr class="statement-group" style="background: rgba(255,255,255,0.02);"><td colspan="${years.length+1}"><strong>${item.title}</strong></td></tr>`;
                return;
            }

            if (item.type === "total") {
                html += `<tr class="statement-total"><td>${item.title}</td>`;
                years.forEach(year => {
                    const model = buildFinancialModel(currentFsaData.data, year, reclassMap, configSchemas);
                    html += `<td>${formatValue(item.key, model[item.key], configSchemas)}</td>`;
                });
                html += `</tr>`;
                return;
            }

            if (item.type === "section") {
                const key = item.key || item.title.toLowerCase().replace(/\s+/g, '');
                
                // Render Section Header with calculated totals
                html += `<tr class="statement-section" style="background: rgba(255,255,255,0.02);">
                    <td><strong>${item.title}</strong></td>`;
                years.forEach(year => {
                    const model = buildFinancialModel(currentFsaData.data, year, reclassMap, configSchemas);
                    const val = model[key] ?? model[`${docKey}__${key}`] ?? 0;
                    html += `<td><strong>${val !== 0 ? formatValue(key, val, configSchemas) : "—"}</strong></td>`;
                });
                html += `</tr>`;

                // Setup dynamic BS equity tracking
                let dynamicEqTopLevel = null;
                if (item.dynamic && docKey === "bs") {
                    const entityKey = currentFsaData.entityType || 'pvtLtd';
                    const globalEq  = configSchemas.entityTypes?.[entityKey]?.equityItems;
                    if (globalEq && globalEq.length > 0) {
                        dynamicEqTopLevel = globalEq.map(extractItemName).filter(Boolean);
                    }
                }

                const { topLevel, subItemsMap, parentOf } = parseSchemaForHierarchy(item.items, dynamicEqTopLevel);

                // Collect only active items in store
                const activeParents = new Set();
                const activeSubItems = {}; 
                const itemsInStore = new Set();
                
                years.forEach(year => {
                    Object.keys(dataStore[key]?.[year] || {}).forEach(dataItem => itemsInStore.add(dataItem));
                });

                itemsInStore.forEach(dataKey => {
                    let parent = parentOf[dataKey] || null;
                    if (!parent && dataKey.includes("||")) parent = dataKey.split("||")[0];

                    if (parent) {
                        if (!activeSubItems[parent]) activeSubItems[parent] = [];
                        activeSubItems[parent].push(dataKey);
                        activeParents.add(parent); // Auto-add parent if sub exists
                    } else {
                        activeParents.add(dataKey);
                    }
                });

                const orderedItemsToRender = [];
                const renderedParents = new Set();

                // Organize hierarchical order
                topLevel.forEach(pName => {
                    if (activeParents.has(pName)) {
                        orderedItemsToRender.push({ dataKey: pName, displayName: pName, isSub: false });
                        renderedParents.add(pName);

                        const subs = activeSubItems[pName] || [];
                        const schemaSubs = subItemsMap[pName] || [];
                        
                        schemaSubs.forEach(sName => {
                            if (subs.includes(sName)) orderedItemsToRender.push({ dataKey: sName, displayName: sName, isSub: true });
                        });
                        subs.forEach(sKey => {
                            if (!schemaSubs.includes(sKey)) {
                                const displayName = sKey.includes("||") ? sKey.split("||")[1] : sKey;
                                orderedItemsToRender.push({ dataKey: sKey, displayName: displayName, isSub: true });
                            }
                        });
                    }
                });

                activeParents.forEach(pName => {
                    if (!renderedParents.has(pName)) {
                        orderedItemsToRender.push({ dataKey: pName, displayName: pName, isSub: false });
                        const subs = activeSubItems[pName] || [];
                        subs.forEach(sKey => {
                            const displayName = sKey.includes("||") ? sKey.split("||")[1] : sKey;
                            orderedItemsToRender.push({ dataKey: sKey, displayName: displayName, isSub: true });
                        });
                    }
                });

                // Render items visually respecting hierarchy and calculating parent sums
                orderedItemsToRender.forEach(info => {
                    const hasSubs = !info.isSub && activeSubItems[info.dataKey] && activeSubItems[info.dataKey].length > 0;
                    
                    const prefix = info.isSub ? '<span style="opacity:0.5; margin-right:6px;">↳</span>' : '';
                    const displayName = hasSubs ? `<strong>${info.displayName}</strong>` : info.displayName;
                    const paddingStyle = info.isSub 
                        ? 'padding-left: 2.5rem; color: var(--text-secondary); font-size: 0.95em;' 
                        : 'padding-left: 1rem;';
                    
                    html += `<tr>
                        <td class="line-item" style="${paddingStyle}">${prefix}${displayName}</td>`;
                    
                    years.forEach(year => {
                        let val = 0;
                        if (hasSubs) {
                            // Sum up the children automatically for the parent row
                            const subs = activeSubItems[info.dataKey] || [];
                            val = subs.reduce((acc, subKey) => acc + (dataStore[key]?.[year]?.[subKey] || 0), 0);
                        } else {
                            // Normal line item data
                            val = dataStore[key]?.[year]?.[info.dataKey] || 0;
                        }

                        const displayVal = val !== 0 ? val.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '-';

                        if (hasSubs) {
                            html += `<td><strong>${displayVal}</strong></td>`;
                        } else {
                            html += `<td>${displayVal}</td>`;
                        }
                    });
                    html += `</tr>`;
                });

                // Render Inline Totals
                if (Array.isArray(item.totals)) {
                    item.totals.forEach(inlineTotal => {
                        html += `<tr class="statement-total" style="font-size: 0.9em; opacity: 0.9;">
                            <td style="padding-left: 1rem;">↳ ${inlineTotal.title}</td>`;
                        years.forEach(year => {
                            const model = buildFinancialModel(currentFsaData.data, year, reclassMap, configSchemas);
                            html += `<td>${formatValue(inlineTotal.key, model[inlineTotal.key], configSchemas)}</td>`;
                        });
                        html += `</tr>`;
                    });
                }
            }
        });

        html += `</table></div>`;
        return html;
    }

    function renderFullStatements(years) {
        const area = document.getElementById("statement-area");
        const data = currentFsaData.data || {};
        const pnlStore = data.pnl || {};
        const bsStore = data.bs || {};

        let html = "";
        html += buildStatementTableHTML("Profit & Loss", pnlStructure, "pnl", pnlStore, years);
        html += `<div style="margin-top:24px;"></div>`;
        html += buildStatementTableHTML("Balance Sheet", bsStructure, "bs", bsStore, years);

        area.innerHTML = `<div style="overflow-x:auto;">${html}</div>`;
    }

    function renderSummaryStatements(years) {
        const area = document.getElementById("statement-area");

        let html = `
            <div class="statement-block">
            <h3>Summary — Profit & Loss</h3>
            <table class="statement-table">
            <tr>
                <th>Metric</th>
                ${years.map(y => `<th>${y}</th>`).join("")}
            </tr>
        `;

        (pnlStructure || []).forEach(item => {
            if (item.type === "section" || item.type === "total") {
                const isTotal = item.type === "total";
                html += `<tr class="${isTotal ? "statement-total" : ""}"><td>${item.title}</td>`;
                years.forEach(year => {
                    const model = buildFinancialModel(currentFsaData.data, year, reclassMap, configSchemas);
                    const val = model[item.key];
                    html += `<td>${val != null ? formatValue(item.key, val, configSchemas) : "—"}</td>`;
                });
                html += `</tr>`;
                
                if (item.type === "section" && Array.isArray(item.totals)) {
                     item.totals.forEach(inlineTotal => {
                        html += `<tr class="statement-total" style="font-size: 0.9em; opacity: 0.9;"><td>&nbsp;&nbsp;↳ ${inlineTotal.title}</td>`;
                        years.forEach(year => {
                            const model = buildFinancialModel(currentFsaData.data, year, reclassMap, configSchemas);
                            const val = model[inlineTotal.key];
                            html += `<td>${val != null ? formatValue(inlineTotal.key, val, configSchemas) : "—"}</td>`;
                        });
                        html += `</tr>`;
                    });
                }
            }
        });

        html += `</table></div>`;

        html += `
            <div class="statement-block" style="margin-top:22px">
            <h3>Summary — Balance Sheet</h3>
            <table class="statement-table">
            <tr>
                <th>Metric</th>
                ${years.map(y => `<th>${y}</th>`).join("")}
            </tr>
        `;

        (bsStructure || []).forEach(item => {
            if (item.type === "section" || item.type === "total") {
                const isTotal = item.type === "total";
                html += `<tr class="${isTotal ? "statement-total" : ""}"><td>${item.title}</td>`;
                years.forEach(year => {
                    const model = buildFinancialModel(currentFsaData.data, year, reclassMap, configSchemas);
                    const val = model[item.key];
                    html += `<td>${val != null ? formatValue(item.key, val, configSchemas) : "—"}</td>`;
                });
                html += `</tr>`;

                if (item.type === "section" && Array.isArray(item.totals)) {
                     item.totals.forEach(inlineTotal => {
                        html += `<tr class="statement-total" style="font-size: 0.9em; opacity: 0.9;"><td>&nbsp;&nbsp;↳ ${inlineTotal.title}</td>`;
                        years.forEach(year => {
                            const model = buildFinancialModel(currentFsaData.data, year, reclassMap, configSchemas);
                            const val = model[inlineTotal.key];
                            html += `<td>${val != null ? formatValue(inlineTotal.key, val, configSchemas) : "—"}</td>`;
                        });
                        html += `</tr>`;
                    });
                }
            }
        });

        html += `</table></div>`;
        area.innerHTML = `<div style="overflow-x:auto;">${html}</div>`;
    }

    return { renderStatements };
}