import { auth } from "./firebase.js";
import { signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const form = document.getElementById("loginForm");
const msg = document.getElementById("msg");

if (form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    const submitBtn = form.querySelector("button[type='submit']");

    // UI Feedback: Show loading state
    msg.innerText = "Authenticating...";
    msg.style.color = "#002b49";
    if (submitBtn) submitBtn.disabled = true;

    try {
      await signInWithEmailAndPassword(auth, email, password);

      // Redirect after successful login
      window.location.href = "admin.html";
    } catch (error) {
      console.error("Firebase Auth Error:", error.code, error.message);
      msg.innerText = `[${error.code || "UNKNOWN"}]: ${error.message || "Authentication failed"}`;
      msg.style.color = "#d9534f";
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}