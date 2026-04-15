// module-hub.js
import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
    collection, query, where, getDocs, addDoc,
    serverTimestamp, deleteDoc, doc, updateDoc,
    setDoc, onSnapshot, orderBy, getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── FIRESTORE HELPERS ─────────────────────────────────────────────
// Recursively removes undefined/NaN values and prevents nested arrays
// (Firestore rejects any array whose element is itself an array).
function sanitizeForFirestore(data) {
  if (Array.isArray(data)) {
    return data
      .map(el => sanitizeForFirestore(el))
      // Firestore does NOT support arrays as direct array elements.
      // Any element that is still an array after processing is corrupt
      // data — drop it rather than letting setDoc() throw.
      .filter(el => !Array.isArray(el));
  }
  if (data !== null && typeof data === 'object') {
    const result = {};
    for (const [key, val] of Object.entries(data)) {
      if (val !== undefined) result[key] = sanitizeForFirestore(val);
    }
    return result;
  }
  // Coerce NaN / Infinity to null so Firestore doesn't reject them.
  if (typeof data === 'number' && !isFinite(data)) return null;
  return data ?? null;
}

// ── GLOBALS ───────────────────────────────────────────────────────
let currentUser      = null;
let currentProject   = null;
let currentUserId    = null;
let currentUserEmail = null;

// ── AUTH ──────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = "login.html"; return; }
    currentUser      = user;
    currentUserId    = user.uid;
    currentUserEmail = user.email;

    loadProjectInfo();
    registerWorkspaceUser();
    loadModules();
    initProtocolsAndUpdates();
});

// ── PROJECT INFO ──────────────────────────────────────────────────
function loadProjectInfo() {
    const urlParams   = new URLSearchParams(window.location.search);
    const projectId   = urlParams.get('project');
    const projectName = urlParams.get('name');

    if (!projectId || !projectName) {
        alert("No project selected!");
        window.location.href = "dashboard.html";
        return;
    }

    currentProject = { id: projectId, name: projectName };
    document.getElementById('project-name').textContent = decodeURIComponent(projectName);
    document.getElementById('im-grid').innerHTML  = '<div class="empty-state">Loading...</div>';
    document.getElementById('fsa-grid').innerHTML = '<div class="empty-state">Loading...</div>';
}

// ── BACK ──────────────────────────────────────────────────────────
document.getElementById('back-btn').addEventListener('click', () => {
    window.location.href = "dashboard.html";
});

// ── CREATE IM ─────────────────────────────────────────────────────
document.getElementById('create-im-btn').addEventListener('click', async () => {
    if (!currentProject || !currentUser) return;
    const title = prompt("Enter name for new Investment Memo:");
    if (!title?.trim()) return;

    try {
        await addDoc(collection(db, "investment-memos"), {
            projectId: currentProject.id,
            userId:    currentUser.uid,
            title:     title.trim(),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });
        loadIMs();
    } catch (err) { console.error("Error creating IM:", err); }
});

