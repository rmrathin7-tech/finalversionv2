// js/fsa/services/fsaService.js
import {
    doc,
    getDoc,
    updateDoc,
    setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export function createFSAService(db) {

    let pendingUpdates = {};
    let saveTimeout = null;

    function scheduleFieldSave(projectId, fsaId, path, value) {
        pendingUpdates[path] = value;

        if (saveTimeout) clearTimeout(saveTimeout);

        saveTimeout = setTimeout(async () => {
            const fsaRef = doc(db, "projects", projectId, "fsa", fsaId);
            try {
                await updateDoc(fsaRef, pendingUpdates);
                pendingUpdates = {};
            } catch (err) {
                console.error("Save failed:", err);
            }
            saveTimeout = null;
        }, 1200);
    }

    async function loadFSA(projectId, fsaId) {
        const ref = doc(db, "projects", projectId, "fsa", fsaId);
        const snap = await getDoc(ref);
        return snap.exists() ? snap.data() : null;
    }

    async function saveFSA(projectId, fsaId, data) {
        const ref = doc(db, "projects", projectId, "fsa", fsaId);
        // Always use merge: false (full overwrite) to prevent nested array corruption
        await setDoc(ref, data);
    }

    return {
        scheduleFieldSave,
        loadFSA,
        saveFSA
    };
}