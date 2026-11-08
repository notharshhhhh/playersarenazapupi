import axios from "axios";
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

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  console.log("[ZapUPI Create Order] Route hit successfully");

  let db: any = null;
  let FieldValueObj: any = null;
  try {
    const admin = getFirebaseAdmin();
    db = admin.db;
    FieldValueObj = admin.FieldValue;
  } catch (adminErr: any) {
    console.warn("[ZapUPI Create Order] Firebase Admin init notice:", adminErr?.message);
  }

  try {
    const { amount, userId } = req.body || {};
    
    if (!amount || Number(amount) <= 0) {
      console.warn("[ZapUPI Create Order] Invalid amount:", amount);
      return res.status(400).json({ success: false, error: "Invalid amount" });
    }

    if (!userId) {
      console.warn("[ZapUPI Create Order] Missing userId");
      return res.status(400).json({ success: false, error: "Missing userId" });
    }

    // Try to get config from Firestore first, fallback to env
    let apiKey = process.env.ZAPUPI_API_KEY;
    if (db) {
      try {
        const configDoc = await db.collection('paymentSettings').doc('zapupi').get();
        if (configDoc.exists && configDoc.data()?.isActive) {
          apiKey = configDoc.data()?.apiKey || apiKey;
        }
      } catch (e) {
        console.warn("[ZapUPI Create Order] Could not fetch config from Firestore, using ENV fallback.");
      }
    }

    if (!apiKey) {
      console.error("[ZapUPI Create Order] API Key missing in Firestore and ENV");
      return res.status(500).json({ success: false, error: "ZapUPI API Key is missing. Add it in Admin -> Payment Gateways -> ZapUPI (gateway ON) or set ZAPUPI_API_KEY in Vercel." });
    }

    // Fetch user profile from Firestore for accurate metadata
    let customerName = "Khel Galli User";
    let customerEmail = "user@khelgalli.com";
    let customerPhone = "9999999999";

    if (db) {
      try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (userDoc.exists) {
          const userData = userDoc.data() || {};
          customerName = userData.username || customerName;
          customerEmail = userData.email || customerEmail;
          customerPhone = userData.mobile || userData.phone || customerPhone;
        }
      } catch (err) {
        console.warn(`[ZapUPI Create Order] Could not fetch user doc for ${userId}`);
      }
    }

    const orderId = `zap_${Date.now()}_${userId}`;
    
    // Determine base URL, prioritizing APP_URL then Vercel headers
    let baseUrlFull = process.env.APP_URL;
    if (!baseUrlFull) {
      const protocol = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      baseUrlFull = `${protocol}://${host}`;
    }
    baseUrlFull = baseUrlFull.replace(/\/$/, "");

    console.log(`[ZapUPI Create Order] Creating order: ${orderId} for User: ${userId}`);
    
    // Save transaction BEFORE creating at gateway if Firestore is available
    if (db && FieldValueObj) {
      try {
        await db.collection('transactions').doc(orderId).set({
          userId: userId,
          amount: Number(amount),
          status: 'pending',
          type: 'deposit',
          gateway: 'zapupi',
          title: 'Deposit via ZapUPI',
          createdAt: FieldValueObj.serverTimestamp(),
          updatedAt: FieldValueObj.serverTimestamp()
        }, { merge: true });
      } catch (txErr: any) {
        console.warn("[ZapUPI Create Order] Transaction pre-save notice:", txErr.message);
      }
    }

    const payload = {
      zap_key: apiKey,
      api_key: apiKey,
      order_id: orderId,
      client_order_id: orderId,
      amount: String(amount),
      customer_name: customerName,
      customer_email: customerEmail,
      customer_mobile: String(customerPhone).replace(/\D/g, '').slice(-10) || "9999999999",
      webhook_url: `${baseUrlFull}/api/zapupi/webhook`,
      callback_url: `${baseUrlFull}/wallet?payment=success&order_id=${orderId}`,
      success_url: `${baseUrlFull}/wallet?payment=success&order_id=${orderId}`,
      failed_url: `${baseUrlFull}/wallet?payment=failed&order_id=${orderId}`,
      timeout_url: `${baseUrlFull}/wallet?payment=timeout&order_id=${orderId}`,
      redirect_url: `${baseUrlFull}/wallet?payment=success&order_id=${orderId}`,
      return_url: `${baseUrlFull}/wallet?payment=success&order_id=${orderId}`,
      description: `Wallet Deposit - ${userId}`
    };

    let apiBase = (process.env.ZAPUPI_BASE_URL || "https://pay.zapupi.com").replace(/\/$/, "");
    if (apiBase.includes("api.zapupi.com")) {
      apiBase = apiBase.replace("api.zapupi.com", "pay.zapupi.com");
    }
    
    const zapUrl = `${apiBase}/api/create-order`;

    try {
      console.log(`[ZapUPI Create Order] Calling gateway: ${zapUrl}`);
      const response = await axios.post(zapUrl, payload, {
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'KhelGalli-Vercel/1.6',
          'Accept': 'application/json'
        },
        timeout: 15000
      });

      const json = response.data;
      const paymentUrl = json.redirect_url || json.payment_url || json.paymentUrl || json.url || (json.data && (json.data.payment_url || json.data.redirect_url));

      if (json.status === 'success' || json.status === 'SUCCESS' || paymentUrl) {
        console.log(`[ZapUPI Create Order] Gateway success for ${orderId}. URL: ${paymentUrl}`);
        return res.status(200).json({ 
          success: true,
          order_id: orderId,
          payment_url: paymentUrl,
          redirect_url: paymentUrl,
          paymentUrl: paymentUrl,
          ...json 
        });
      } else {
        console.error(`[ZapUPI Create Order] Gateway error:`, JSON.stringify(json));
        return res.status(400).json({ 
          success: false, 
          error: json.msg || json.message || "Payment initiation failed at gateway" 
        });
      }
    } catch (err: any) {
      console.error(`[ZapUPI Create Order] Gateway request failed:`, err.response?.data || err.message);
      return res.status(502).json({ 
        success: false, 
        error: "Payment gateway unreachable: " + (err.response?.data?.message || err.message) 
      });
    }
  } catch (error: any) {
    console.error("[ZapUPI Create Order] Internal Exception:", error.message);
    res.status(500).json({ success: false, error: "Internal server error: " + error.message });
  }
}
