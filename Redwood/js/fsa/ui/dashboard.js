// fsa/ui/dashboard.js
import { buildFinancialModel } from "../core/engine.js";
import { formatValue } from "../utils/formatters.js";

let dashboardCharts = [];

const CHART_COLORS = [
  "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", 
  "#06b6d4", "#ec4899", "#f97316", "#a3e635"
];

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { labels: { color: "#7a8ba6", font: { size: 11, family: "Open Sans" }, boxWidth: 12, padding: 16 } },
    tooltip: { backgroundColor: "rgba(15,22,35,0.96)", borderColor: "rgba(185,28,28,0.35)", borderWidth: 1, titleColor: "#e8edf5", bodyColor: "#7a8ba6", padding: 10 }
  },
  scales: {
    x: { ticks: { color: "#7a8ba6", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.04)" } },
    y: { ticks: { color: "#7a8ba6", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.04)" } }
  }
};

export function initDashboard({ currentFsaData, reclassMap, configSchemas }) {

  // Helper to fetch readable labels for metrics defined in settings
  function getLabelForMetric(key) {
      if (!configSchemas) return key;
      const metric = configSchemas.metricsFormulas?.find(m => m.key === key);
      if (metric) return metric.label;
      const ratioKey = key.startsWith('cr__') ? key.replace('cr__', '') : key;
      const ratio = configSchemas.customRatios?.find(r => r.key === ratioKey);
      if (ratio) return ratio.label;
      
      // Check base schemas
      let secLabel = key;
      configSchemas.pnlSchema?.structure.forEach(s => { if(s.key === key) secLabel = s.title; });
      configSchemas.bsSchema?.structure.forEach(s => { if(s.key === key) secLabel = s.title; });
      return secLabel;
  }

  function renderDashboard(canvas) {
    const years = currentFsaData.years || [];
    if (!years.length) {
      canvas.innerHTML = `<div class="fsa-empty" style="padding:40px; text-align:center; color:#9ca3af;">No years configured. Go to Data Entry to begin.</div>`;
      return;
    }

    if (!configSchemas.dashboardConfig || !configSchemas.dashboardConfig.kpis || configSchemas.dashboardConfig.kpis.length === 0) {
      canvas.innerHTML = `<div class="fsa-empty" style="padding:40px; text-align:center; color:#9ca3af;">Dashboard is empty. Configure your KPIs and Charts in Settings.</div>`;
      return;
    }

    dashboardCharts.forEach(c => c.destroy());
    dashboardCharts = [];

    // Default to the earliest (base) year so YoY progression is chronologically correct
    const latestYear = [...years].sort((a, b) =>
        (parseInt(a.replace(/\D/g, '')) || 0) - (parseInt(b.replace(/\D/g, '')) || 0)
    )[0];
    canvas.innerHTML = buildShell(years, latestYear);
    
    renderKPIs(years, latestYear);
    renderCharts(years);
    bindYearPills(canvas, years);
  }

  function buildShell(years, activeYear) {
    const pillsHTML = years.map(y =>
      `<button class="db-year-pill ${y === activeYear ? "active" : ""}" data-year="${y}">${y}</button>`
    ).join("");

    // Dynamically create chart grid HTML based on configured charts
    const chartsHtml = (configSchemas.dashboardConfig?.charts || []).map((chart, i) => `
        <div class="db-chart-card">
          <div class="db-chart-title">${chart.title}</div>
          <div class="db-chart-wrap"><canvas id="db-chart-${i}"></canvas></div>
        </div>
    `).join("");

    return `
      <div class="db-wrap">
        <div class="db-year-bar">
          <span class="db-bar-label">YEAR</span>
          <div class="db-year-pills" id="db-year-pills">${pillsHTML}</div>
          <span class="db-bar-hint">Click any year to update KPI cards</span>
        </div>

        <div class="db-kpi-grid" id="db-kpi-grid"></div>

        <div class="db-charts-row" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(450px, 1fr)); gap: 16px;">
            ${chartsHtml}
        </div>
      </div>`;
  }

  function renderKPIs(years, selectedYear) {
    const grid = document.getElementById("db-kpi-grid");
    if (!grid) return;

    const model = buildFinancialModel(currentFsaData.data, selectedYear, reclassMap, configSchemas);
    const prevYear = years[years.indexOf(selectedYear) - 1];
    const prevModel = prevYear ? buildFinancialModel(currentFsaData.data, prevYear, reclassMap, configSchemas) : null;

    const kpis = configSchemas.dashboardConfig.kpis || [];

    grid.innerHTML = kpis.map((kpiKey, index) => {
      const val  = model[kpiKey] ?? 0;
      const prev = prevModel ? (prevModel[kpiKey] ?? 0) : null;
      const yoy  = (prev !== null && prev !== 0) ? ((val - prev) / Math.abs(prev)) * 100 : null;
      const color = CHART_COLORS[index % CHART_COLORS.length];
      const label = getLabelForMetric(kpiKey);

      const badge = yoy !== null
        ? `<div class="db-kpi-yoy ${yoy >= 0 ? "pos" : "neg"}">${yoy >= 0 ? "▲" : "▼"} ${Math.abs(yoy).toFixed(1)}% vs ${prevYear}</div>`
        : `<div class="db-kpi-yoy neutral">— First year</div>`;

      return `
        <div class="db-kpi-card" style="--kc:${color}">
          <div class="db-kpi-header">
            <span class="db-kpi-label">${label}</span>
            <span class="db-kpi-dot" style="background:${color};box-shadow:0 0 8px ${color}88"></span>
          </div>
          <div class="db-kpi-val">${formatValue(kpiKey, val, configSchemas)}</div>
          ${badge}
        </div>`;
    }).join("");
  }

  function renderCharts(years) {
    const models = years.map(y => buildFinancialModel(currentFsaData.data, y, reclassMap, configSchemas));
    const chartsConfig = configSchemas.dashboardConfig.charts || [];

    chartsConfig.forEach((chartDef, ci) => {
        const canvasEl = document.getElementById(`db-chart-${ci}`);
        if (!canvasEl) return;

        const datasets = chartDef.datasets.map((dsKey, di) => {
            const color = CHART_COLORS[di % CHART_COLORS.length];
            const isLine = chartDef.type === "line" || (chartDef.type === "combo" && di === 1);
            
            return {
                label: getLabelForMetric(dsKey),
                type: isLine ? "line" : "bar",
                data: models.map(m => m[dsKey] || 0),
                backgroundColor: isLine ? `${color}1A` : `${color}33`,
                borderColor: color,
                borderWidth: isLine ? 2.5 : 2,
                borderRadius: isLine ? 0 : 5,
                fill: isLine,
                tension: 0.4,
                pointBackgroundColor: color,
                pointRadius: isLine ? 4 : 0,
                order: isLine ? 1 : 2
            };
        });

        dashboardCharts.push(new Chart(canvasEl, {
            type: chartDef.type === "combo" ? "bar" : chartDef.type,
            data: { labels: years, datasets },
            options: structuredClone(CHART_DEFAULTS)
        }));
    });
  }

  function bindYearPills(canvas, years) {
    const pills = document.getElementById("db-year-pills");
    if (!pills) return;

    pills.addEventListener("click", e => {
      const pill = e.target.closest(".db-year-pill");
      if (!pill) return;

      pills.querySelectorAll(".db-year-pill").forEach(p => p.classList.remove("active"));
      pill.classList.add("active");

      renderKPIs(years, pill.dataset.year);
    });
  }

  return { renderDashboard };
}