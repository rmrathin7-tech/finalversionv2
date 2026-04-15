import { db } from "./firebase.js";
import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy,
  where,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── STATE ─────────────────────────────────────────────────
let hubColumns    = [];
let hubTasks      = [];
let hubAllUsers   = [];
let hubProjectId  = null;
let hubDragCardId = null;
let hubDragColId  = null;

let unsubHubColumns = null;
let unsubHubTasks   = null;

// ── INIT ──────────────────────────────────────────────────
function initHubTaskBoard(projectId, projectName) {
  hubProjectId = projectId;

  const openBtn   = document.getElementById("hub-taskboard-btn");
  const closeBtn  = document.getElementById("hub-taskboard-close");
  const overlay   = document.getElementById("hub-taskboard-overlay");
  const addColBtn = document.getElementById("hub-add-column-btn");
  const titleEl   = document.getElementById("hub-tb-project-name");

  if (titleEl) titleEl.textContent = projectName || "";

  openBtn.addEventListener("click", () => {
    overlay.classList.remove("hidden");
    startHubListeners();
  });

  closeBtn.addEventListener("click", () => {
    overlay.classList.add("hidden");
  });

  addColBtn.addEventListener("click", () => openHubColumnModal());
}

// ── LISTENERS ─────────────────────────────────────────────
function startHubListeners() {
  if (unsubHubColumns) return;

  loadHubUsers();

  // columns scoped to this project — NO orderBy to avoid index requirement
  unsubHubColumns = onSnapshot(
    query(
      collection(db, "taskboard-columns"),
      where("projectId", "==", hubProjectId)
    ),
    snap => {
      hubColumns = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      renderHubBoard();
    }
  );

  // tasks scoped to this project — NO orderBy
  unsubHubTasks = onSnapshot(
    query(
      collection(db, "tasks"),
      where("projectId", "==", hubProjectId)
    ),
    snap => {
      hubTasks = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      renderHubBoard();
    }
  );
}

async function loadHubUsers() {
  const snap = await getDocs(collection(db, "workspace-users"));
  hubAllUsers = snap.docs.map(d => ({ userId: d.id, ...d.data() }));
}

// ── RENDER BOARD ──────────────────────────────────────────
// ── FILTER STATE ──────────────────────────────────────────
let hubFilterUser  = '';
let hubSearchQuery = '';

// ── RENDER BOARD ──────────────────────────────────────────
function renderHubBoard() {
  const container = document.getElementById("hub-columns-container");
  container.innerHTML = "";

  renderHubFilters(); // render filter bar

  hubColumns.forEach(col => {
    const colTasks = hubTasks
      .filter(t => t.columnId === col.id)
      .filter(t => {
        const matchSearch = !hubSearchQuery ||
          t.title?.toLowerCase().includes(hubSearchQuery.toLowerCase()) ||
          t.description?.toLowerCase().includes(hubSearchQuery.toLowerCase());

        const matchUser = !hubFilterUser ||
          (t.assignedTo || []).includes(hubFilterUser);

        return matchSearch && matchUser;
      })
      .sort((a, b) => a.order - b.order);

    container.appendChild(buildHubColumnEl(col, colTasks));
  });

  attachHubColumnDrag();
}

// ── FILTER BAR ────────────────────────────────────────────
function renderHubFilters() {
  const existing = document.getElementById("hub-filter-bar");
  if (existing) existing.remove();

  const bar = document.createElement("div");
  bar.id = "hub-filter-bar";
  bar.className = "hub-filter-bar";

  // Build assignee options
  const userOptions = hubAllUsers.map(u =>
    `<option value="${u.userId}" ${hubFilterUser === u.userId ? 'selected' : ''}>
      ${u.email}
    </option>`
  ).join('');

  bar.innerHTML = `
    <div class="hub-filter-group">
      <span class="hub-filter-label">🔍</span>
      <input
        id="hub-search-input"
        class="hub-filter-input"
        type="text"
        placeholder="Search cards..."
        value="${hubSearchQuery}"
      />
    </div>
    <div class="hub-filter-group">
      <span class="hub-filter-label">👤</span>
      <select id="hub-user-filter" class="hub-filter-select">
        <option value="">All Members</option>
        ${userOptions}
      </select>
    </div>
    ${hubFilterUser || hubSearchQuery ? `
      <button id="hub-clear-filters" class="hub-clear-btn">✕ Clear</button>
    ` : ''}
  `;

  // Insert ABOVE the columns container
  const container = document.getElementById("hub-columns-container");
  container.parentElement.insertBefore(bar, container);

  // Events
bar.querySelector("#hub-search-input").addEventListener("input", (e) => {
  hubSearchQuery = e.target.value;
  filterHubBoardOnly(); // ← don't re-render whole board
});


 bar.querySelector("#hub-user-filter").addEventListener("change", (e) => {
  hubFilterUser = e.target.value;
  filterHubBoardOnly(); // ← same fix
});

  const clearBtn = bar.querySelector("#hub-clear-filters");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      hubFilterUser  = '';
      hubSearchQuery = '';
      renderHubBoard();
    });
  }
}


