import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyDMRUdswC-8fK0vNpVLi_BpQMQyfAQPbtY",
  authDomain: "civic-infrastructure-platform.firebaseapp.com",
  projectId: "civic-infrastructure-platform",
  storageBucket: "civic-infrastructure-platform.firebasestorage.app",
  messagingSenderId: "1063883372360",
  appId: "1:1063883372360:web:f15c8f5280d267b85e657d"
};

const app = initializeApp(firebaseConfig);

const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app);

export { db, auth, storage };

