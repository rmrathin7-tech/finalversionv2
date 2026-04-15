// fsa/core/engine.js

/* =========================
   FORMULA ENGINE
   Evaluates string-based formula expressions
========================= */
export function evaluateFormula(formula, map) {
    try {
        if (!formula) return 0;
        // Fix typographic dashes to standard minus sign to prevent syntax errors
        let safeFormula = formula.replace(/[−–—]/g, '-');
        
        // Sort keys by length descending so longer keys (like those with ||) match first.
        // This prevents partial replacements of substrings.
        const sortedKeys = Object.keys(map).sort((a, b) => b.length - a.length);

        sortedKeys.forEach(key => {
            // Escape special characters in the key for regex (crucial for || and spaces)
            const escapedKey = key.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            // Use a global regex to replace the exact key. 
            // We do NOT use \b (word boundaries) because pipes/spaces break them.
            const regex = new RegExp(escapedKey, 'g');
            // Replace with the mapped value wrapped in parentheses to safely handle negative numbers
            safeFormula = safeFormula.replace(regex, `(${map[key] || 0})`);
        });

        // Clean up any remaining unmapped alphabetical strings to prevent runtime eval errors
        safeFormula = safeFormula.replace(/[a-zA-Z_]\w*/g, '0');

        // eslint-disable-next-line no-new-func
        return new Function(`return ${safeFormula}`)();
    } catch (e) {
        console.warn("Formula evaluation error:", formula, e);
        return 0;
    }
}

/* =========================
   RECLASSIFICATION
   Works for ANY doc type, not just pnl/bs
========================= */
export function applyReclassifications(data, year, type, reclassMap) {
    const map = reclassMap?.[type] || {};

    Object.keys(map).forEach(fromSection => {
        const items = map[fromSection];
        Object.keys(items).forEach(item => {
            const toSection = items[item];
            const value = data[fromSection]?.[year]?.[item] || 0;
            if (!value) return;

            if (!data[toSection])        data[toSection]       = {};
            if (!data[toSection][year])  data[toSection][year] = {};
            if (!data[fromSection][year]) return;

            data[toSection][year][item]  = (data[toSection][year][item] || 0) + value;
            data[fromSection][year][item] = 0;
        });
    });

    return data;
}

/* =========================
   SUM HELPER
   Totals all line items in a section for a year
========================= */
function sumSection(docData, sectionKey, year) {
    return Object.values(docData[sectionKey]?.[year] || {})
        .reduce((a, b) => a + Number(b || 0), 0);
}