// ── BUILD COLUMN ──────────────────────────────────────────
function buildHubColumnEl(col, colTasks) {
  const el = document.createElement("div");
  el.className     = "tb-column";
  el.dataset.colId = col.id;
  el.draggable     = true;

  el.innerHTML = `
    <div class="tb-col-header">
      <span class="tb-col-title">${col.title}</span>
      <span class="tb-col-count">${colTasks.length}</span>
      <button class="tb-col-delete">✕</button>
    </div>
    <div class="tb-cards" data-col-id="${col.id}"></div>
    <button class="tb-add-card-btn">+ Add Card</button>
  `;

  const cardsEl = el.querySelector(".tb-cards");
  colTasks.forEach(t => cardsEl.appendChild(buildHubCardEl(t)));

  el.querySelector(".tb-col-title").addEventListener("click", (e) => {
    e.stopPropagation();
    openHubColumnModal(col);
  });

  el.querySelector(".tb-col-delete").addEventListener("click", (e) => {
    e.stopPropagation();
    deleteHubColumn(col);
  });

  el.querySelector(".tb-add-card-btn").addEventListener("click", () => {
    openHubCardModal(col.id);
  });

  attachHubCardDropZone(cardsEl);

  return el;
}

// ── BUILD CARD ─────────────────────────────────────────────
function buildHubCardEl(task) {
  const el = document.createElement("div");
  el.className      = "tb-card";
  el.draggable      = true;
  el.dataset.cardId = task.id;

  const avatars = (task.assignedEmails || []).map(email => {
    const initials = email.substring(0, 2).toUpperCase();
    return `<div class="tb-avatar" title="${email}">${initials}</div>`;
  }).join("");

  // due date badge
  let dueBadge = "";
  if (task.dueDate) {
    const today    = new Date();
    today.setHours(0,0,0,0);
    const due      = new Date(task.dueDate);
    const overdue  = due < today;
    const dueFmt   = due.toLocaleDateString("en-IN", { day:"numeric", month:"short" });
    dueBadge = `
      <span class="tb-due ${overdue ? 'overdue' : ''}" title="Due date">
        📅 ${dueFmt}
      </span>`;
  }

  el.innerHTML = `
    <div class="tb-card-title">${task.title}</div>
    ${task.description ? `<div class="tb-card-desc">${task.description}</div>` : ""}
    ${dueBadge}
    <div class="tb-card-footer">
      <div class="tb-assignees">${avatars}</div>
      <div style="display:flex;align-items:center;gap:6px;">
        <span class="tb-priority ${task.priority || 'low'}">${task.priority || 'low'}</span>
        <div class="tb-card-actions">
          <button class="tb-edit-btn">✏️</button>
          <button class="tb-delete-btn">🗑️</button>
        </div>
      </div>
    </div>
  `;

  el.querySelector(".tb-edit-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    openHubCardModal(task.columnId, task);
  });

  el.querySelector(".tb-delete-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm("Delete this card?")) return;
    await deleteDoc(doc(db, "tasks", task.id));
  });

  el.addEventListener("dragstart", (e) => {
    hubDragCardId = task.id;
    hubDragColId  = null;
    setTimeout(() => el.classList.add("dragging-card"), 0);
    e.stopPropagation();
  });

  el.addEventListener("dragend", () => {
    el.classList.remove("dragging-card");
    hubDragCardId = null;
  });

  return el;
}

// ── CARD DROP ZONE ─────────────────────────────────────────
function attachHubCardDropZone(cardsEl) {
  cardsEl.addEventListener("dragover", (e) => {
    if (!hubDragCardId) return;
    e.preventDefault();
    e.stopPropagation();
    cardsEl.classList.add("drag-over-cards");

    const afterEl  = getHubDragAfterElement(cardsEl, e.clientY);
    const dragging = document.querySelector(".dragging-card");
    if (!dragging) return;
    if (!afterEl) cardsEl.appendChild(dragging);
    else cardsEl.insertBefore(dragging, afterEl);
  });

  cardsEl.addEventListener("dragleave", () => {
    cardsEl.classList.remove("drag-over-cards");
  });

  cardsEl.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    cardsEl.classList.remove("drag-over-cards");
    if (!hubDragCardId) return;

    const newColId = cardsEl.dataset.colId;
    const cardEls  = [...cardsEl.querySelectorAll(".tb-card")];

    for (let i = 0; i < cardEls.length; i++) {
      await updateDoc(doc(db, "tasks", cardEls[i].dataset.cardId), {
        columnId:  newColId,
        order:     i,
        updatedAt: serverTimestamp()
      });
    }
  });
}

