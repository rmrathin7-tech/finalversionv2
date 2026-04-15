// firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js"; // 🌟 NEW

const firebaseConfig = {
  apiKey: "AIzaSyBwExHBtnZNCZIYDxlj0RdCosptq0iWicM",
  authDomain: "imv1-f5f64.firebaseapp.com",
  databaseURL: "https://imv1-f5f64-default-rtdb.firebaseio.com",
  projectId: "imv1-f5f64",
  storageBucket: "imv1-f5f64.firebasestorage.app",
  messagingSenderId: "1088344936506",
  appId: "1:1088344936506:web:60f49c5773681a4e7a2503",
  measurementId: "G-BYQWCJFC9J"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const rtdb = getDatabase(app); // 🌟 NEW