// ── CREATE FSA ────────────────────────────────────────────────────
document.getElementById('create-fsa-btn').addEventListener('click', async () => {
    if (!currentProject || !currentUser) return;

    // Fetch domains and entity types
    const [domSnap, entSnap] = await Promise.all([
        getDoc(doc(db, "workspace-config", "domainTemplates")),
        getDoc(doc(db, "workspace-config", "entityTypes"))
    ]);

    const domData = domSnap.data() || {};

    // ── FIX: read .domains (new) with fallback to .templates (old) ──
    const domains     = domData.domains
                     || domData.templates?.map((t, i) => ({ id: t.key || `dom_${i}`, label: t.label }))
                     || [];
    const entityTypes = entSnap.data()?.types || [];

    const backdrop = document.createElement("div");
    backdrop.className = "tb-modal-backdrop";
    backdrop.innerHTML = `
        <div class="tb-modal">
            <h3>New Financial Analysis</h3>

            <div style="margin-bottom:14px">
                <label style="font-size:13px; display:block; margin-bottom:4px;">Name</label>
                <input id="fsa-name-input" type="text"
                       placeholder="e.g. Acme Pvt Ltd FY2025"
                       style="width:100%; padding:8px; border-radius:6px;
                              border:1px solid #444; background:#2a2a3e;
                              color:inherit; font-size:13px;" />
            </div>

            <div style="margin-bottom:14px">
                <label style="font-size:13px; display:block; margin-bottom:4px;">Domain / Industry</label>
                <div>
                    <input id="fsa-domain-search" type="text" placeholder="🔍 Search domains..."
                           style="width:100%; padding:8px; border-radius:6px 6px 0 0;
                                  border:1px solid #444; border-bottom:none; background:#2a2a3e;
                                  color:inherit; font-size:13px; box-sizing:border-box;" />
                    <select id="fsa-domain-select" size="5"
                            style="width:100%; border-radius:0 0 6px 6px;
                                   border:1px solid #444; background:#2a2a3e;
                                   color:inherit; font-size:13px; padding:4px 0; display:block;">
                        ${domains.length
                            ? domains.map(d => `<option value="${d.id}">${d.label}</option>`).join("")
                            : '<option value="">No domains configured — add in Settings</option>'
                        }
                    </select>
                    <button id="fsa-create-domain-btn" type="button"
                            style="margin-top:6px; font-size:12px; color:#a5b4fc;
                                   background:rgba(99,102,241,0.12); border:1px solid rgba(99,102,241,0.3);
                                   border-radius:6px; padding:6px 14px; cursor:pointer; width:100%;">
                        ➕ Create Custom Domain
                    </button>
                </div>
            </div>

            <div style="margin-bottom:20px">
                <label style="font-size:13px; display:block; margin-bottom:4px;">Entity Type</label>
                <select id="fsa-entity-select"
                        style="width:100%; padding:8px; border-radius:6px;
                               border:1px solid #444; background:#2a2a3e;
                               color:inherit; font-size:13px;">
                    ${entityTypes.length
                        ? entityTypes.map(e => `<option value="${e.key}">${e.label}</option>`).join("")
                        : '<option value="">No entity types configured — add in Settings</option>'
                    }
                </select>
            </div>

            <div class="tb-modal-actions">
                <button class="tb-btn-cancel">Cancel</button>
                <button class="tb-btn-save">Create</button>
            </div>
        </div>
    `;

    document.body.appendChild(backdrop);
    backdrop.querySelector("#fsa-name-input").focus();

    // ── Domain search filter ──────────────────────────────────────
    backdrop.querySelector("#fsa-domain-search").addEventListener("input", (e) => {
        const query = e.target.value.toLowerCase();
        backdrop.querySelectorAll("#fsa-domain-select option").forEach(opt => {
            const match = opt.textContent.toLowerCase().includes(query);
            opt.style.display = match ? "" : "none";
        });
    });

    // ── Create custom domain ──────────────────────────────────────
    backdrop.querySelector("#fsa-create-domain-btn").addEventListener("click", async () => {
        const label = prompt("Enter a name for the new domain:");
        if (!label?.trim()) return;

        const newDomain = { id: `dom_${Date.now()}`, label: label.trim() };
        try {
            const domRef  = doc(db, "workspace-config", "domainTemplates");
            const domSnap = await getDoc(domRef);
            const domData = domSnap.data() || {};
            // Normalize existing domains array (guard against Firestore object-as-array)
            const existing = Array.isArray(domData.domains)
              ? domData.domains
              : (domData.domains && typeof domData.domains === 'object' ? Object.values(domData.domains) : []);
            existing.push(newDomain);
            // Full overwrite (no merge) so nested arrays are never corrupted
            await setDoc(domRef, sanitizeForFirestore({ ...domData, domains: existing }));

            const select = backdrop.querySelector("#fsa-domain-select");
            const option = document.createElement("option");
            option.value = newDomain.id;
            option.textContent = newDomain.label;
            select.appendChild(option);
            select.value = newDomain.id;
            backdrop.querySelector("#fsa-domain-search").value = "";
            select.querySelectorAll("option").forEach(o => { o.style.display = ""; });
        } catch (err) {
            alert("Error creating domain: " + err.message);
        }
    });

    backdrop.querySelector(".tb-btn-cancel").addEventListener("click", () => backdrop.remove());
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });

    backdrop.querySelector(".tb-btn-save").addEventListener("click", async () => {
        const name       = backdrop.querySelector("#fsa-name-input").value.trim();
        // For the size="5" select, fall back to first visible option when nothing is selected
        const domSelect  = backdrop.querySelector("#fsa-domain-select");
        const domain     = domSelect.value ||
            Array.from(domSelect.options).find(o => o.style.display !== 'none')?.value || '';
        const entityType = backdrop.querySelector("#fsa-entity-select").value;

        if (!name) { alert("Please enter a name."); return; }

        try {
            // ── FIX: initialise data:{} and years:[] on creation ──────
            // Prevents race condition on first fsa.js load
            await addDoc(
                collection(db, "projects", currentProject.id, "fsa"),
                {
                    title:      name,
                    domain:     domain,
                    entityType: entityType,
                    data:       {},        // pre-initialised
                    years:      [],        // pre-initialised
                    createdAt:  serverTimestamp(),
                    updatedAt:  serverTimestamp(),
                    createdBy:  currentUser.uid
                }
            );
            backdrop.remove();
            loadFSAs();
        } catch (err) { console.error("Error creating FSA:", err); }
    });
});

