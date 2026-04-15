import { fsaState } from "../state/fsaState.js";
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── HELPER: Indian Financial Year Formatter ──
// Converts "2025", "FY25", "2024-25", "FY2025" into "FY2024-25"
export function formatFinancialYear(input) {
    if (!input) return "";
    let str = input.toString().trim().toUpperCase();
    
    // Extract all numbers from the input string
    const nums = str.match(/\d+/g);
    if (!nums || nums.length === 0) return str; // If no numbers, return as-is
    
    // Take the very last number provided (e.g. from "2024-2025" we take "2025")
    let yearNum = parseInt(nums[nums.length - 1], 10);
    
    // If they typed a 2-digit year (e.g., "25"), convert to 2025
    if (yearNum < 100) {
        yearNum += 2000;
    }

    const prevYear = yearNum - 1;
    const shortCurrentYear = yearNum.toString().slice(-2);
    
    return `FY${prevYear}-${shortCurrentYear}`;
}

// Add year system to data entry section
export function setupYearSystem({ db, currentProjectId, currentFsaId, dataEntryModuleRef, pnlSchema }) {

    if (!fsaState.currentFsaData.years) fsaState.currentFsaData.years = [];
    renderYears({ db, currentProjectId, currentFsaId, dataEntryModuleRef, pnlSchema });

    // ── FIX: Safely refresh the active data table ──
    function refreshActiveTable() {
        const docTabs = document.querySelectorAll('.doc-tab-btn');
        let clicked = false;
        docTabs.forEach(btn => {
            if (btn.style.background.includes('var(--brand-primary)')) {
                btn.click();
                clicked = true;
            }
        });
        if (!clicked && docTabs.length > 0) docTabs[0].click();
    }

    // ── MANAGE YEARS BUTTON ──
    const manageBtn = document.getElementById("manage-years-btn");
    if (manageBtn && !manageBtn._wired) {
        manageBtn._wired = true;
        manageBtn.addEventListener("click", () => {
            const container = document.getElementById("year-container");
            const existingPanel = container.querySelector(".manage-years-panel");
            
            if (existingPanel) {
                existingPanel.remove();
                return;
            }

            const panel = document.createElement("div");
            panel.className = "manage-years-panel";
            panel.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <strong style="color:var(--text-main);font-size:13px;">Select years to hide:</strong>
                    <button id="close-manage-years" style="background:none;border:none;cursor:pointer;color:var(--text-muted);">✕</button>
                </div>
                <div id="hide-year-checkboxes" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
                    ${fsaState.currentFsaData.years.map(y => `
                        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-main);cursor:pointer;">
                            <input type="checkbox" value="${y}" ${window.hiddenYears?.includes(y) ? "checked" : ""} style="accent-color:var(--accent);">
                            ${y}
                        </label>
                    `).join("")}
                </div>
                <button id="apply-year-filter" class="fsa-btn">Apply Filter</button>
            `;

            container.appendChild(panel);

            document.getElementById("close-manage-years").addEventListener("click", () => panel.remove());

            document.getElementById("apply-year-filter").addEventListener("click", () => {
                const checked = panel.querySelectorAll("input[type=checkbox]:checked");
                window.hiddenYears = Array.from(checked).map(i => i.value);
                panel.remove();
                refreshActiveTable();
            });
        });
    }

    // ── ADD YEAR BUTTON ──
    const addBtn = document.getElementById("add-year-btn");
    if (addBtn && !addBtn._wired) {
        addBtn._wired = true;
        addBtn.addEventListener("click", async () => {
            const inputYear = prompt("Enter financial year (e.g. 2025 or FY25)");
            if (!inputYear || inputYear.trim() === "") return;

            // Automatically format the year
            const fy = formatFinancialYear(inputYear);

            if (fsaState.currentFsaData.years.includes(fy)) {
                alert(`Year ${fy} already exists in this FSA.`);
                return;
            }

            fsaState.currentFsaData.years.push(fy);

            await updateDoc(
                doc(db, "projects", currentProjectId, "fsa", currentFsaId),
                { years: fsaState.currentFsaData.years }
            );

            renderYears({ db, currentProjectId, currentFsaId, dataEntryModuleRef, pnlSchema });
            refreshActiveTable();
        });
    }
}

export function renderYears({ db, currentProjectId, currentFsaId, dataEntryModuleRef, pnlSchema }) {
    const container = document.getElementById("year-container");
    if (!container) return;

    const managePanel = container.querySelector(".manage-years-panel");
    Array.from(container.children).forEach(child => {
        if (!child.classList.contains("manage-years-panel")) child.remove();
    });

    // ── FIX: Same refresh utility for render loops ──
    function refreshActiveTable() {
        const docTabs = document.querySelectorAll('.doc-tab-btn');
        let clicked = false;
        docTabs.forEach(btn => {
            if (btn.style.background.includes('var(--brand-primary)')) {
                btn.click();
                clicked = true;
            }
        });
        if (!clicked && docTabs.length > 0) docTabs[0].click();
    }

    fsaState.currentFsaData.years.forEach((year, index) => {
        const chip = document.createElement("div");
        chip.className = "year-tag"; 
        chip.draggable = true;
        chip.dataset.yearVal = year;
        chip.style.cursor = "grab";
        
        chip.innerHTML = `
            <span style="opacity:0.4; font-size:12px; margin-right:2px; letter-spacing: -2px;">⣿</span>
            ${year}
            <button class="edit-year-btn" title="Rename Year" style="margin-left:4px; opacity:0.6;">✏️</button>
            <button class="delete-year-btn" title="Delete Year" style="margin-left:4px; opacity:0.6;">✕</button>
        `;

        // ── RENAME YEAR LOGIC ──
        chip.querySelector(".edit-year-btn").addEventListener("click", async () => {
            const newYear = prompt(`Rename ${year} to:`, year);
            if (!newYear || newYear.trim() === "" || newYear === year) return;
            
            // Format renaming as well
            const cleanNewYear = formatFinancialYear(newYear.trim());

            if (fsaState.currentFsaData.years.includes(cleanNewYear)) {
                alert(`A year named ${cleanNewYear} already exists.`);
                return;
            }

            fsaState.currentFsaData.years[index] = cleanNewYear;

            const data = fsaState.currentFsaData.data;
            if (data) {
                Object.keys(data).forEach(type => {
                    Object.keys(data[type]).forEach(sec => {
                        if (data[type][sec][year] !== undefined) {
                            data[type][sec][cleanNewYear] = data[type][sec][year];
                            delete data[type][sec][year];
                        }
                    });
                });
            }

            if (window.hiddenYears && window.hiddenYears.includes(year)) {
                window.hiddenYears = window.hiddenYears.map(y => y === year ? cleanNewYear : y);
            }

            renderYears({ db, currentProjectId, currentFsaId, dataEntryModuleRef, pnlSchema });
            refreshActiveTable();

            await updateDoc(
                doc(db, "projects", currentProjectId, "fsa", currentFsaId),
                { years: fsaState.currentFsaData.years, data: fsaState.currentFsaData.data }
            );
        });

        // ── DELETE YEAR LOGIC ──
        chip.querySelector(".delete-year-btn").addEventListener("click", async () => {
            if(!confirm(`Delete year ${year} and ALL its financial data? This cannot be undone.`)) return;

            fsaState.currentFsaData.years.splice(index, 1);
            
            const data = fsaState.currentFsaData.data;
            if(data) {
                Object.keys(data).forEach(type => {
                    Object.keys(data[type]).forEach(sec => {
                        if(data[type][sec][year]) delete data[type][sec][year];
                    });
                });
            }

            renderYears({ db, currentProjectId, currentFsaId, dataEntryModuleRef, pnlSchema });
            refreshActiveTable();

            await updateDoc(
                doc(db, "projects", currentProjectId, "fsa", currentFsaId),
                { years: fsaState.currentFsaData.years, data: fsaState.currentFsaData.data }
            );
        });

        // ── DRAG & DROP LOGIC ──
        chip.addEventListener('dragstart', (e) => {
            chip.classList.add('dragging');
            chip.style.opacity = '0.4';
            chip.style.cursor = 'grabbing';
            e.dataTransfer.effectAllowed = "move";
        });

        chip.addEventListener('dragenter', (e) => {
            e.preventDefault();
            const dragging = container.querySelector('.dragging');
            if (dragging && dragging !== chip) {
                const allChips = [...container.querySelectorAll('.year-tag')];
                const draggingIdx = allChips.indexOf(dragging);
                const targetIdx = allChips.indexOf(chip);
                
                if (draggingIdx < targetIdx) {
                    chip.after(dragging);
                } else {
                    chip.before(dragging);
                }
            }
        });

        chip.addEventListener('dragover', (e) => e.preventDefault());

        chip.addEventListener('dragend', async () => {
            chip.classList.remove('dragging');
            chip.style.opacity = '1';
            chip.style.cursor = 'grab';
            
            const newYears = [];
            container.querySelectorAll('.year-tag').forEach(el => {
                newYears.push(el.dataset.yearVal);
            });
            
            if (JSON.stringify(newYears) === JSON.stringify(fsaState.currentFsaData.years)) return;

            fsaState.currentFsaData.years = newYears;
            
            refreshActiveTable();

            await updateDoc(
                doc(db, "projects", currentProjectId, "fsa", currentFsaId),
                { years: fsaState.currentFsaData.years }
            );
        });

        chip.querySelectorAll("button").forEach(btn => {
            btn.addEventListener("mouseover", e => e.target.style.opacity = "1");
            btn.addEventListener("mouseout", e => e.target.style.opacity = "0.6");
        });

        if (managePanel) {
            container.insertBefore(chip, managePanel);
        } else {
            container.appendChild(chip);
        }
    });
}
