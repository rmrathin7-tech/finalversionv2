// js/fsa/features/exportImport.js
import { fsaState } from "../state/fsaState.js";
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";


export function exportJSON() {
    const company  = fsaState.currentFsaData?.companyName || fsaState.currentFsaData?.name || 'FSA-Export';
    const filename = `${company}_${new Date().toISOString().slice(0, 10)}.json`;
    const blob     = new Blob([JSON.stringify(fsaState.currentFsaData, null, 2)], { type: "application/json" });
    const url      = URL.createObjectURL(blob);
    const a        = document.createElement("a");
    a.href         = url;
    a.download     = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    flashStatus('⬇ Exported!', 'var(--positive)');
}


export function importJSON({ file, db, currentProjectId, currentFsaId, renderSection }) {
    const reader = new FileReader();

    reader.onload = async function(e) {
        try {
            const data = JSON.parse(e.target.result);

            if (!data.data && !data.years) {
                alert('❌ Invalid FSA JSON — missing required fields.');
                return;
            }

            if (!confirm("This will overwrite ALL current financial data.\nThis cannot be undone. Proceed?")) return;

            fsaState.currentFsaData = data;

            await setDoc(
                doc(db, "projects", currentProjectId, "fsa", currentFsaId),
                data,
                { merge: false }
            );

            flashStatus('⬆ Imported!', 'var(--accent)');
            setTimeout(() => renderSection(fsaState.currentSection || 'dataEntry'), 400);

        } catch (err) {
            alert("❌ Import failed: " + err.message);
        }
    };

    reader.readAsText(file);
}


export function setupExportImport({ db, currentProjectId, currentFsaId, renderSection }) {

    const exportBtn = document.getElementById("export-json-btn");
    if (exportBtn && !exportBtn._wired) {
        exportBtn._wired = true;
        exportBtn.addEventListener("click", exportJSON);
    }

    const importBtn = document.getElementById("import-json-btn");
    if (importBtn && !importBtn._wired) {
        importBtn._wired = true;
        importBtn.addEventListener("click", () => {
            document.getElementById("import-json-input")?.click();
        });
    }

    const importInput = document.getElementById("import-json-input");
    if (importInput && !importInput._wired) {
        importInput._wired = true;
        importInput.addEventListener("change", (e) => {
            const file = e.target.files[0];
            if (file) {
                importJSON({ file, db, currentProjectId, currentFsaId, renderSection });
                e.target.value = "";
            }
        });
    }
}


function flashStatus(msg, color) {
    const el = document.getElementById('fsa-save-status');
    if (!el) return;
    el.textContent   = msg;
    el.style.color   = color;
    el.style.display = 'inline';
    setTimeout(() => { el.style.display = 'none'; }, 2500);
}
