import { auth } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

onAuthStateChanged(auth, (user) => {
  if (!user) {
    // Redirect unauthenticated users immediately
    window.location.href = "admin-login.html";
  } else {
    // Reveal page content safely
    if (document.body) {
      document.body.style.display = "block";
    } else {
      window.addEventListener("DOMContentLoaded", () => {
        document.body.style.display = "block";
      });
    }
  }
});