// ── CREATE FC ─────────────────────────────────────────────────────
document.getElementById("create-fc-btn").addEventListener("click", async () => {
    if (!currentProject || !currentUser) return;
    const title = prompt("Enter name for new First Connect Report:");
    if (!title?.trim()) return;

    try {
        await addDoc(collection(db, "first-connect-reports"), {
            projectId: currentProject.id,
            userId:    currentUser.uid,
            title:     title.trim(),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });
        loadFCs();
    } catch (err) { console.error("Error creating FC:", err); }
});

// ── LOAD MODULES ──────────────────────────────────────────────────
async function loadModules() {
    if (!currentProject) return;
    await Promise.all([loadIMs(), loadFSAs(), loadFCs()]);
}

async function loadIMs() {
    const imGrid = document.getElementById('im-grid');
    try {
        const snap = await getDocs(query(
            collection(db, "investment-memos"),
            where("projectId", "==", currentProject.id)
        ));
        if (snap.empty) { imGrid.innerHTML = '<div class="empty-state">No IMs created yet</div>'; return; }
        imGrid.innerHTML = "";
        snap.forEach(d => imGrid.appendChild(createModuleCard(d.id, d.data(), 'im')));
    } catch (err) { imGrid.innerHTML = '<div class="empty-state">Error loading IMs</div>'; }
}

async function loadFSAs() {
    const fsaGrid = document.getElementById('fsa-grid');
    try {
        // 1. Fetch Workspace Configs to resolve the real names
        const [domSnap, entSnap] = await Promise.all([
            getDoc(doc(db, "workspace-config", "domainTemplates")),
            getDoc(doc(db, "workspace-config", "entityTypes"))
        ]);
        const domData = domSnap.data() || {};
        const domains = domData.domains || domData.templates?.map((t, i) => ({ id: t.key || `dom_${i}`, label: t.label })) || [];
        const domainMap = domains.reduce((acc, d) => ({...acc, [d.id]: d.label}), {});

        const entityTypes = entSnap.data()?.types || [];
        const entityMap = entityTypes.reduce((acc, e) => ({...acc, [e.key]: e.label}), {});

        // 2. Fetch FSAs
        const snap = await getDocs(
            collection(db, "projects", currentProject.id, "fsa")
        );
        if (snap.empty) { fsaGrid.innerHTML = '<div class="empty-state">No FSAs created yet</div>'; return; }
        fsaGrid.innerHTML = "";
        
        snap.forEach(d => {
            const data = d.data();
            // Map the raw IDs to their nice labels
            data.domainLabel = domainMap[data.domain] || data.domain;
            data.entityLabel = entityMap[data.entityType] || data.entityType;
            fsaGrid.appendChild(createModuleCard(d.id, data, 'fsa'));
        });
    } catch (err) { 
        console.error(err); 
        fsaGrid.innerHTML = '<div class="empty-state">Error loading FSAs</div>'; 
    }
}

