import { auth, db} from "./firebase.js";

import {
    getFirestore, // firestore database
    collection,
    addDoc,
    getDocs,
    deleteDoc,
    doc,
    serverTimestamp,
    query,
    where,
    orderBy,
    onSnapshot,
    updateDoc,
    setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { onAuthStateChanged, signOut }
    from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// DOM
const projectList = document.getElementById("project-list");
const createBtn = document.getElementById("create-project-btn");
const projectInput = document.getElementById("new-project-name");
const logoutBtn = document.getElementById("logout-btn");

let currentUser = null;
let currentUserId = null;
let currentUserEmail = null;

// Reduce effects during scroll
let scrollTimeout;
const mainArea = document.querySelector('.main-area');

if (mainArea) {
    mainArea.addEventListener('scroll', () => {
        document.body.classList.add('scrolling');
        
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            document.body.classList.remove('scrolling');
        }, 150);
    }, { passive: true });
}

// Auth check
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = "login.html";
        return;
    }

    currentUser = user;
    currentUserId = user.uid;
currentUserEmail = user.email;

await registerWorkspaceUser();
listenToUsersPanel();


    loadProjects();
    loadArchived();
});

// Create project
createBtn.addEventListener("click", async () => {
    const name = projectInput.value.trim();
    if (!name) return;

    await addDoc(collection(db, "projects"), {
        name: name,
        //owner: currentUser.uid, - removed it for collaborative workspace. if we want to see who created it we can add this back.
        createdAt: serverTimestamp(),
        archived: false
    });

    projectInput.value = "";
});

// Load projects
// Load active projects
async function loadProjects() {
    const q = query(
        collection(db, "projects"),
        where("archived", "==", false),
        orderBy("createdAt", "desc")
    );

    onSnapshot(q, (snapshot) => {
        // Store full list globally for search
        window.allProjects = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
        
        // Render the list
        renderProjects(window.allProjects);
    });
}

// Load archived projects
function loadArchived() {
    const archiveList = document.getElementById("archive-list");

    const q = query(
        collection(db, "projects"),
        where("archived", "==", true),
        orderBy("createdAt", "desc")
    );

    onSnapshot(q, (snapshot) => {
        // Store full list globally for search
        window.allArchived = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
        
        // Render the list
        renderArchived(window.allArchived);
    });
}

// Render active projects
function renderProjects(projects) {
    projectList.innerHTML = "";
    
    if (projects.length === 0) {
        projectList.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 40px;">
                No active projects found
            </div>
        `;
        return;
    }
    
    projects.forEach(p => {
        const card = document.createElement("div");
        card.className = "project-card";
        card.innerHTML = `
            <div>
                <strong>${p.name}</strong><br>
                <small style="color: #22c55e;">● Active</small>
            </div>
            <button data-id="${p.id}" class="archive-btn" onclick="event.stopPropagation()">Archive</button>
        `;
        
        // ADD THIS - Click handler to open module hub
        card.addEventListener('click', (e) => {
            // Don't open hub if clicking archive button
            if (e.target.classList.contains('archive-btn')) {
                return;
            }
            
            // Navigate to module hub with project info
            window.location.href = `module-hub.html?project=${p.id}&name=${encodeURIComponent(p.name)}`;
        });
        
        projectList.appendChild(card);
    });
    
    attachArchiveEvents();
}

// Render archived projects
function renderArchived(archived) {
    const archiveList = document.getElementById("archive-list");
    archiveList.innerHTML = "";
    
    if (archived.length === 0) {
        archiveList.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 20px; font-size: 12px;">
                No archived projects
            </div>
        `;
        return;
    }
    
    archived.forEach(p => {
        const card = document.createElement("div");
        card.className = "project-card";
        card.innerHTML = `
            <div>
                <strong>${p.name}</strong><br>
                <small style="color: #f59e0b;">📦 Archived</small>
            </div>
            <div class="archive-actions">
                <button data-id="${p.id}" class="restore-btn">Restore</button>
                <button data-id="${p.id}" class="perma-delete-btn">Delete</button>
            </div>
        `;
        archiveList.appendChild(card);
    });
    
    attachArchivedCardEvents();
}

// Global Search Handler
const searchInput = document.getElementById("global-search");

searchInput.addEventListener("input", () => {
    const term = searchInput.value.toLowerCase().trim();
    
    // If empty, show all
    if (!term) {
        renderProjects(window.allProjects || []);
        renderArchived(window.allArchived || []);
        return;
    }
    
    // Filter active projects
    const filteredActive = (window.allProjects || []).filter(p => 
        p.name.toLowerCase().includes(term)
    );
    
    // Filter archived projects
    const filteredArchived = (window.allArchived || []).filter(p => 
        p.name.toLowerCase().includes(term)
    );
    
    // Render filtered results
    renderProjects(filteredActive);
    renderArchived(filteredArchived);
});

// Delete
function attachArchiveEvents() {
    document.querySelectorAll(".archive-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
            await updateDoc(doc(db, "projects", btn.dataset.id), {
                archived: true
            });
        });
    });
}

// Logout
logoutBtn.addEventListener("click", async () => {
    await signOut(auth);
    window.location.href = "login.html";
});

function attachArchivedCardEvents() {
    // Restore
    document.querySelectorAll(".restore-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
            await updateDoc(doc(db, "projects", btn.dataset.id), {
                archived: false
            });
        });
    });

    // Permanent Delete
    document.querySelectorAll(".perma-delete-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
            await deleteDoc(doc(db, "projects", btn.dataset.id));
        });
    });
}

// ===========================
// SPACE BACKGROUND SYSTEM
// ===========================

const canvas = document.getElementById('space-canvas');
const ctx = canvas.getContext('2d');

