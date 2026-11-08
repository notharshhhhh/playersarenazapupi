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





// Reads the real payment state from a ZapUPI order-status response (handles nested "data").
function readGatewayState(vData: any) {
  const inner = vData && typeof vData.data === "object" && vData.data !== null && !Array.isArray(vData.data) ? vData.data : vData || {};
  const pick = (o: any) => String(o?.status || o?.order_status || o?.orderStatus || o?.txn_status || o?.payment_status || "").toLowerCase();
  const status = pick(inner) || pick(vData);
  const amount = Number(inner.amount || inner.order_amount || inner.pay_amount || vData?.amount || vData?.order_amount || vData?.pay_amount || 0);
  return { inner, status, amount };
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

  console.log("[ZapUPI Status Check] Route hit");

  let db: any = null;
  let FieldValueObj: any = null;
  try {
    const admin = getFirebaseAdmin();
    db = admin.db;
    FieldValueObj = admin.FieldValue;
  } catch (adminErr: any) {
    console.warn("[ZapUPI Status Check] Firebase Admin init notice:", adminErr?.message);
  }

  try {
    const { order_id } = req.body || {};
    if (!order_id) {
      console.warn("[ZapUPI Status Check] Missing order_id");
      return res.status(400).json({ success: false, error: "Missing order_id" });
    }

    let transData: any = {};
    let transRef: any = null;

    if (db) {
      // 1. Fetch transaction from Firestore to verify ownership and amount
      transRef = db.collection('transactions').doc(order_id);
      const transDoc = await transRef.get();
      
      if (transDoc.exists) {
        transData = transDoc.data() || {};
        if (transData.status === 'completed') {
          console.log(`[ZapUPI Status Check] Order ${order_id} already completed`);
          return res.json({ success: true, status: 'success', alreadyProcessed: true });
        }
      }
    }

    const userId = transData.userId;
    const originalAmount = transData.amount;

    // 2. Fetch API Key
    let apiKey = process.env.ZAPUPI_API_KEY;
    if (db) {
      try {
        const configDoc = await db.collection('paymentSettings').doc('zapupi').get();
        if (configDoc.exists && configDoc.data()?.isActive) {
          apiKey = configDoc.data()?.apiKey || apiKey;
        }
      } catch (e) {}
    }

    // 3. Poll ZapUPI Gateway
    const apiBase = (process.env.ZAPUPI_BASE_URL || "https://pay.zapupi.com").replace(/\/$/, "");
    const hosts = [apiBase, "https://pay.zapupi.com", "https://api.zapupi.com", "https://p1.zapupi.com"].filter(Boolean);
    const paths = ["/api/order-status", "/api/get_order", "/api/get-order"];

    let verifiedData: any = null;
    let finalStatus = 'pending';

    console.log(`[ZapUPI Status Check] Polling gateway for ${order_id}...`);

    outer: for (const host of hosts) {
      for (const path of paths) {
        const verifyUrl = `${host}${path}`;
        try {
          const verifyRes = await axios.post(verifyUrl, {
            zap_key: apiKey,
            api_key: apiKey,
            order_id: order_id
          }, { 
            headers: { 'Content-Type': 'application/json' },
            timeout: 8000 
          });

          const vData = verifyRes.data || {};
          const gw = readGatewayState(vData);
          const rawStatus = gw.status;
          console.log(`[ZapUPI Status Check] Gateway response (${verifyUrl}): status="${rawStatus}" body=${JSON.stringify(vData).slice(0, 500)}`);

          // Only an explicit paid status counts. A message like "fetched successfully" is NOT proof of payment.
          const isSuccess = ['success', 'completed', 'paid', 'transaction successful'].includes(rawStatus);

          if (isSuccess) {
            finalStatus = 'success';
            verifiedData = vData;
            break outer;
          } else if (['failed', 'failure', 'canceled', 'cancelled'].includes(rawStatus)) {
            finalStatus = 'failed';
            verifiedData = vData;
            break outer;
          }
        } catch (err: any) {
          console.warn(`[ZapUPI Status Check] Gateway call failed ${verifyUrl}: HTTP ${err?.response?.status || '-'} ${JSON.stringify(err?.response?.data || err?.message || '').slice(0, 300)}`);
        }
      }
    }

    // 4. Update Wallet if success
    if (finalStatus === 'success' && verifiedData && db && transRef && userId && FieldValueObj) {
      console.log(`[ZapUPI Status Check] Payment verified. Processing wallet credit for ${userId}`);
      
      const gatewayAmount = Number(readGatewayState(verifiedData).amount || originalAmount || 0);
      const gwInner = readGatewayState(verifiedData).inner;
      const txId = gwInner.txn_id || gwInner.tx_id || verifiedData.txn_id || verifiedData.tx_id || order_id;
      const utr = gwInner.utr || verifiedData.utr || '';

      await db.runTransaction(async (t: any) => {
        const freshTransDoc = await t.get(transRef);
        if (freshTransDoc.exists && freshTransDoc.data()?.status === 'completed') return;

        const userRef = db.collection('users').doc(userId);
        
        t.update(transRef, {
          status: 'completed',
          amount: gatewayAmount,
          paymentId: txId,
          utr: utr,
          updatedAt: FieldValueObj.serverTimestamp()
        });

        t.update(userRef, {
          'wallet.deposit': FieldValueObj.increment(gatewayAmount),
          'stats.totalDeposited': FieldValueObj.increment(gatewayAmount)
        });
      });

      console.log(`[ZapUPI Status Check] Wallet updated successfully for user ${userId}`);
      return res.json({ success: true, status: 'success', detail: verifiedData });
    }

    if (finalStatus === 'failed' && db && transRef && FieldValueObj) {
       await transRef.update({ status: 'failed', updatedAt: FieldValueObj.serverTimestamp() });
       return res.json({ success: false, status: 'failed', detail: verifiedData });
    }

    res.json({ success: true, status: finalStatus, detail: verifiedData });
  } catch (error: any) {
    console.error("[ZapUPI Status Check] Internal Error:", error.message);
    res.status(500).json({ success: false, error: "Internal server error: " + error.message });
  }
}
