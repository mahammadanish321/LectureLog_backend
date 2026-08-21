import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

let firebaseApp = null;
let firebaseInitialized = false;

try {
  if (getApps().length === 0) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      firebaseApp = initializeApp({
        credential: cert(serviceAccount)
      });
      firebaseInitialized = true;
      console.log('[FIREBASE] Initialized Firebase Admin from JSON env string.');
    } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
      firebaseApp = initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          // Handle escaped newlines in environment variable strings
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        })
      });
      firebaseInitialized = true;
      console.log('[FIREBASE] Initialized Firebase Admin from individual env credentials.');
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH && fs.existsSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH)) {
      const fileContent = JSON.parse(fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8'));
      firebaseApp = initializeApp({
        credential: cert(fileContent)
      });
      firebaseInitialized = true;
      console.log('[FIREBASE] Initialized Firebase Admin from file path.');
    } else if (process.env.FIREBASE_PROJECT_ID) {
      firebaseApp = initializeApp({
        projectId: process.env.FIREBASE_PROJECT_ID
      });
      firebaseInitialized = true;
      console.log('[FIREBASE] Initialized Firebase Admin with project ID.');
    } else {
      console.warn('[FIREBASE] Warning: Firebase Admin credentials not provided in environment.');
    }
  } else {
    firebaseApp = getApps()[0];
    firebaseInitialized = true;
  }
} catch (err) {
  console.error('[FIREBASE] Error initializing Firebase Admin:', err.message);
}

/**
 * Verify a Firebase ID Token passed from the client
 * @param {string} idToken
 * @returns {Promise<{ uid: string, email: string, email_verified: boolean, name?: string, picture?: string }>}
 */
export const verifyFirebaseIdToken = async (idToken) => {
  if (!idToken) {
    throw new Error('Firebase ID token is required');
  }

  if (!firebaseInitialized || !firebaseApp) {
    throw new Error('Firebase Admin is not configured on the server. Please check backend .env variables (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY).');
  }

  try {
    const decodedToken = await getAuth(firebaseApp).verifyIdToken(idToken);
    return {
      uid: decodedToken.uid,
      email: decodedToken.email,
      email_verified: decodedToken.email_verified,
      name: decodedToken.name,
      picture: decodedToken.picture
    };
  } catch (err) {
    console.error('[FIREBASE] Token verification failed:', err.message);
    throw new Error(`Invalid or expired Firebase token: ${err.message}`);
  }
};

export { firebaseApp, getAuth };
export default firebaseApp;