/* =========================
   MAIN MODEL BUILDER
========================= */
export function buildFinancialModel(data, year, reclassMap, configSchemas) {
    if (!configSchemas) return {};

    const {
        documents       = [],
        chartOfAccounts = {},
        pnlSchema,            
        bsSchema,             
        metricsFormulas = [],
        customRatios    = [],
        crossDocLinks   = []
    } = configSchemas;

    // ── 1. Clone ALL document stores (not just pnl + bs) ─────────────
    const clonedData = {};
    const allDocKeys = new Set([
        ...documents.map(d => d.key),
        ...Object.keys(data || {})
    ]);

    allDocKeys.forEach(docKey => {
        clonedData[docKey] = JSON.parse(JSON.stringify(data?.[docKey] || {}));
    });

    // ── 2. Apply reclassifications per document ───────────────────────
    allDocKeys.forEach(docKey => {
        clonedData[docKey] = applyReclassifications(
            clonedData[docKey], year, docKey, reclassMap
        );
    });

    const model = {};

    // ── NEW: Link the Document definitions to their actual structures ──
    const allDocDefs = documents.map(doc => {
        const structure = chartOfAccounts?.['shared']?.[doc.id] 
                       || chartOfAccounts?.['shared']?.[doc.key] 
                       || doc.structure 
                       || [];
        return {
            key: doc.key,
            structure: structure
        };
    });

    const processedKeys = new Set(allDocDefs.map(d => d.key));
    if (pnlSchema && !processedKeys.has('pnl')) {
        allDocDefs.push({ key: 'pnl', structure: pnlSchema.structure || [] });
    }
    if (bsSchema && !processedKeys.has('bs')) {
        allDocDefs.push({ key: 'bs', structure: bsSchema.structure || [] });
    }

    // ── 3. Base section sums & Sub-row injection ──────────────────────
    allDocDefs.forEach(docDef => {
        const docData = clonedData[docDef.key] || {};
        (docDef.structure || []).forEach(item => {
            if (item.type === 'section' && item.key) {
                const nsKey = `${docDef.key}__${item.key}`;
                model[nsKey] = sumSection(docData, item.key, year);

                if (model[item.key] === undefined) {
                    model[item.key] = model[nsKey];
                }

                // Inject individual line items into the model so formulas can see them
                const sectionData = docData[item.key]?.[year] || {};
                Object.entries(sectionData).forEach(([lineKey, lineValue]) => {
                    const val = Number(lineValue || 0);
                    model[`${docDef.key}__${lineKey}`] = val;
                    if (model[lineKey] === undefined) {
                        model[lineKey] = val;
                    }
                });
            }
        });
    });

    // ── 4. Cross-doc links ────────────────────────────────────────────
    crossDocLinks.forEach(link => {
        const sourceVal = model[`${link.fromDoc}__${link.fromSection}`]
                       ?? model[link.fromSection]
                       ?? 0;
        const targetKey = link.toItem || link.toSection;

        if (!clonedData[link.toDoc]) clonedData[link.toDoc] = {};
        if (!clonedData[link.toDoc][link.toSection]) clonedData[link.toDoc][link.toSection] = {};
        if (!clonedData[link.toDoc][link.toSection][year]) clonedData[link.toDoc][link.toSection][year] = {};

        const existing = clonedData[link.toDoc][link.toSection][year][targetKey];
        if (existing === undefined || existing === 0) {
            clonedData[link.toDoc][link.toSection][year][targetKey] = sourceVal;
            model[`${link.toDoc}__${link.toSection}`] = sumSection(
                clonedData[link.toDoc], link.toSection, year
            );
            if (model[link.toSection] === undefined) {
                model[link.toSection] = model[`${link.toDoc}__${link.toSection}`];
            }
        }
    });

    // ── 5. Schema-defined totals ──────────────────────────────────────
    allDocDefs.forEach(docDef => {
        (docDef.structure || []).forEach(item => {
            if (item.type === 'section') {
                (Array.isArray(item.totals) ? item.totals : []).forEach(inlineTotal => {
                    if (!inlineTotal.key || !inlineTotal.formula) return;
                    let totalVal = 0;
                    if (typeof inlineTotal.formula === 'string') {
                        totalVal = evaluateFormula(inlineTotal.formula, { ...model });
                    }
                    model[inlineTotal.key] = totalVal;
                    model[`${docDef.key}__${inlineTotal.key}`] = totalVal;
                });
            }

            if (item.type !== 'total' || !item.key || !item.formula) return;

            let totalVal = 0;

            if (Array.isArray(item.formula)) {
                totalVal = item.formula.reduce((acc, part) => {
                    const targetDoc = part.doc || docDef.key;
                    const nsKey = `${targetDoc}__${part.section}`;
                    const sectionVal = model[nsKey] ?? model[part.section] ?? 0;
                    return acc + sectionVal * (part.sign ?? 1);
                }, 0);
            } else if (typeof item.formula === 'string') {
                totalVal = evaluateFormula(item.formula, { ...model });
            }

            model[item.key] = totalVal;
            model[`${docDef.key}__${item.key}`] = totalVal;
        });
    });

    // ── 6. Derived metrics from engineConfig ──────────────────────────
    metricsFormulas.forEach(def => {
        if (!def.key) return;

        if (Array.isArray(def.formula)) {
            model[def.key] = def.formula.reduce((total, part) => {
                const nsKey  = part.doc ? `${part.doc}__${part.section}` : part.section;
                const val    = model[nsKey] ?? model[part.section] ?? 0;
                return total + val * (part.sign ?? 1);
            }, 0);
        } else if (typeof def.formula === 'string') {
            model[def.key] = evaluateFormula(def.formula, model);
        }

        if (def.isPercentage) model[def.key] *= 100;
    });

    // ── 7. Key alignment ──────────────────────────────────────────────
    if (model['gross_profit'] !== undefined) model.grossProfit = model['gross_profit'];
    if (model['net_profit']   !== undefined) model.eat         = model['net_profit'];

    // ── 8. Core accounting fallbacks ──────────────────────────────────
    if (model.grossProfit === undefined)
        model.grossProfit = (model.revenue || 0) - (model.directExpenses || model.directCosts || 0);

    if (model.ebitda === undefined)
        model.ebitda = (model.grossProfit || 0)
                     - (model.empbenefitexp || model.employeeCosts || 0)
                     - (model.otherindirectexpenses || model.otherIndirectCosts || 0);

    if (model.ebt === undefined)
        model.ebt = (model.ebitda || 0)
                  - (model.financeCosts || 0)
                  - (model.depreciationandammortization || model.depreciation || 0);

    if (model.eat === undefined)
        model.eat = (model.ebt || 0) - (model.tax || 0);

    if (model.totalAssets === undefined)
        model.totalAssets = (model.nonCurrentAssets || 0) + (model.currentAssets || 0);

    if (model.totalLE === undefined)
        model.totalLE = (model.nonCurrentLiabilities || 0)
                      + (model.currentliablities || model.currentLiabilities || 0)
                      + (model.equity                 || 0);

    // Cash flow fallbacks
    if (model.netCashFromOperations === undefined)
        model.netCashFromOperations =
            model['cashflow__operatingActivities'] ?? model.operatingActivities ?? 0;

    if (model.netCashFromInvesting === undefined)
        model.netCashFromInvesting =
            model['cashflow__investingActivities'] ?? model.investingActivities ?? 0;

    if (model.netCashFromFinancing === undefined)
        model.netCashFromFinancing =
            model['cashflow__financingActivities'] ?? model.financingActivities ?? 0;

    if (model.netChangeInCash === undefined)
        model.netChangeInCash = (model.netCashFromOperations || 0)
                              + (model.netCashFromInvesting  || 0)
                              + (model.netCashFromFinancing  || 0);

    // ── 9. Custom ratios ──────────────────────────────────────────────
    customRatios.forEach(ratio => {
        const sum = arr => (arr || []).reduce((s, k) => s + (model[k] || 0), 0);
        const num = sum(ratio.numerator);
        const den = sum(ratio.denominator);
        let val = den !== 0 ? num / den : 0;
        model[`cr__${ratio.key}`] = ratio.isPercentage ? val * 100 : val;
    });

    return model;
}