async function loadFCs() {
    const fcGrid = document.getElementById("fc-grid");
    try {
        const snap = await getDocs(query(
            collection(db, "first-connect-reports"),
            where("projectId", "==", currentProject.id)
        ));
        if (snap.empty) { fcGrid.innerHTML = '<div class="empty-state">No FCs created yet</div>'; return; }
        fcGrid.innerHTML = "";
        snap.forEach(d => fcGrid.appendChild(createModuleCard(d.id, d.data(), 'fc')));
    } catch (err) { fcGrid.innerHTML = '<div class="empty-state">Error loading FCs</div>'; }
}

// ── MODULE CARD ───────────────────────────────────────────────────
function createModuleCard(id, data, type) {
    const card    = document.createElement('div');
    card.className = 'module-card';

    const icon    = type === 'im' ? '📊' : type === 'fsa' ? '📈' : '🔗';
    const created = data.createdAt
        ? new Date(data.createdAt.seconds * 1000).toLocaleDateString('en-IN')
        : 'Unknown';

   // ── FIX: show entity type + domain on FSA cards using resolved labels ──────────────
    const displayEntity = data.entityLabel || data.entityType;
    const displayDomain = data.domainLabel || data.domain;

    const subLine = type === 'fsa' && (displayEntity || displayDomain)
        ? `<small style="color:var(--brand-primary); font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px;">
               ${[displayEntity, displayDomain].filter(Boolean).join(' · ')}
           </small>`
        : '';

    card.innerHTML = `
        <div class="module-icon">${icon}</div>
        <div class="module-info">
            <strong class="module-title">${data.title || 'Untitled'}</strong>
            ${subLine}
            <small>Created: ${created}</small>
        </div>
        <div class="module-actions">
            <button class="rename-btn" data-id="${id}" title="Rename">✏️</button>
            <button class="delete-btn" data-id="${id}" title="Delete">🗑️</button>
        </div>
    `;

    // ── FIX: navigation wired directly — NO nested listeners ─────
    // Old code had addEventListener inside addEventListener which
    // caused a new handler to be added on every click
    card.addEventListener('click', (e) => {
        // Don't navigate if rename/delete was clicked
        if (e.target.closest('.module-actions')) return;

        if (type === 'im') {
            window.location.href =
                `im.html?project=${currentProject.id}&im=${id}&name=${encodeURIComponent(currentProject.name)}`;
        }
        if (type === 'fsa') {
            window.location.href =
                `fsa.html?project=${currentProject.id}&fsa=${id}&name=${encodeURIComponent(currentProject.name)}`;
        }
        if (type === 'fc') {
            window.location.href =
                `fc.html?project=${currentProject.id}&fc=${id}&name=${encodeURIComponent(currentProject.name)}`;
        }
    });

    // ── DELETE ────────────────────────────────────────────────────
    card.querySelector('.delete-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        const label = type === 'im' ? 'Investment Memo'
                    : type === 'fsa' ? 'Financial Analysis'
                    : 'First Connect Report';
        if (!confirm(`Delete this ${label}?`)) return;

        if (type === 'im')  await deleteDoc(doc(db, "investment-memos", id));
        if (type === 'fsa') await deleteDoc(doc(db, "projects", currentProject.id, "fsa", id));
        if (type === 'fc')  await deleteDoc(doc(db, "first-connect-reports", id));

        card.remove();
    });

    // ── RENAME ────────────────────────────────────────────────────
    card.querySelector('.rename-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        const newName = prompt("Enter new name:");
        if (!newName?.trim()) return;

        if (type === 'im')  await updateDoc(doc(db, "investment-memos", id),                             { title: newName.trim(), updatedAt: serverTimestamp() });
        if (type === 'fsa') await updateDoc(doc(db, "projects", currentProject.id, "fsa", id),           { title: newName.trim(), updatedAt: serverTimestamp() });
        if (type === 'fc')  await updateDoc(doc(db, "first-connect-reports", id),                        { title: newName.trim(), updatedAt: serverTimestamp() });

        card.querySelector('.module-title').textContent = newName.trim();
    });

    return card;
}