if (canvas && ctx) {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  window.addEventListener('resize', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  });

  const stars = [];
  const starCount = 90;

  for (let i = 0; i < starCount; i++) {
    stars.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      size: Math.random() * 2 + 0.5,
      speedX: (Math.random() - 0.5) * 0.15,
      speedY: (Math.random() - 0.5) * 0.15,
      opacity: Math.random() * 0.5 + 0.3
    });
  }

  const asteroids = [];
  const asteroidCount = 4;

  for (let i = 0; i < asteroidCount; i++) {
    asteroids.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      size: Math.random() * 6 + 4,
      speedX: (Math.random() - 0.5) * 0.03,
      speedY: (Math.random() - 0.5) * 0.03,
      opacity: Math.random() * 0.2 + 0.15,
      color: 'rgba(185, 28, 28, '  // Added the missing color property
    });
  }

 // SCROLL DETECTION FOR BOTH CANVAS AND CSS
let isScrolling = false;
let scrollTimeout;
const scrollContainer = document.querySelector(".workspace");  // CHANGED from .main-area

if (scrollContainer) {
  scrollContainer.addEventListener("scroll", () => {  // Listen to workspace scroll
    isScrolling = true;
    document.body.classList.add('scrolling');
    
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      isScrolling = false;
      document.body.classList.remove('scrolling');
    }, 120);
  }, { passive: true });
}


  let lastTime = 0;

  function animate(time) {
    // COMPLETELY STOP drawing while scrolling
    if (isScrolling) {
      requestAnimationFrame(animate);
      return;  // Skip ALL canvas operations
    }

    // Throttle to 25fps instead of 60fps
    if (time - lastTime < 40) {
      requestAnimationFrame(animate);
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    stars.forEach(star => {
      ctx.fillStyle = `rgba(255,255,255,${star.opacity})`;
      ctx.fillRect(star.x, star.y, star.size, star.size);

      star.x += star.speedX;
      star.y += star.speedY;

      if (star.x < 0) star.x = canvas.width;
      if (star.x > canvas.width) star.x = 0;
      if (star.y < 0) star.y = canvas.height;
      if (star.y > canvas.height) star.y = 0;
    });

    asteroids.forEach(a => {
      ctx.fillStyle = `${a.color}${a.opacity * 0.5})`;
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.size * 2, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = `${a.color}${a.opacity})`;
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.size, 0, Math.PI * 2);
      ctx.fill();

      a.x += a.speedX;
      a.y += a.speedY;

      if (a.x < 0) a.x = canvas.width;
      if (a.x > canvas.width) a.x = 0;
      if (a.y < 0) a.y = canvas.height;
      if (a.y > canvas.height) a.y = 0;
    });

    lastTime = time;
    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);
}


// =============================
// WORKSPACE USER TRACKING
// =============================

async function registerWorkspaceUser() {

    const userRef = doc(db, "workspace-users", currentUserId);

    setDoc(userRef, {
        userId: currentUserId,
        email: currentUserEmail,
        isOnline: true,
        currentPage: "dashboard",
        currentIM: null,
        lastActive: serverTimestamp()
    }, { merge: true });

    // heartbeat every 30 sec
    setInterval(async () => {
        await updateDoc(userRef, {
            lastActive: serverTimestamp()
        });
    }, 30000);

    // mark offline when leaving
    window.addEventListener("beforeunload", async () => {
        await updateDoc(userRef, {
            isOnline: false,
            lastActive: serverTimestamp()
        });
    });
}

function listenToUsersPanel() {
  const panel   = document.getElementById("users-panel");
  const toggle  = document.getElementById("users-toggle");
  if (!panel || !toggle) return;

  // ensure hidden works regardless of CSS
  panel.style.display = "none";
  let isOpen = false;

  toggle.addEventListener("click", () => {
    isOpen = !isOpen;
    panel.style.display = isOpen ? "block" : "none";
    toggle.textContent  = isOpen ? "▲ Users" : "▼ Users";
  });

  const usersRef = collection(db, "workspace-users");

  onSnapshot(usersRef, (snapshot) => {
    const now = Date.now();
    let html  = "";
    let onlineCount = 0;

    snapshot.forEach(docSnap => {
      const data       = docSnap.data();
      const lastActive = data.lastActive?.toMillis?.() || 0;
      const isActive   = (now - lastActive < 120000) && data.isOnline;
      if (isActive) onlineCount++;

      const pageLabel = isActive
        ? (data.currentPage === "im"
            ? `📄 On IM: ${data.currentIM?.title || "—"}`
            : data.currentPage === "fsa"
                ? `📊 On FSA: ${data.currentIM?.title || "—"}`
                : data.currentPage === "module-hub"
                ? `🗂 On Module Hub`
                : `🏠 On Dashboard`)
        : "Offline";


      html += `
        <div class="user-entry" style="
          display:flex; flex-direction:column; gap:2px;
          padding:8px 10px; border-bottom:1px solid rgba(255,255,255,0.06);
          font-size:13px;">
          <span>${isActive ? "🟢" : "⚪"} ${data.email || "Unknown"}</span>
          <small style="opacity:0.5; font-size:11px; padding-left:18px;">${pageLabel}</small>
        </div>`;
    });

    if (!html) html = `<div style="padding:10px;opacity:0.4;font-size:12px;">No users found</div>`;

    panel.innerHTML = html;

    // update button label with live count
    if (!isOpen) {
      toggle.textContent = `▼ Users (${onlineCount} online)`;
    } else {
      toggle.textContent = `▲ Users (${onlineCount} online)`;
    }

  }, (error) => {
    console.error("Users snapshot error:", error);
    panel.innerHTML = `<div style="padding:10px;color:red;font-size:12px;">Error loading users</div>`;
  });
}
