// js/auth.js

import { auth } from "./firebase.js";
import { signInWithEmailAndPassword, onAuthStateChanged }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
const emailInput = document.getElementById("login-email");
const passwordInput = document.getElementById("login-password");
const loginBtn = document.getElementById("login-btn");
const errorEl = document.getElementById("auth-error");

loginBtn.addEventListener("click", async () => {

    const email = emailInput.value.trim();
    const password = passwordInput.value.trim();

    errorEl.classList.add("hidden");

    if (!email || !password) {
        showError("ENTER CREDENTIALS");
        return;
    }

    try {
        await signInWithEmailAndPassword(auth, email, password);
        const user = auth.currentUser;

    await setDoc(
    doc(db, "users", user.uid),
    {
        email: user.email,
        uid: user.uid
    },
    { merge: true }
    );
        window.location.href = "dashboard.html";
    } catch (error) {
        showError(error.message);
    }
});

onAuthStateChanged(auth, (user) => {
    if (user) {
        window.location.href = "dashboard.html";
    }
});

function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
}