// ── WORKSPACE USER REGISTRATION ───────────────────────────────────
async function registerWorkspaceUser() {
    const projectName = new URLSearchParams(window.location.search).get('name') || '—';
    const userRef     = doc(db, "workspace-users", currentUserId);

    await setDoc(userRef, {
        userId:      currentUserId,
        email:       currentUserEmail,
        isOnline:    true,
        currentPage: "module-hub",
        currentIM:   { title: projectName },
        lastActive:  serverTimestamp()
    }, { merge: true });

    setInterval(() => updateDoc(userRef, { lastActive: serverTimestamp() }), 30000);
    window.addEventListener("beforeunload", () =>
        updateDoc(userRef, { isOnline: false, lastActive: serverTimestamp() })
    );
}

// ── PROTOCOLS ─────────────────────────────────────────────────────
async function loadProtocols() {
    const list = document.getElementById("protocol-list");

    onSnapshot(
        query(
            collection(db, "projects", currentProject.id, "protocols"),
            orderBy("createdAt", "asc")
        ),
        snap => {
            if (snap.empty) {
                list.innerHTML = '<div class="empty-state-small">No protocols defined</div>';
                return;
            }
            list.innerHTML = "";
            snap.docs.forEach(d => {
                const data = d.data();
                const item = document.createElement("div");
                item.className = `protocol-item ${data.checked ? "checked" : ""}`;
                item.innerHTML = `
                    <input type="checkbox" id="proto-${d.id}" ${data.checked ? "checked" : ""} />
                    <label for="proto-${d.id}">${data.title}</label>
                    <button class="protocol-delete" data-id="${d.id}">✕</button>
                `;
                item.querySelector("input").addEventListener("change", async (e) => {
                    await updateDoc(doc(db, "projects", currentProject.id, "protocols", d.id),
                        { checked: e.target.checked });
                });
                item.querySelector(".protocol-delete").addEventListener("click", async () => {
                    if (!confirm(`Delete protocol "${data.title}"?`)) return;
                    await deleteDoc(doc(db, "projects", currentProject.id, "protocols", d.id));
                });
                list.appendChild(item);
            });
        }
    );
}

function openAddProtocolModal() {
    const backdrop = document.createElement("div");
    backdrop.className = "tb-modal-backdrop";
    backdrop.innerHTML = `
        <div class="tb-modal">
            <h3>Add Protocol</h3>
            <div>
                <label>Protocol Step</label>
                <input id="proto-input" type="text" placeholder="e.g. MCA Verification Done" />
            </div>
            <div class="tb-modal-actions">
                <button class="tb-btn-cancel">Cancel</button>
                <button class="tb-btn-save">Add</button>
            </div>
        </div>
    `;
    document.body.appendChild(backdrop);
    backdrop.querySelector("#proto-input").focus();

    backdrop.querySelector(".tb-btn-cancel").addEventListener("click", () => backdrop.remove());
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
    backdrop.querySelector(".tb-btn-save").addEventListener("click", async () => {
        const title = backdrop.querySelector("#proto-input").value.trim();
        if (!title) return;
        await addDoc(collection(db, "projects", currentProject.id, "protocols"),
            { title, checked: false, createdAt: serverTimestamp() });
        backdrop.remove();
    });
}

