import { buildFinancialModel } from "../core/engine.js";
import { formatValue } from "../utils/formatters.js";
import { doc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "../../firebase.js";

let analysisChart = null;

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

    const engineConfig = configSchemas || {
        pnlSchema: pnlSchema,
        bsSchema: balanceSheetSchema,
        customRatios: customRatios
    };

    function getSource(sectionKey) {
        if ((pnlSchema?.structure || []).find(s => s.key === sectionKey)) return 'pnl';
        if ((balanceSheetSchema?.structure || []).find(s => s.key === sectionKey)) return 'bs';
        return null;
    }

    function computeCustomRatioValue(ratioKey, year) {
        const ratio = customRatios.find(r => r.key === ratioKey);
        if (!ratio) return 0;
        const model = buildFinancialModel(currentFsaData.data, year, reclassMap, engineConfig);
        const sum = arr => (arr || []).reduce((s, k) => s + (model[k] || 0), 0);
        const den = sum(ratio.denominator);
        return den !== 0 ? sum(ratio.numerator) / den : 0;
    }

    function isCustomRatioPercentage(ratioKey) {
        return customRatios.find(r => r.key === ratioKey)?.isPercentage || false;
    }

    function initializeAnalysisWorkbench() {
        const reclassTrayBtn = document.getElementById('reclass-toggle-btn');
        const reclassTray = document.getElementById('reclass-tray');
        if (reclassTrayBtn && reclassTray) {
            reclassTrayBtn.addEventListener('click', () => {
                reclassTray.classList.toggle('open');
                reclassTrayBtn.classList.toggle('active');
            });
        }

        buildMetricSelector("metric-selector");
        buildMetricSelector("metric-selector-b");
        buildYearSelector();

        const modeSelect = document.getElementById("analysis-mode");
        const setModeSelect = document.getElementById("analysis-set-mode");

        modeSelect.addEventListener("change", updateChartTypeOptions);
        setModeSelect.addEventListener("change", updateChartTypeOptions);
        updateChartTypeOptions();

        setModeSelect.addEventListener("change", e => {
            const isCompare = e.target.value === "compare";
            document.getElementById("set-b-container").style.display = isCompare ? "block" : "none";
        });

        document.getElementById("run-analysis-btn").addEventListener("click", runAnalysis);
        document.getElementById("reclass-table-btn")?.addEventListener("click", renderReclassifiedTable);
        document.getElementById("reset-analysis-btn")?.addEventListener("click", resetAnalysis);

        const saveBtn = document.getElementById("save-analysis-btn");
        saveBtn.replaceWith(saveBtn.cloneNode(true));
        document.getElementById("save-analysis-btn").addEventListener("click", async () => {
            const name = prompt("Enter analysis name");
            if (!name) return;

            const payload = {
                name,
                createdAt: new Date().toISOString(),
                config: {
                    metricsA: getSelectedMetrics(),
                    metricsB: Array.from(document.querySelectorAll("#metric-selector-b input:checked")).map(i => i.value),
                    years: getSelectedYears(),
                    mode: document.getElementById("analysis-mode").value,
                    chart: document.getElementById("analysis-chart-type").value,
                    setMode: document.getElementById("analysis-set-mode").value
                },
                reclassMap: JSON.parse(JSON.stringify(reclassMap)),
                context: document.getElementById("analysis-context").value
            };

            if (!currentFsaData.savedAnalyses) currentFsaData.savedAnalyses = [];
            currentFsaData.savedAnalyses.push(payload);

            await updateDocRef(doc(db, "projects", projectId, "fsa", fsaId), { savedAnalyses: currentFsaData.savedAnalyses });
            alert("Saved successfully");
            renderSavedAnalysesLocal();
        });

        window.loadSavedAnalysis = (index) => {
            const saved = currentFsaData.savedAnalyses[index];
            if (!saved) return;

            document.querySelectorAll("#metric-selector input, #metric-selector-b input, #analysis-year-selector input").forEach(cb => cb.checked = false);

            (saved.config.metricsA || []).forEach(k => {
                const cb = document.querySelector(`#metric-selector input[value="${k}"]`);
                if (cb) cb.checked = true;
            });

            (saved.config.metricsB || []).forEach(k => {
                const cb = document.querySelector(`#metric-selector-b input[value="${k}"]`);
                if (cb) cb.checked = true;
            });

            (saved.config.years || []).forEach(y => {
                const cb = document.querySelector(`#analysis-year-selector input[value="${y}"]`);
                if (cb) cb.checked = true;
            });

            if (saved.config.mode) document.getElementById("analysis-mode").value = saved.config.mode;
            if (saved.config.setMode) document.getElementById("analysis-set-mode").value = saved.config.setMode;

            document.getElementById("analysis-mode").dispatchEvent(new Event("change"));
            document.getElementById("analysis-set-mode").dispatchEvent(new Event("change"));

            if (saved.config.chart) document.getElementById("analysis-chart-type").value = saved.config.chart;
            if (saved.context !== undefined) document.getElementById("analysis-context").value = saved.context;

            runAnalysis();
        };

        window.deleteSavedAnalysis = async (index) => {
            if (!confirm("Delete this saved analysis?")) return;
            currentFsaData.savedAnalyses.splice(index, 1);
            await updateDocRef(doc(db, "projects", projectId, "fsa", fsaId), { savedAnalyses: currentFsaData.savedAnalyses });
            renderSavedAnalysesLocal();
        };

        initializeReclassification();
        renderSavedAnalysesLocal();
    }

    function resetAnalysis() {
        document.querySelectorAll("#metric-selector input, #metric-selector-b input, #analysis-year-selector input").forEach(cb => cb.checked = false);

        document.getElementById("analysis-mode").value = "raw";
        document.getElementById("analysis-set-mode").value = "single";
        updateChartTypeOptions();

        document.getElementById("set-b-container").style.display = "none";

        if (analysisChart) {
            analysisChart.destroy();
            analysisChart = null;
        }

        const area = document.getElementById("analysis-table");
        if (area) {
            area.innerHTML = "<p class='aw-empty'>Select metrics + years in the sidebar, then click Run Analysis.</p>";
        }

        const ctxBox = document.getElementById("analysis-context");
        if (ctxBox) ctxBox.value = "";
    }

    function renderSavedAnalysesLocal() {
        const container = document.getElementById("saved-analyses");
        if (!container) return;
        const list = currentFsaData.savedAnalyses || [];

        if (list.length === 0) {
            container.innerHTML = `<div style="opacity:0.5; font-size:12px; font-style:italic; padding:4px 0;">No saved analyses yet.</div>`;
            return;
        }

        container.innerHTML = list.map((a, i) => `
            <div style="position:relative; padding-right:24px;">
                <div onclick="window.loadSavedAnalysis(${i})">
                    <strong>${a.name}</strong>
                    <span style="display:block; opacity:0.6; font-size:9px;">${(a.config.metricsA?.length ?? 0)} metrics, ${(a.config.years?.length ?? 0)} yrs</span>
                </div>
                <button onclick="event.stopPropagation(); window.deleteSavedAnalysis(${i})" style="position:absolute; right:6px; top:50%; transform:translateY(-50%); background:none; border:none; color:var(--fsa-negative); cursor:pointer; font-size:14px; opacity:0.7;">✕</button>
            </div>
        `).join('');
    }

    function runAnalysis() {
        const setMode = document.getElementById("analysis-set-mode").value;
        const mode = document.getElementById("analysis-mode").value;
        const selectedKeysA = Array.from(document.querySelectorAll("#metric-selector input:checked")).map(i => i.value);
        const selectedKeysB = Array.from(document.querySelectorAll("#metric-selector-b input:checked")).map(i => i.value);
        const selectedYears = Array.from(document.querySelectorAll("#analysis-year-selector input:checked")).map(i => i.value);

        if (!selectedYears.length) { alert("Select at least one year."); return; }
        if ((mode === "yoy" || mode === "both") && selectedYears.length < 2) { alert("YoY requires at least 2 selected years."); return; }
        if (setMode === "compare" && mode !== "raw") { alert("Comparison mode supports Raw only."); return; }

        if (setMode === "single") {
            renderAnalysisTable(selectedKeysA, selectedYears, mode);
            renderAnalysisChart(selectedKeysA, selectedYears);
        } else {
            renderComparisonAnalysis(selectedKeysA, selectedKeysB, selectedYears, mode);
        }
    }

    function renderAnalysisTable(selectedKeys, years, mode) {
        const container = document.getElementById("analysis-table");
        if (!selectedKeys.length) { container.innerHTML = "<p class='aw-empty'>Select at least one metric.</p>"; return; }

        let html = `<table><tr><th>Metric</th>`;
        years.forEach(y => { html += `<th>${y}</th>`; });
        html += `</tr>`;

        selectedKeys.forEach(key => {
            let displayLabel = key;

            if (key.includes('__')) {
                const [docKey, sectionKey] = key.split('__');
                const schema = docKey === 'pnl' ? pnlSchema : balanceSheetSchema;
                const section = (schema?.structure || []).find(s => s.key === sectionKey);
                displayLabel = section ? section.title : sectionKey;
            } else if (key.startsWith('cr__')) {
                displayLabel = customRatios.find(r => r.key === key.slice(4))?.label || key;
            } else {
                const metric = (engineConfig?.metricsFormulas || []).find(m => m.key === key);
                if (metric) displayLabel = metric.label;
            }

            html += `<tr><td>${displayLabel}</td>`;

            years.forEach((year, index) => {
                const model = buildFinancialModel(currentFsaData.data, year, reclassMap, engineConfig);
                let rawValue = 0;

                if (key.includes("__")) {
                    const [sectionKey, item] = key.split("__");
                    const source = getSource(sectionKey);
                    const store = source === "pnl" ? currentFsaData.data?.pnl : currentFsaData.data?.bs;
                    rawValue = store?.[sectionKey]?.[year]?.[item] || 0;
                } else {
                    rawValue = key.startsWith('cr__') ? computeCustomRatioValue(key.replace('cr__', ''), year) : (model[key] || 0);
                }

                const formattedRaw = formatValue(key, rawValue);

                if (mode === "raw") {
                    html += `<td>${formattedRaw}</td>`;
                } else {
                    if (index === 0) {
                        html += `<td>${mode === "yoy" ? '<span style="opacity:0.4;font-size:11px">Base</span>' : formattedRaw}</td>`;
                    } else {
                        const prevYear = years[index - 1];
                        const prevModel = buildFinancialModel(currentFsaData.data, prevYear, reclassMap, engineConfig);
                        let prevVal = 0;

                        if (key.includes("__")) {
                            const [sectionKey, item] = key.split("__");
                            const source = getSource(sectionKey);
                            const store = source === "pnl" ? currentFsaData.data?.pnl : currentFsaData.data?.bs;
                            prevVal = store?.[sectionKey]?.[prevYear]?.[item] || 0;
                        } else {
                            prevVal = key.startsWith('cr__') ? computeCustomRatioValue(key.replace('cr__', ''), prevYear) : (prevModel[key] || 0);
                        }

                        const yoy = prevVal !== 0 ? ((rawValue - prevVal) / prevVal) * 100 : 0;
                        const yoyClass = yoy >= 0 ? 'text-green-500' : 'text-red-500';

                        if (mode === "yoy") {
                            html += `<td><span class="${yoyClass}">${yoy.toFixed(1)}%</span></td>`;
                        } else if (mode === "both") {
                            html += `<td>${formattedRaw}<br><span style="font-size:10px;" class="${yoyClass}">(${yoy > 0 ? '+' : ''}${yoy.toFixed(1)}%)</span></td>`;
                        }
                    }
                }
            });
            html += `</tr>`;
        });
        html += `</table>`;
        container.innerHTML = html;
    }

    function renderAnalysisChart(selectedKeys, years) {
        const canvas = document.getElementById("analysis-chart");
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (analysisChart) analysisChart.destroy();

        const chartMode = document.getElementById("analysis-chart-type")?.value || "line";
        const analysisMode = document.getElementById("analysis-mode")?.value || "raw";
        const colors = ["#ef4444", "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#06b6d4"];
        const datasets = [];

        selectedKeys.forEach((key, index) => {
            let displayLabel = key;

            if (key.includes('__')) {
                const [docKey, sectionKey] = key.split('__');
                const schema = docKey === 'pnl' ? pnlSchema : balanceSheetSchema;
                const section = (schema?.structure || []).find(s => s.key === sectionKey);
                displayLabel = section ? section.title : sectionKey;
            } else if (key.startsWith('cr__')) {
                displayLabel = customRatios.find(r => r.key === key.slice(4))?.label || key;
            } else {
                const metric = (engineConfig?.metricsFormulas || []).find(m => m.key === key);
                if (metric) displayLabel = metric.label;
            }

            const baseData = years.map(year => {
                const model = buildFinancialModel(currentFsaData.data, year, reclassMap, engineConfig);
                if (key.includes("__")) {
                    const [sectionKey, item] = key.split("__");
                    const source = getSource(sectionKey);
                    const store = source === "pnl" ? currentFsaData.data?.pnl : currentFsaData.data?.bs;
                    return store?.[sectionKey]?.[year]?.[item] || 0;
                }
                return key.startsWith('cr__') ? computeCustomRatioValue(key.replace('cr__', ''), year) : (model[key] || 0);
            });

            if (analysisMode === "raw" || analysisMode === "both") {
                datasets.push({
                    label: displayLabel,
                    data: baseData,
                    type: chartMode === "combo" ? "bar" : chartMode,
                    borderColor: colors[index % colors.length],
                    backgroundColor: colors[index % colors.length] + "40",
                    borderWidth: 2,
                    borderRadius: chartMode === 'bar' || chartMode === 'combo' ? 4 : 0,
                    yAxisID: "y"
                });
            }

            if (analysisMode === "yoy" || analysisMode === "both") {
                const isPercentage = isCustomRatioPercentage(key);
                const yoyData = baseData.map((val, i) => {
                    if (i === 0) return null;
                    const prev = baseData[i - 1];
                    if (isPercentage) return val - prev;
                    return prev !== 0 ? ((val - prev) / prev) * 100 : 0;
                });

                datasets.push({
                    label: displayLabel + (isPercentage ? " (Δ pp)" : " (YoY %)"),
                    data: yoyData,
                    type: "line",
                    borderColor: colors[index % colors.length],
                    backgroundColor: "transparent",
                    borderWidth: 2,
                    tension: 0.3,
                    borderDash: [5, 5],
                    pointRadius: 4,
                    spanGaps: false,
                    yAxisID: analysisMode === "both" ? "y1" : "y"
                });
            }
        });

        analysisChart = new Chart(ctx, {
            data: { labels: years, datasets: datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: "index", intersect: false },
                plugins: { legend: { position: "top", labels: { color: "#9ca3af", font: { size: 11 } } } },
                scales: {
                    x: { ticks: { color: "#9ca3af" }, grid: { color: "rgba(255,255,255,0.05)" } },
                    y: { type: "linear", position: "left", ticks: { color: "#9ca3af" }, grid: { color: "rgba(255,255,255,0.05)" } },
                    y1: { type: "linear", position: "right", display: analysisMode === "both", grid: { drawOnChartArea: false }, ticks: { color: "#9ca3af" } }
                }
            }
        });
    }

    function renderComparisonAnalysis(setA, setB, years, mode) {
        const container = document.getElementById("analysis-table");
        if (!setA.length || !setB.length) { container.innerHTML = "<p class='aw-empty'>Select metrics in both sets.</p>"; return; }

        let html = `<table><tr><th>Year</th><th>Set A Total</th><th>Set B Total</th><th>Difference</th><th>Ratio (A/B)</th></tr>`;

        years.forEach((year, index) => {
            const totalA = calculateSetTotal(setA, year);
            const totalB = calculateSetTotal(setB, year);
            let displayA = totalA, displayB = totalB;

            if (mode === "yoy" && index > 0) {
                const prevA = calculateSetTotal(setA, years[index - 1]);
                const prevB = calculateSetTotal(setB, years[index - 1]);
                displayA = prevA !== 0 ? ((totalA - prevA) / prevA) * 100 : 0;
                displayB = prevB !== 0 ? ((totalB - prevB) / prevB) * 100 : 0;
            }

            // FIX: diff and ratio computed from displayA/displayB, not raw totals
            const diff = displayA - displayB;
            const ratio = displayB !== 0 ? displayA / displayB : 0;

            html += `<tr>
                <td>${year}</td>
                <td>${formatValue("custom", displayA)}</td>
                <td>${formatValue("custom", displayB)}</td>
                <td>${formatValue("custom", diff)}</td>
                <td>${ratio.toFixed(2)}x</td>
            </tr>`;
        });

        html += "</table>";
        container.innerHTML = html;
        renderComparisonChart(setA, setB, years, mode);
    }

    // FIX: buildFinancialModel hoisted outside loop; += instead of =
    function calculateSetTotal(setKeys, year) {
        let total = 0;
        const model = buildFinancialModel(currentFsaData.data, year, reclassMap, engineConfig);
        setKeys.forEach(key => {
            if (key.includes("__")) {
                const [sectionKey, item] = key.split("__");
                const source = getSource(sectionKey);
                const store = source === "pnl" ? currentFsaData.data?.pnl : currentFsaData.data?.bs;
                total += model[sectionKey] !== undefined ? model[sectionKey] : (store?.[sectionKey]?.[year]?.[item] || 0);
            } else {
                total += key.startsWith('cr__') ? computeCustomRatioValue(key.replace('cr__', ''), year) : (model[key] || 0);
            }
        });
        return total;
    }

    function renderComparisonChart(setA, setB, years, mode) {
        const canvas = document.getElementById("analysis-chart");
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (analysisChart) analysisChart.destroy();
        const chartType = document.getElementById("analysis-chart-type")?.value || "line";

        // FIX: i > 0 guard (was i === 0, which caused years[-1] = undefined)
        const dataA = years.map((y, i) => {
            const raw = calculateSetTotal(setA, y);
            if (mode === "yoy" && i > 0) { const prev = calculateSetTotal(setA, years[i - 1]); return prev !== 0 ? ((raw - prev) / prev) * 100 : 0; }
            return raw;
        });
        const dataB = years.map((y, i) => {
            const raw = calculateSetTotal(setB, y);
            if (mode === "yoy" && i > 0) { const prev = calculateSetTotal(setB, years[i - 1]); return prev !== 0 ? ((raw - prev) / prev) * 100 : 0; }
            return raw;
        });
        const diffData = dataA.map((val, i) => val - dataB[i]);

        analysisChart = new Chart(ctx, {
            type: chartType === "combo" ? "bar" : chartType,
            data: {
                labels: years,
                datasets: [
                    { label: "Set A", data: dataA, backgroundColor: "#ef444440", borderColor: "#ef4444", borderWidth: 2, type: chartType === "combo" ? "bar" : chartType },
                    { label: "Set B", data: dataB, backgroundColor: "#3b82f640", borderColor: "#3b82f6", borderWidth: 2, type: chartType === "combo" ? "bar" : chartType },
                    { label: "Difference", data: diffData, borderColor: "#10b981", borderWidth: 2, borderDash: [5, 5], type: "line", fill: false }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { labels: { color: "#9ca3af" } } },
                scales: {
                    x: { ticks: { color: "#9ca3af" }, grid: { color: "rgba(255,255,255,0.05)" } },
                    y: { ticks: { color: "#9ca3af" }, grid: { color: "rgba(255,255,255,0.05)" } }
                }
            }
        });
    }

    function initializeReclassification() {
        const fromSelect = document.getElementById("reclass-from-section");
        const toSelect = document.getElementById("reclass-to-section");
        const itemSelect = document.getElementById("reclass-line-item");
        fromSelect.innerHTML = ""; toSelect.innerHTML = ""; itemSelect.innerHTML = "";

        const allSections = [
            ...(pnlSchema?.structure || []).filter(s => s.type === "section").map(s => ({ ...s, source: 'pnl' })),
            ...(balanceSheetSchema?.structure || []).filter(s => s.type === "section").map(s => ({ ...s, source: 'bs' }))
        ];

        allSections.forEach(section => {
            fromSelect.innerHTML += `<option value="${section.key}">${section.title}</option>`;
            toSelect.innerHTML += `<option value="${section.key}">${section.title}</option>`;
        });

        fromSelect.addEventListener("change", () => {
            const sectionKey = fromSelect.value;
            const source = getSource(sectionKey);
            const store = source === "pnl" ? currentFsaData.data?.pnl : currentFsaData.data?.bs;
            const sectionData = store?.[sectionKey] || {};

            const uniqueItems = new Set();
            Object.values(sectionData).forEach(yearObj => { Object.keys(yearObj || {}).forEach(i => uniqueItems.add(i)); });
            itemSelect.innerHTML = "";
            uniqueItems.forEach(i => { itemSelect.innerHTML += `<option value="${i}">${i}</option>`; });
        });

        setTimeout(() => { fromSelect.dispatchEvent(new Event("change")); }, 0);

        document.getElementById("apply-reclass").addEventListener("click", () => {
            const from = document.getElementById("reclass-from-section").value;
            const to = document.getElementById("reclass-to-section").value;
            const selectedItems = Array.from(document.getElementById("reclass-line-item").selectedOptions).map(opt => opt.value);
            const sourceType = getSource(from);

            if (!reclassMap[sourceType][from]) reclassMap[sourceType][from] = {};
            selectedItems.forEach(item => { reclassMap[sourceType][from][item] = to; });
            document.getElementById("reclass-tab-container").style.display = "block";
            alert("Reclassification Applied");
        });

        // FIX: was fsaState.reclassMap (ReferenceError) — now mutates reclassMap in scope
        document.getElementById("clear-reclass").addEventListener("click", () => {
            reclassMap.pnl = {};
            reclassMap.bs = {};
            document.getElementById("reclass-tab-container").style.display = "none";
            document.getElementById("analysis-table").innerHTML = "<p class='aw-empty'>Reclassification cleared.</p>";
        });
    }

    function renderReclassifiedTable() {
        const container = document.getElementById("analysis-table");
        const years = [...(currentFsaData.years || [])].sort(
            (a, b) => (parseInt(a.replace(/\D/g, '')) || 0) - (parseInt(b.replace(/\D/g, '')) || 0)
        );
        let html = `<table><tr><th>Metric</th>${years.map(y => `<th>${y}</th>`).join("")}</tr>`;

        html += `<tr><td colspan="${years.length + 1}" style="font-weight:800;color:var(--accent);background:var(--fsa-surface2);">PROFIT & LOSS</td></tr>`;
        (pnlSchema?.structure || []).forEach(item => {
            if (item.type === "section" || item.type === "total") {
                html += `<tr><td style="font-weight:${item.type === "total" ? "700" : "500"};">${item.title}</td>`;
                years.forEach(year => {
                    const model = buildFinancialModel(currentFsaData.data, year, reclassMap, engineConfig);
                    html += `<td>${formatValue(item.key, model[item.key] || 0)}</td>`;
                });
                html += `</tr>`;
            }
        });

        html += `<tr><td colspan="${years.length + 1}" style="font-weight:800;color:var(--accent);background:var(--fsa-surface2);">BALANCE SHEET</td></tr>`;
        (balanceSheetSchema?.structure || []).forEach(item => {
            if (item.type === "section" || item.type === "total") {
                html += `<tr><td style="font-weight:${item.type === "total" ? "700" : "500"};">${item.title}</td>`;
                years.forEach(year => {
                    const model = buildFinancialModel(currentFsaData.data, year, reclassMap, engineConfig);
                    html += `<td>${formatValue(item.key, model[item.key] || 0)}</td>`;
                });
                html += `</tr>`;
            }
        });
        html += `</table>`;
        container.innerHTML = html;
    }

    function buildMetricSelector(targetId) {
        const container = document.getElementById(targetId);
        if (!container) return;
        container.innerHTML = "";
        const years = currentFsaData.years || [];

        const pnlGroup = document.createElement("div");
        pnlGroup.className = "aw-sidebar-group";
        pnlGroup.innerHTML = `<div class="aw-group-title">Profit & Loss</div>`;
        (pnlSchema?.structure || []).filter(s => s.type === "section").forEach(section => {
            const details = document.createElement("details");
            details.className = "aw-details";
            const summary = document.createElement("summary");
            summary.innerText = section.title;
            details.appendChild(summary);
            details.appendChild(createMetricCheckbox(section.title + " (Total)", section.key, true));

            const dataSource = currentFsaData.data?.pnl?.[section.key];
            const uniqueItems = new Set();
            years.forEach(year => { Object.keys(dataSource?.[year] || {}).forEach(i => uniqueItems.add(i)); });
            uniqueItems.forEach(item => { details.appendChild(createMetricCheckbox(item, `${section.key}__${item}`, false)); });
            pnlGroup.appendChild(details);
        });
        container.appendChild(pnlGroup);

        const bsGroup = document.createElement("div");
        bsGroup.className = "aw-sidebar-group";
        bsGroup.innerHTML = `<div class="aw-group-title">Balance Sheet</div>`;
        (balanceSheetSchema?.structure || []).filter(s => s.type === "section").forEach(section => {
            const details = document.createElement("details");
            details.className = "aw-details";
            const summary = document.createElement("summary");
            summary.innerText = section.title;
            details.appendChild(summary);
            details.appendChild(createMetricCheckbox(section.title + " (Total)", section.key, true));

            const dataSource = currentFsaData.data?.bs?.[section.key];
            const uniqueItems = new Set();
            years.forEach(year => { Object.keys(dataSource?.[year] || {}).forEach(i => uniqueItems.add(i)); });
            uniqueItems.forEach(item => { details.appendChild(createMetricCheckbox(item, `${section.key}__${item}`, false)); });
            bsGroup.appendChild(details);
        });
        container.appendChild(bsGroup);

        if (customRatios.length > 0) {
            const ratioGroup = document.createElement("div");
            ratioGroup.className = "aw-sidebar-group";
            ratioGroup.innerHTML = `<div class="aw-group-title">Custom Ratios</div>`;
            customRatios.forEach(ratio => {
                ratioGroup.appendChild(createMetricCheckbox(ratio.label, `cr__${ratio.key}`, false));
            });
            container.appendChild(ratioGroup);
        }
    }

    function buildYearSelector() {
        const container = document.getElementById("analysis-year-selector");
        if (!container) return;
        container.innerHTML = "";
        const sortedYears = [...(currentFsaData?.years ?? [])].sort(
            (a, b) => (parseInt(a.replace(/\D/g, '')) || 0) - (parseInt(b.replace(/\D/g, '')) || 0)
        );
        sortedYears.forEach(year => {
            container.appendChild(createMetricCheckbox(year, year, false, true));
        });
    }

    function createMetricCheckbox(label, value, isTotal, isChecked = false) {
        const labelEl = document.createElement("label");
        labelEl.className = "aw-checkbox-label";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = value;
        if (isChecked) checkbox.checked = true;
        const span = document.createElement("span");
        span.innerText = label;
        if (isTotal) span.style.fontWeight = "700";
        labelEl.appendChild(checkbox);
        labelEl.appendChild(span);
        return labelEl;
    }

    function updateChartTypeOptions() {
        const mode = document.getElementById("analysis-mode").value;
        const setMode = document.getElementById("analysis-set-mode").value;
        const select = document.getElementById("analysis-chart-type");
        select.innerHTML = "";
        if (setMode === "compare") { select.innerHTML = `<option value="bar">Bar</option>`; return; }
        if (mode === "raw") select.innerHTML = `<option value="bar">Bar</option>`;
        if (mode === "yoy") select.innerHTML = `<option value="line">Line</option>`;
        if (mode === "both") select.innerHTML = `<option value="combo">Bar + Line</option>`;
    }

    function getSelectedMetrics() { return Array.from(document.querySelectorAll("#metric-selector input:checked")).map(i => i.value); }
    function getSelectedYears() { return Array.from(document.querySelectorAll("#analysis-year-selector input:checked")).map(i => i.value); }

    function getHtmlTemplate() {
        return `
            <div class="aw-layout">
                <!-- Sidebar -->
                <div class="aw-sidebar">
                    <div class="aw-sidebar-header">Analysis Config</div>

                    <div class="aw-sidebar-section">
                        <div class="aw-sidebar-title">Metrics (Set A)</div>
                        <div id="metric-selector" class="aw-metric-list"></div>
                    </div>

                    <div class="aw-sidebar-section" id="set-b-container" style="display:none">
                        <div class="aw-sidebar-title">Metrics (Set B)</div>
                        <div id="metric-selector-b" class="aw-metric-list"></div>
                    </div>

                    <div class="aw-sidebar-section">
                        <div class="aw-sidebar-title">Years</div>
                        <div id="analysis-year-selector" class="aw-year-list"></div>
                    </div>
                </div>

                <!-- Main Workspace -->
                <div class="aw-main">
                    <div class="aw-toolbar">
                        <div class="aw-toolbar-left">
                            <div class="aw-ctrl">
                                <label>Mode</label>
                                <select id="analysis-mode"><option value="raw">Raw</option><option value="yoy">YoY %</option><option value="both">Both</option></select>
                            </div>
                            <div class="aw-ctrl">
                                <label>Compare</label>
                                <select id="analysis-set-mode"><option value="single">Single</option><option value="compare">A vs B</option></select>
                            </div>
                            <div class="aw-ctrl">
                                <label>Chart</label>
                                <select id="analysis-chart-type"><option value="bar">Bar</option><option value="line">Line</option><option value="combo">Combo</option></select>
                            </div>
                        </div>
                        <div class="aw-toolbar-right">
                            <input type="text" id="analysis-context" class="aw-context-input" placeholder="Notes / context...">
                            <button class="aw-btn-ghost" id="reclass-toggle-btn">⇄ Reclass</button>
                            <button class="aw-btn-ghost" id="reset-analysis-btn">↻ Reset</button>
                            <button class="aw-btn-ghost" id="save-analysis-btn">💾 Save</button>
                            <button class="aw-btn-run" id="run-analysis-btn">▶ Run Analysis</button>
                        </div>
                    </div>

                    <div class="aw-reclass-tray" id="reclass-tray">
                        <div class="aw-reclass-inner">
                            <span class="aw-rlbl">Reclassify</span>
                            <div class="aw-rfield"><span class="aw-rfieldlbl">From</span><select id="reclass-from-section" class="aw-rsel"></select></div>
                            <select id="reclass-line-item" multiple class="aw-rmulti"></select>
                            <span class="aw-rarrow">→</span>
                            <div class="aw-rfield"><span class="aw-rfieldlbl">To</span><select id="reclass-to-section" class="aw-rsel"></select></div>
                            <button id="apply-reclass" class="aw-rapply">Apply</button>
                            <button id="clear-reclass" class="aw-rclear">Clear</button>
                            <div id="reclass-tab-container" style="display:none"><button id="reclass-table-btn" class="aw-btn-ghost" style="margin-left:6px;font-size:10px">View Reclassified</button></div>
                        </div>
                    </div>

                    <div class="aw-output">
                        <div class="aw-card">
                            <div class="aw-card-header">Chart Output</div>
                            <div class="aw-chart-wrapper"><canvas id="analysis-chart"></canvas></div>
                        </div>
                        <div class="aw-card">
                            <div class="aw-card-header">Data Table</div>
                            <div class="aw-table-wrapper" id="analysis-table">
                                <div class="aw-empty">Select metrics + years in the sidebar, then click Run Analysis.</div>
                            </div>
                        </div>
                    </div>

                    <div class="aw-saved-zone">
                        <div class="aw-saved-header">Saved Analyses</div>
                        <div class="aw-saved-strip" id="saved-analyses"></div>
                    </div>
                </div>
            </div>
        `;
    }

    return { initializeAnalysisWorkbench, getHtmlTemplate };
}
