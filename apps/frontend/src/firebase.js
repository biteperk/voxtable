import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyD1NZt3Ov0Esu-krdijIKzlQZ8qtgG6pcg",
  authDomain: "vocotable.firebaseapp.com",
  projectId: "vocotable",
  storageBucket: "vocotable.firebasestorage.app",
  messagingSenderId: "110560713396",
  appId: "1:110560713396:web:d90c8ffa1fe04fc5e915e1",
  measurementId: "G-LRHRWVXCJW"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

const provider = new GoogleAuthProvider();

export async function signInWithGoogle() {
  return signInWithPopup(auth, provider);
}

export async function signOutUser() {
  return signOut(auth);
}