// ── UPDATES ───────────────────────────────────────────────────────
function loadUpdates() {
    const feed = document.getElementById("updates-feed");

    onSnapshot(
        query(
            collection(db, "projects", currentProject.id, "updates"),
            orderBy("createdAt", "desc")
        ),
        snap => {
            if (snap.empty) {
                feed.innerHTML = '<div class="empty-state-small">No updates yet</div>';
                return;
            }
            feed.innerHTML = "";
            snap.docs.forEach(d => {
                const data = d.data();
                const ts   = data.createdAt?.toDate?.();
                const time = ts
                    ? ts.toLocaleDateString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
                    : "Just now";
                const item = document.createElement("div");
                item.className = "update-item";
                item.innerHTML = `
                    <span class="update-text">${data.text}</span>
                    <div class="update-meta">
                        <span class="update-author">${data.authorEmail || "—"}</span>
                        <span>${time}</span>
                    </div>
                `;
                feed.appendChild(item);
            });
        }
    );
}

async function postUpdate() {
    const input = document.getElementById("update-input");
    const text  = input.value.trim();
    if (!text) return;
    await addDoc(collection(db, "projects", currentProject.id, "updates"), {
        text,
        authorEmail: currentUser.email,
        authorId:    currentUser.uid,
        createdAt:   serverTimestamp()
    });
    input.value = "";
}

// ── WIRE UP ───────────────────────────────────────────────────────
function initProtocolsAndUpdates() {
    document.getElementById("add-protocol-btn").addEventListener("click", openAddProtocolModal);
    document.getElementById("post-update-btn").addEventListener("click", postUpdate);
    document.getElementById("update-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter") postUpdate();
    });
    loadProtocols();
    loadUpdates();
}

// ── STARFIELD ─────────────────────────────────────────────────────
const canvas = document.getElementById('space-canvas');
const ctx    = canvas.getContext('2d');

canvas.width  = window.innerWidth;
canvas.height = window.innerHeight;
window.addEventListener('resize', () => {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
});

const stars     = Array.from({ length: 150 }, () => ({
    x: Math.random() * canvas.width,  y: Math.random() * canvas.height,
    size: Math.random() * 2 + 0.5,    speedX: (Math.random() - 0.5) * 0.3,
    speedY: (Math.random() - 0.5) * 0.3, opacity: Math.random() * 0.5 + 0.3
}));

const asteroids = Array.from({ length: 8 }, () => ({
    x: Math.random() * canvas.width,  y: Math.random() * canvas.height,
    size: Math.random() * 4 + 3,      speedX: (Math.random() - 0.5) * 0.15,
    speedY: (Math.random() - 0.5) * 0.15, opacity: Math.random() * 0.3 + 0.2,
    color: Math.random() > 0.5 ? 'rgba(185,28,28,' : 'rgba(100,150,200,'
}));

function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    stars.forEach(s => {
        ctx.fillStyle = `rgba(255,255,255,${s.opacity})`;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2); ctx.fill();
        s.x = (s.x + s.speedX + canvas.width)  % canvas.width;
        s.y = (s.y + s.speedY + canvas.height) % canvas.height;
    });

    asteroids.forEach(a => {
        ctx.shadowBlur  = 15;
        ctx.shadowColor = a.color + '0.5)';
        ctx.fillStyle   = a.color + a.opacity + ')';
        ctx.beginPath(); ctx.arc(a.x, a.y, a.size, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur  = 0;
        a.x = (a.x + a.speedX + canvas.width)  % canvas.width;
        a.y = (a.y + a.speedY + canvas.height) % canvas.height;
    });

    requestAnimationFrame(animate);
}

animate();
