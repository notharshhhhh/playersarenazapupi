import { Cashfree } from "cashfree-pg";
import { initializeApp as initClientApp, getApps as getClientApps, getApp as getClientApp } from "firebase/app";
import {
  getFirestore as getClientFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  runTransaction as runClientTransaction,
  serverTimestamp as clientServerTimestamp,
  increment as clientIncrement
} from "firebase/firestore";
import fs from "fs";
import path from "path";

// Embedded default fallback config for serverless environments (Vercel, etc.)
const DEFAULT_FIREBASE_CONFIG = {
  projectId: "autonomous-receiver-93rp2",
  appId: "1:110861457475:web:d7087365f9fb77b8b41cf6",
  apiKey: "AIzaSyCxMg8vqocWSlHLIJlc3d17vYkJX2OBE7g",
  authDomain: "autonomous-receiver-93rp2.firebaseapp.com",
  firestoreDatabaseId: "ai-studio-kidsaddafreefire-7974c2ef-2888-4e20-9391-61b09a11835c",
  storageBucket: "autonomous-receiver-93rp2.firebasestorage.app",
  messagingSenderId: "110861457475"
};

class DocRefWrapper {
  constructor(public firestoreInstance: any, public colPath: string, public docId: string) {}

  get docRef() {
    return doc(this.firestoreInstance, this.colPath, this.docId);
  }

  async get() {
    try {
      const snap = await getDoc(this.docRef);
      return {
        exists: snap.exists(),
        data: () => snap.data(),
        id: snap.id
      };
    } catch (err: any) {
      console.warn(`[Firestore Client Adapter] get notice on ${this.colPath}/${this.docId}:`, err.message);
      return {
        exists: false,
        data: () => undefined,
        id: this.docId
      };
    }
  }

  async set(data: any, options?: { merge?: boolean }) {
    if (options?.merge) {
      return setDoc(this.docRef, data, { merge: true });
    }
    return setDoc(this.docRef, data);
  }

  async update(data: any) {
    return updateDoc(this.docRef, data);
  }
}

class CollectionRefWrapper {
  constructor(public firestoreInstance: any, public colPath: string) {}

  doc(id?: string) {
    const docId = id || Math.random().toString(36).substring(2, 15);
    return new DocRefWrapper(this.firestoreInstance, this.colPath, docId);
  }
}

const FieldValue = {
  serverTimestamp: () => clientServerTimestamp(),
  increment: (n: number) => clientIncrement(n)
};

function getFirebaseAdmin() {
  let firebaseConfig: any = { ...DEFAULT_FIREBASE_CONFIG };

  try {
    const configPath = path.join(process.cwd(), "firebase-applet-config.json");
    if (fs.existsSync(configPath)) {
      const fileData = JSON.parse(fs.readFileSync(configPath, "utf8"));
      firebaseConfig = { ...firebaseConfig, ...fileData };
    }
  } catch (e) {
    // Ignore file read error in serverless environments
  }

  const databaseId =
    process.env.FIRESTORE_DATABASE_ID ||
    firebaseConfig.firestoreDatabaseId ||
    "(default)";

  // Initialize Client SDK (Pure web client SDK - ZERO service account key needed)
  let clientApp: any;
  if (getClientApps().length === 0) {
    clientApp = initClientApp(firebaseConfig);
  } else {
    clientApp = getClientApp();
  }

  const clientDb = getClientFirestore(clientApp, databaseId);

  const wrappedDb = {
    collection: (colPath: string) => new CollectionRefWrapper(clientDb, colPath),
    runTransaction: async (updateFn: (t: any) => Promise<any>) => {
      return runClientTransaction(clientDb, async (clientT: any) => {
        const transactionWrapper = {
          async get(docRefOrWrapper: any) {
            const ref = docRefOrWrapper.docRef || docRefOrWrapper;
            const snap = await clientT.get(ref);
            return {
              exists: snap.exists(),
              data: () => snap.data(),
              id: snap.id
            };
          },
          set(docRefOrWrapper: any, data: any, options?: any) {
            const ref = docRefOrWrapper.docRef || docRefOrWrapper;
            return clientT.set(ref, data, options);
          },
          update(docRefOrWrapper: any, data: any) {
            const ref = docRefOrWrapper.docRef || docRefOrWrapper;
            return clientT.update(ref, data);
          }
        };
        return updateFn(transactionWrapper);
      });
    }
  };

  return { app: clientApp, db: wrappedDb, databaseId, FieldValue };
}




export default async function handler(req: any, res: any) {
  // CORS support
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  console.log("[Cashfree Create Order] Route hit");
  
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  let db: any = null;
  try {
    const admin = getFirebaseAdmin();
    db = admin.db;
  } catch (adminErr: any) {
    console.warn("[Cashfree Create Order] Firebase Admin init notice:", adminErr?.message);
  }

  try {
    const { amount, userId, customerName, customerEmail, customerPhone } = req.body || {};
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    // Try to get config from Firestore
    let clientId = process.env.CASHFREE_CLIENT_ID;
    let clientSecret = process.env.CASHFREE_CLIENT_SECRET;
    let isProdEnv = process.env.CASHFREE_ENV === "PRODUCTION";

    if (db) {
      try {
        const configDoc = await db.collection('paymentSettings').doc('cashfree').get();
        if (configDoc.exists && configDoc.data()?.isActive) {
          clientId = configDoc.data()?.apiKey || clientId;
          clientSecret = configDoc.data()?.secretKey || clientSecret;
          isProdEnv = configDoc.data()?.isProduction ?? isProdEnv;
        }
      } catch (e) {}
    }

    if (!clientId || !clientSecret) {
      return res.status(500).json({ error: "Cashfree credentials are missing. Please configure CASHFREE_CLIENT_ID and CASHFREE_CLIENT_SECRET." });
    }

    const isProd = isProdEnv || (clientId && !clientId.includes('TEST'));

    (Cashfree as any).XClientId = clientId;
    (Cashfree as any).XClientSecret = clientSecret;
    (Cashfree as any).XEnvironment = isProd ? (Cashfree as any).Environment.PRODUCTION : (Cashfree as any).Environment.SANDBOX;

    const orderId = `order_${Date.now()}_${userId}`;
    
    // Determine base URL
    let baseUrlFull = process.env.APP_URL;
    if (!baseUrlFull) {
      const protocol = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      baseUrlFull = `${protocol}://${host}`;
    }
    baseUrlFull = baseUrlFull.replace(/\/$/, "");

    const requestData = {
      order_amount: Number(amount),
      order_currency: "INR",
      order_id: orderId,
      customer_details: {
        customer_id: String(userId),
        customer_phone: customerPhone || "9999999999",
        customer_name: customerName || "Khel Galli User",
        customer_email: customerEmail || "user@khelgalli.com"
      },
      order_meta: {
        return_url: `${baseUrlFull}/wallet?order_id={order_id}`,
        notify_url: `${baseUrlFull}/api/cashfree/webhook`
      }
    };

    console.log(`[Cashfree Create Order] Processing order: ${orderId}`);
    const response = await (Cashfree as any).PGCreateOrder("2023-08-01", requestData);
    res.json(response.data);
  } catch (error: any) {
    console.error("[Cashfree Create Order] Error:", error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.message || error.message });
  }
}
