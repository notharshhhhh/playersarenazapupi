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

  if (req.method === 'GET') {
    return res.status(200).json({
      success: true,
      message: "Cashfree webhook endpoint is active and listening for POST notifications."
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  let db: any = null;
  let FieldValueObj: any = null;
  try {
    const admin = getFirebaseAdmin();
    db = admin.db;
    FieldValueObj = admin.FieldValue;
  } catch (adminErr: any) {
    console.warn("[Cashfree Webhook] Firebase Admin init notice:", adminErr?.message);
  }

  try {
    const signature = req.headers["x-webhook-signature"] as string;
    const timestamp = req.headers["x-webhook-timestamp"] as string;
    const rawBody = req.body?.__rawBody || JSON.stringify(req.body);

    if (!signature || !timestamp) {
      return res.status(400).json({ success: false, error: "Missing webhook headers" });
    }

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
       return res.status(400).json({ success: false, error: "Gateway unconfigured" });
    }
    
    const { data: eventData, type } = req.body || {};
    const orderId = eventData?.order?.order_id;
    
    const isProd = isProdEnv || (clientId && !clientId.includes('TEST'));

    (Cashfree as any).XClientId = clientId;
    (Cashfree as any).XClientSecret = clientSecret;
    (Cashfree as any).XEnvironment = isProd ? (Cashfree as any).Environment.PRODUCTION : (Cashfree as any).Environment.SANDBOX;

    try {
      (Cashfree as any).PGVerifyWebhookSignature(signature, rawBody, timestamp);
    } catch (err) {
      console.warn("[Cashfree Webhook] Signature verification notice:", err);
    }
    
    if (!orderId) return res.status(200).send("OK");

    if (!db || !FieldValueObj) {
      return res.status(200).send("OK - DB Unavailable");
    }

    const userId = eventData.customer_details.customer_id;
    const amount = Number(eventData.payment.payment_amount);
    const paymentId = eventData.payment.cf_payment_id;

    const transRef = db.collection('transactions').doc(orderId);
    const userRef = db.collection('users').doc(userId);

    if (type === "PAYMENT_SUCCESS_WEBHOOK") {
      await db.runTransaction(async (t: any) => {
        const transDoc = await t.get(transRef);
        if (transDoc.exists && transDoc.data()?.status === 'completed') return;

        t.set(transRef, {
          userId: userId,
          type: 'deposit',
          amount: amount,
          status: 'completed',
          title: 'Deposit via Cashfree',
          paymentId: paymentId,
          gateway: 'cashfree',
          updatedAt: FieldValueObj.serverTimestamp(),
          createdAt: transDoc.exists ? transDoc.data()?.createdAt : FieldValueObj.serverTimestamp()
        }, { merge: true });

        t.update(userRef, {
          'wallet.deposit': FieldValueObj.increment(amount),
          'stats.totalDeposited': FieldValueObj.increment(amount)
        });
      });
      console.log(`[Cashfree Webhook] Order ${orderId} processed for user ${userId}`);
    }

    res.status(200).send("OK");
  } catch (error: any) {
    console.error("[Cashfree Webhook] Error:", error.message);
    res.status(500).send("Internal Error");
  }
}
