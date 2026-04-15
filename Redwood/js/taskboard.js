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
  getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── STATE ────────────────────────────────────────────────
let columns      = [];
let tasks        = [];
let allUsers     = [];
let dragCardId   = null;
let dragColId    = null;
let filterUser   = '';
let searchQuery  = '';

// ── INIT ─────────────────────────────────────────────────
export function initTaskBoard() {
  const openBtn   = document.getElementById("taskboard-btn");
  const closeBtn  = document.getElementById("taskboard-close");
  const overlay   = document.getElementById("taskboard-overlay");
  const addColBtn = document.getElementById("add-column-btn");

  openBtn.addEventListener("click", () => {
    overlay.classList.remove("hidden");
    startListeners();
  });

  closeBtn.addEventListener("click", () => {
    overlay.classList.add("hidden");
  });

  addColBtn.addEventListener("click", () => openColumnModal());
}

// ── LISTENERS ────────────────────────────────────────────
let unsubColumns = null;
let unsubTasks   = null;

function startListeners() {
  if (unsubColumns) return;

  loadAllUsers();

  unsubColumns = onSnapshot(
    query(collection(db, "taskboard-columns"), orderBy("order", "asc")),
    snap => {
      columns = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderBoard();
    }
  );

  unsubTasks = onSnapshot(
    query(collection(db, "tasks"), orderBy("order", "asc")),
    snap => {
      tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderBoard();
    }
  );
}

async function loadAllUsers() {
  const snap = await getDocs(collection(db, "workspace-users"));
  allUsers = snap.docs.map(d => ({ userId: d.id, ...d.data() }));
  // Re-render filter bar with users populated
  const bar = document.getElementById("tb-filter-bar");
  if (bar) renderFilterBar();
}

// ── RENDER BOARD ─────────────────────────────────────────
function renderBoard() {
  const container = document.getElementById("columns-container");
  container.innerHTML = "";

  // Render filter bar above columns
  renderFilterBar();

  columns.forEach(col => {
    const colTasks = tasks
      .filter(t => t.columnId === col.id)
      .sort((a, b) => a.order - b.order);
    container.appendChild(buildColumnEl(col, colTasks));
  });

  attachColumnDrag();

  // Apply active filters after render
  if (filterUser || searchQuery) filterBoardOnly();
}

// ── FILTER BAR ───────────────────────────────────────────
function renderFilterBar() {
  const existing = document.getElementById("tb-filter-bar");
  if (existing) existing.remove();

  const bar = document.createElement("div");
  bar.id = "tb-filter-bar";
  bar.className = "hub-filter-bar";

  const userOptions = allUsers.map(u =>
    `<option value="${u.userId}" ${filterUser === u.userId ? 'selected' : ''}>${u.email}</option>`
  ).join('');

  bar.innerHTML = `
    <div class="hub-filter-group">
      <span class="hub-filter-label">🔍</span>
      <input
        id="tb-search-input"
        class="hub-filter-input"
        type="text"
        placeholder="Search cards..."
        value="${searchQuery}"
      />
    </div>
    <div class="hub-filter-group">
      <span class="hub-filter-label">👤</span>
      <select id="tb-user-filter" class="hub-filter-select">
        <option value="">All Members</option>
        ${userOptions}
      </select>
    </div>
    ${filterUser || searchQuery
      ? `<button id="tb-clear-filters" class="hub-clear-btn">✕ Clear</button>`
      : ''}
  `;

  const container = document.getElementById("columns-container");
  container.parentElement.insertBefore(bar, container);

  // Search — no re-render, just hide/show cards
  bar.querySelector("#tb-search-input").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    filterBoardOnly();
  });

  // Assignee filter
  bar.querySelector("#tb-user-filter").addEventListener("change", (e) => {
    filterUser = e.target.value;
    filterBoardOnly();
  });

  // Clear button
  const clearBtn = bar.querySelector("#tb-clear-filters");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      filterUser  = '';
      searchQuery = '';
      bar.querySelector("#tb-search-input").value = '';
      bar.querySelector("#tb-user-filter").value  = '';
      filterBoardOnly();
    });
  }
}

// ── FILTER WITHOUT RE-RENDER ──────────────────────────────
function filterBoardOnly() {
  columns.forEach(col => {
    const cardsEl = document.querySelector(`.tb-cards[data-col-id="${col.id}"]`);
    const countEl = document.querySelector(`.tb-column[data-col-id="${col.id}"] .tb-col-count`);
    if (!cardsEl) return;

    const colTasks = tasks.filter(t => t.columnId === col.id);
    let visibleCount = 0;

    colTasks.forEach(t => {
      const cardEl = cardsEl.querySelector(`.tb-card[data-card-id="${t.id}"]`);
      if (!cardEl) return;

      const matchSearch = !searchQuery ||
        t.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.description?.toLowerCase().includes(searchQuery.toLowerCase());

      const matchUser = !filterUser ||
        (t.assignedTo || []).includes(filterUser);

      const visible = matchSearch && matchUser;
      cardEl.style.display = visible ? '' : 'none';
      if (visible) visibleCount++;
    });

    if (countEl) countEl.textContent = visibleCount;
  });

  // Toggle clear button
  const bar = document.getElementById("tb-filter-bar");
  if (!bar) return;
  let clearBtn = document.getElementById("tb-clear-filters");
  if (filterUser || searchQuery) {
    if (!clearBtn) {
      clearBtn = document.createElement("button");
      clearBtn.id = "tb-clear-filters";
      clearBtn.className = "hub-clear-btn";
      clearBtn.textContent = "✕ Clear";
      clearBtn.addEventListener("click", () => {
        filterUser  = '';
        searchQuery = '';
        document.getElementById("tb-search-input").value = '';
        document.getElementById("tb-user-filter").value  = '';
        filterBoardOnly();
      });
      bar.appendChild(clearBtn);
    }
  } else {
    if (clearBtn) clearBtn.remove();
  }
}