function getHubDragAfterElement(container, y) {
  const draggables = [...container.querySelectorAll(".tb-card:not(.dragging-card)")];
  return draggables.reduce((closest, child) => {
    const box    = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset, element: child };
    }
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// ── COLUMN DRAG ────────────────────────────────────────────
function attachHubColumnDrag() {
  document.querySelectorAll("#hub-columns-container .tb-column").forEach(col => {
    col.addEventListener("dragstart", (e) => {
      if (hubDragCardId) return;
      hubDragColId = col.dataset.colId;
      setTimeout(() => col.classList.add("dragging-col"), 0);
    });

    col.addEventListener("dragend", () => {
      col.classList.remove("dragging-col");
      hubDragColId = null;
      saveHubColumnOrder();
    });

    col.addEventListener("dragover", (e) => {
      if (!hubDragColId || hubDragCardId) return;
      e.preventDefault();
      const dragging = document.querySelector(".dragging-col");
      if (!dragging || dragging === col) return;

      const container = document.getElementById("hub-columns-container");
      const allCols   = [...container.querySelectorAll(".tb-column:not(.dragging-col)")];
      const afterEl   = allCols.find(c => {
        const box = c.getBoundingClientRect();
        return e.clientX < box.left + box.width / 2;
      });

      if (afterEl) container.insertBefore(dragging, afterEl);
      else container.insertBefore(dragging, document.getElementById("hub-add-column-btn"));
    });
  });
}

async function saveHubColumnOrder() {
  const colEls = [...document.querySelectorAll("#hub-columns-container .tb-column")];
  for (let i = 0; i < colEls.length; i++) {
    await updateDoc(doc(db, "taskboard-columns", colEls[i].dataset.colId), { order: i });
  }
}

// ── COLUMN MODAL ───────────────────────────────────────────
function openHubColumnModal(existing = null) {
  const backdrop = document.createElement("div");
  backdrop.className = "tb-modal-backdrop";

  backdrop.innerHTML = `
    <div class="tb-modal">
      <h3>${existing ? "Rename Column" : "Add Column"}</h3>
      <div>
        <label>Column Name</label>
        <input id="hub-col-name-input" type="text"
          placeholder="e.g. In Progress"
          value="${existing?.title || ''}"/>
      </div>
      <div class="tb-modal-actions">
        <button class="tb-btn-cancel">Cancel</button>
        <button class="tb-btn-save">${existing ? "Save" : "Add"}</button>
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);
  backdrop.querySelector("#hub-col-name-input").focus();

  backdrop.querySelector(".tb-btn-cancel").addEventListener("click", () => backdrop.remove());

  backdrop.querySelector(".tb-btn-save").addEventListener("click", async () => {
    const title = backdrop.querySelector("#hub-col-name-input").value.trim();
    if (!title) return;

    if (existing) {
      await updateDoc(doc(db, "taskboard-columns", existing.id), { title });
    } else {
      await addDoc(collection(db, "taskboard-columns"), {
        title,
        order:     hubColumns.length,  // now safe because hubColumns is populated by snapshot
        projectId: hubProjectId,
        createdAt: serverTimestamp()
        });

    }
    backdrop.remove();
  });

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
}

// ── DELETE COLUMN ──────────────────────────────────────────
async function deleteHubColumn(col) {
  const colTasks = hubTasks.filter(t => t.columnId === col.id);
  if (colTasks.length > 0) {
    if (!confirm(`"${col.title}" has ${colTasks.length} card(s). Delete all too?`)) return;
    for (const t of colTasks) await deleteDoc(doc(db, "tasks", t.id));
  } else {
    if (!confirm(`Delete column "${col.title}"?`)) return;
  }
  await deleteDoc(doc(db, "taskboard-columns", col.id));
}

// ── CARD MODAL ─────────────────────────────────────────────
function openHubCardModal(columnId, existing = null) {
  const backdrop = document.createElement("div");
  backdrop.className = "tb-modal-backdrop";

  const assigneeHtml = hubAllUsers.map(u => `
    <label class="tb-assignee-option">
      <input type="checkbox" value="${u.userId}" data-email="${u.email}"
        ${(existing?.assignedTo || []).includes(u.userId) ? "checked" : ""}/>
      ${u.email}
    </label>`).join("");

  backdrop.innerHTML = `
    <div class="tb-modal">
      <h3>${existing ? "Edit Card" : "Add Card"}</h3>

      <div>
        <label>Title</label>
        <input id="hub-card-title" type="text"
          placeholder="Card title..."
          value="${existing?.title || ''}"/>
      </div>

      <div>
        <label>Description</label>
        <textarea id="hub-card-desc"
          placeholder="Optional description...">${existing?.description || ''}</textarea>
      </div>

      <div>
        <label>Priority</label>
        <select id="hub-card-priority">
          <option value="low"    ${existing?.priority === 'low'    ? 'selected':''}>🟢 Low</option>
          <option value="medium" ${existing?.priority === 'medium' ? 'selected':''}>🟡 Medium</option>
          <option value="high"   ${existing?.priority === 'high'   ? 'selected':''}>🔴 High</option>
        </select>
      </div>

      <div>
        <label>Due Date</label>
        <input id="hub-card-due" type="date" value="${existing?.dueDate || ''}"/>
      </div>

      <div>
        <label>Assign To</label>
        <div class="tb-assignee-list">
          ${assigneeHtml || '<small style="color:#64748b;">No users found</small>'}
        </div>
      </div>

      <div class="tb-modal-actions">
        <button class="tb-btn-cancel">Cancel</button>
        <button class="tb-btn-save">${existing ? "Save" : "Add"}</button>
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);
  backdrop.querySelector("#hub-card-title").focus();

  backdrop.querySelector(".tb-btn-cancel").addEventListener("click", () => backdrop.remove());

  backdrop.querySelector(".tb-btn-save").addEventListener("click", async () => {
    const title    = backdrop.querySelector("#hub-card-title").value.trim();
    if (!title) return;

    const desc     = backdrop.querySelector("#hub-card-desc").value.trim();
    const priority = backdrop.querySelector("#hub-card-priority").value;
    const dueDate  = backdrop.querySelector("#hub-card-due").value;

    const checked        = [...backdrop.querySelectorAll(".tb-assignee-list input:checked")];
    const assignedTo     = checked.map(c => c.value);
    const assignedEmails = checked.map(c => c.dataset.email);

    if (existing) {
      await updateDoc(doc(db, "tasks", existing.id), {
        title, description: desc, priority, dueDate,
        assignedTo, assignedEmails,
        updatedAt: serverTimestamp()
      });
    } else {
      const colTasks = hubTasks.filter(t => t.columnId === columnId);
      await addDoc(collection(db, "tasks"), {
        title, description: desc, priority, dueDate,
        assignedTo, assignedEmails,
        columnId,
        projectId: hubProjectId,
        order:     colTasks.length,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    }

    backdrop.remove();
  });

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
}
// ── AUTO INIT FROM URL ────────────────────────────────────
const _params      = new URLSearchParams(window.location.search);
const _projectId   = _params.get('project');
const _projectName = decodeURIComponent(_params.get('name') || '');

if (_projectId) {
  initHubTaskBoard(_projectId, _projectName);
}

// ── FILTER WITHOUT RE-RENDER ──────────────────────────────
function filterHubBoardOnly() {
  hubColumns.forEach(col => {
    const cardsEl = document.querySelector(`.tb-cards[data-col-id="${col.id}"]`);
    const countEl = document.querySelector(`.tb-column[data-col-id="${col.id}"] .tb-col-count`);
    if (!cardsEl) return;

    const colTasks = hubTasks.filter(t => t.columnId === col.id);
    let visibleCount = 0;

    colTasks.forEach(t => {
      const cardEl = cardsEl.querySelector(`.tb-card[data-card-id="${t.id}"]`);
      if (!cardEl) return;

      const matchSearch = !hubSearchQuery ||
        t.title?.toLowerCase().includes(hubSearchQuery.toLowerCase()) ||
        t.description?.toLowerCase().includes(hubSearchQuery.toLowerCase());

      const matchUser = !hubFilterUser ||
        (t.assignedTo || []).includes(hubFilterUser);

      const visible = matchSearch && matchUser;
      cardEl.style.display = visible ? '' : 'none';
      if (visible) visibleCount++;
    });

    if (countEl) countEl.textContent = visibleCount;
  });

  // Show/hide clear button
  const clearBtn = document.getElementById("hub-clear-filters");
  if (hubFilterUser || hubSearchQuery) {
    if (!clearBtn) {
      const btn = document.createElement("button");
      btn.id = "hub-clear-filters";
      btn.className = "hub-clear-btn";
      btn.textContent = "✕ Clear";
      btn.addEventListener("click", () => {
        hubFilterUser = '';
        hubSearchQuery = '';
        document.getElementById("hub-search-input").value = '';
        document.getElementById("hub-user-filter").value = '';
        filterHubBoardOnly();
      });
      document.getElementById("hub-filter-bar").appendChild(btn);
    }
  } else {
    if (clearBtn) clearBtn.remove();
  }
}