// ── BUILD COLUMN ──────────────────────────────────────────
function buildColumnEl(col, colTasks) {
  const el = document.createElement("div");
  el.className     = "tb-column";
  el.dataset.colId = col.id;
  el.draggable     = true;

  el.innerHTML = `
    <div class="tb-col-header">
      <span class="tb-col-title" title="Click to rename">${col.title}</span>
      <span class="tb-col-count">${colTasks.length}</span>
      <button class="tb-col-delete" title="Delete column">✕</button>
    </div>
    <div class="tb-cards" data-col-id="${col.id}"></div>
    <button class="tb-add-card-btn">+ Add Card</button>
  `;

  const cardsEl = el.querySelector(".tb-cards");
  colTasks.forEach(t => cardsEl.appendChild(buildCardEl(t)));

  el.querySelector(".tb-col-title").addEventListener("click", (e) => {
    e.stopPropagation();
    openColumnModal(col);
  });

  el.querySelector(".tb-col-delete").addEventListener("click", (e) => {
    e.stopPropagation();
    deleteColumn(col);
  });

  el.querySelector(".tb-add-card-btn").addEventListener("click", () => {
    openCardModal(col.id);
  });

  attachCardDropZone(cardsEl);
  return el;
}

// ── BUILD CARD ────────────────────────────────────────────
function buildCardEl(task) {
  const el = document.createElement("div");
  el.className      = "tb-card";
  el.draggable      = true;
  el.dataset.cardId = task.id;

  const avatars = (task.assignedEmails || []).map(email => {
    const initials = email.substring(0, 2).toUpperCase();
    return `<div class="tb-avatar" title="${email}">${initials}</div>`;
  }).join("");

  let dueBadge = "";
  if (task.dueDate) {
    const today   = new Date(); today.setHours(0,0,0,0);
    const due     = new Date(task.dueDate);
    const overdue = due < today;
    const dueFmt  = due.toLocaleDateString("en-IN", { day:"numeric", month:"short" });
    dueBadge = `<span class="tb-due ${overdue ? 'overdue' : ''}" title="Due date">📅 ${dueFmt}</span>`;
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
          <button class="tb-edit-btn" title="Edit">✏️</button>
          <button class="tb-delete-btn" title="Delete">🗑️</button>
        </div>
      </div>
    </div>
  `;

  el.querySelector(".tb-edit-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    openCardModal(task.columnId, task);
  });

  el.querySelector(".tb-delete-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm("Delete this card?")) return;
    await deleteDoc(doc(db, "tasks", task.id));
  });

  el.addEventListener("dragstart", (e) => {
    dragCardId = task.id;
    dragColId  = null;
    setTimeout(() => el.classList.add("dragging-card"), 0);
    e.stopPropagation();
  });

  el.addEventListener("dragend", () => {
    el.classList.remove("dragging-card");
    dragCardId = null;
  });

  return el;
}

// ── CARD DROP ZONE ────────────────────────────────────────
function attachCardDropZone(cardsEl) {
  cardsEl.addEventListener("dragover", (e) => {
    if (!dragCardId) return;
    e.preventDefault();
    e.stopPropagation();
    cardsEl.classList.add("drag-over-cards");
    const afterEl  = getDragAfterElement(cardsEl, e.clientY);
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
    if (!dragCardId) return;
    const newColId = cardsEl.dataset.colId;
    const cardEls  = [...cardsEl.querySelectorAll(".tb-card")];
    for (let i = 0; i < cardEls.length; i++) {
      await updateDoc(doc(db, "tasks", cardEls[i].dataset.cardId), {
        columnId: newColId, order: i, updatedAt: serverTimestamp()
      });
    }
  });
}

function getDragAfterElement(container, y) {
  const draggables = [...container.querySelectorAll(".tb-card:not(.dragging-card)")];
  return draggables.reduce((closest, child) => {
    const box    = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return { offset, element: child };
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// ── COLUMN DRAG ───────────────────────────────────────────
function attachColumnDrag() {
  document.querySelectorAll(".tb-column").forEach(col => {
    col.addEventListener("dragstart", (e) => {
      if (dragCardId) return;
      dragColId = col.dataset.colId;
      setTimeout(() => col.classList.add("dragging-col"), 0);
    });

    col.addEventListener("dragend", () => {
      col.classList.remove("dragging-col");
      dragColId = null;
      saveColumnOrder();
    });

    col.addEventListener("dragover", (e) => {
      if (!dragColId || dragCardId) return;
      e.preventDefault();
      const dragging = document.querySelector(".dragging-col");
      if (!dragging || dragging === col) return;
      const container = document.getElementById("columns-container");
      const allCols   = [...container.querySelectorAll(".tb-column:not(.dragging-col)")];
      const afterEl   = allCols.find(c => {
        const box = c.getBoundingClientRect();
        return e.clientX < box.left + box.width / 2;
      });
      if (afterEl) container.insertBefore(dragging, afterEl);
      else container.insertBefore(dragging, document.getElementById("add-column-btn"));
    });
  });
}

async function saveColumnOrder() {
  const colEls = [...document.querySelectorAll(".tb-column")];
  for (let i = 0; i < colEls.length; i++) {
    await updateDoc(doc(db, "taskboard-columns", colEls[i].dataset.colId), { order: i });
  }
}

// ── COLUMN MODAL ──────────────────────────────────────────
function openColumnModal(existing = null) {
  const backdrop = document.createElement("div");
  backdrop.className = "tb-modal-backdrop";

  backdrop.innerHTML = `
    <div class="tb-modal">
      <h3>${existing ? "Rename Column" : "Add Column"}</h3>
      <div>
        <label>Column Name</label>
        <input id="tb-col-name-input" type="text"
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
  backdrop.querySelector("#tb-col-name-input").focus();

  backdrop.querySelector(".tb-btn-cancel").addEventListener("click", () => backdrop.remove());

  backdrop.querySelector(".tb-btn-save").addEventListener("click", async () => {
    const title = backdrop.querySelector("#tb-col-name-input").value.trim();
    if (!title) return;
    if (existing) {
      await updateDoc(doc(db, "taskboard-columns", existing.id), { title });
    } else {
      await addDoc(collection(db, "taskboard-columns"), {
        title, order: columns.length, createdAt: serverTimestamp()
      });
    }
    backdrop.remove();
  });

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
}

// ── DELETE COLUMN ─────────────────────────────────────────
async function deleteColumn(col) {
  const colTasks = tasks.filter(t => t.columnId === col.id);
  if (colTasks.length > 0) {
    if (!confirm(`"${col.title}" has ${colTasks.length} card(s). Delete all too?`)) return;
    for (const t of colTasks) await deleteDoc(doc(db, "tasks", t.id));
  } else {
    if (!confirm(`Delete column "${col.title}"?`)) return;
  }
  await deleteDoc(doc(db, "taskboard-columns", col.id));
}

// ── CARD MODAL ────────────────────────────────────────────
function openCardModal(columnId, existing = null) {
  const backdrop = document.createElement("div");
  backdrop.className = "tb-modal-backdrop";

  const assigneeHtml = allUsers.map(u => `
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
        <input id="tb-card-title" type="text"
          placeholder="Card title..."
          value="${existing?.title || ''}"/>
      </div>
      <div>
        <label>Description</label>
        <textarea id="tb-card-desc"
          placeholder="Optional description...">${existing?.description || ''}</textarea>
      </div>
      <div>
        <label>Priority</label>
        <select id="tb-card-priority">
          <option value="low"    ${existing?.priority === 'low'    ? 'selected':''}>🟢 Low</option>
          <option value="medium" ${existing?.priority === 'medium' ? 'selected':''}>🟡 Medium</option>
          <option value="high"   ${existing?.priority === 'high'   ? 'selected':''}>🔴 High</option>
        </select>
      </div>
      <div>
        <label>Due Date</label>
        <input id="tb-card-due" type="date" value="${existing?.dueDate || ''}"/>
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
  backdrop.querySelector("#tb-card-title").focus();

  backdrop.querySelector(".tb-btn-cancel").addEventListener("click", () => backdrop.remove());

  backdrop.querySelector(".tb-btn-save").addEventListener("click", async () => {
    const title = backdrop.querySelector("#tb-card-title").value.trim();
    if (!title) return;

    const desc     = backdrop.querySelector("#tb-card-desc").value.trim();
    const priority = backdrop.querySelector("#tb-card-priority").value;
    const dueDate  = backdrop.querySelector("#tb-card-due").value;

    const checked        = [...backdrop.querySelectorAll(".tb-assignee-list input:checked")];
    const assignedTo     = checked.map(c => c.value);
    const assignedEmails = checked.map(c => c.dataset.email);

    if (existing) {
      await updateDoc(doc(db, "tasks", existing.id), {
        title, description: desc, priority, dueDate,
        assignedTo, assignedEmails, updatedAt: serverTimestamp()
      });
    } else {
      const colTasks = tasks.filter(t => t.columnId === columnId);
      await addDoc(collection(db, "tasks"), {
        title, description: desc, priority, dueDate,
        assignedTo, assignedEmails,
        columnId,
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

// ── BOOT ─────────────────────────────────────────────────
initTaskBoard();
