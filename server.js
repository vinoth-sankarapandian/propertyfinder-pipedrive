import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import dayjs from "dayjs";
dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

/* -------------------- CONSTANTS -------------------- */

// 🔧 Hard-coded Zoho log URL (for function "testlog")
const ZCRM_LOG_URL =
  "https://www.zohoapis.in/crm/v7/functions/testlog/actions/execute?auth_type=apikey&zapikey=1003.9ade13a0c8a317b0b830c1889c073d56.3f578e1bb942b520e28b4d1a49fa36ca";

// ---- Environment Config ----
const PD_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const PD_DOMAIN =
  process.env.PIPEDRIVE_DOMAIN || "https://api.pipedrive.com/api/v1";
const CLIENTS_PIPELINE_ID = Number(process.env.CLIENTS_PIPELINE_ID || 4);
const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || "AED";
const PF_API_KEY = process.env.PF_API_KEY;
const PF_API_SECRET = process.env.PF_API_SECRET;
const PF_SECRET_KEY = process.env.PF_SECRET_KEY || "";
const ATLAS_BASE = "https://atlas.propertyfinder.com/v1";

/* -------------------- ATLAS TOKEN CACHE -------------------- */
let atlasToken = null;
let atlasTokenExpiry = 0;

async function getAtlasToken() {
  const now = Date.now();
  if (atlasToken && now < atlasTokenExpiry) return atlasToken;
  await sendLog("🔐 Generating new Atlas token...");
  const res = await fetch(`${ATLAS_BASE}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: PF_API_KEY, apiSecret: PF_API_SECRET }),
  });
  const data = await res.json();
  if (!data?.accessToken)
    throw new Error(`Atlas token error: ${JSON.stringify(data)}`);
  atlasToken = data.accessToken;
  atlasTokenExpiry = now + Number(data.expiresIn || 3600) * 1000 - 60000;
  await sendLog("✅ Atlas token refreshed");
  return atlasToken;
}

async function atlasGet(path) {
  const token = await getAtlasToken();
  const url = `${ATLAS_BASE}${path}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  await sendLog(`📡 Atlas GET ${url}`, { status: r.status, json });
  return { ok: r.ok, status: r.status, json, text };
}

/* -------------------- UTILITIES -------------------- */
function normalizePhone(str) {
  return str ? str.toString().replace(/[^\d+]/g, "") : null;
}
function buildDealTitle({ name, listingRef, listingTitle, channel }) {
  const who = name || "PF Lead";
  const ref = listingRef ? ` | ${listingRef}` : "";
  const ttl = listingTitle ? ` | ${listingTitle}` : "";
  const ch = channel ? ` (${channel})` : "";
  return `${who}${ttl}${ref}${ch}`;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* -------------------- LOGGING TO ZOHO -------------------- */
async function sendLog(message, data = {}) {
  const payload = {
    time: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    message,
    data,
  };
  console.log("📝", message, data || "");
  try {
    await fetch(ZCRM_LOG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("⚠️ Zoho log send failed:", e.message);
  }
}

/* -------------------- PIPEDRIVE HELPERS -------------------- */
async function pdGet(path) {
  const url = `${PD_DOMAIN}${path}${
    path.includes("?") ? "&" : "?"
  }api_token=${PD_TOKEN}`;
  const r = await fetch(url);
  const j = await r.json();
  await sendLog(`📥 Pipedrive GET ${path}`, j);
  return j;
}
async function pdPost(path, body) {
  const url = `${PD_DOMAIN}${path}?api_token=${PD_TOKEN}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  await sendLog(`📤 Pipedrive POST ${path}`, { body, resp: j });
  return j;
}
async function pdPut(path, body) {
  const url = `${PD_DOMAIN}${path}?api_token=${PD_TOKEN}`;
  const r = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  await sendLog(`🧩 Pipedrive PUT ${path}`, { body, resp: j });
  return j;
}
async function findPerson({ email, phone }) {
  if (email) {
    const j = await pdGet(
      `/persons/search?term=${encodeURIComponent(
        email
      )}&fields=email&exact_match=true`
    );
    const item = j?.data?.items?.[0]?.item;
    if (item?.id) return item.id;
  }
  if (phone) {
    const j = await pdGet(
      `/persons/search?term=${encodeURIComponent(
        phone
      )}&fields=phone&exact_match=true`
    );
    const item = j?.data?.items?.[0]?.item;
    if (item?.id) return item.id;
  }
  return null;
}

/* -------------------- MAIN HANDLER -------------------- */
app.post("/webhook", async (req, res) => {
  try {
    await sendLog("📩 Incoming event", req.body);

    const evt = req.body;
    if (evt?.type !== "lead.created") {
      await sendLog("ℹ️ Ignored non-lead event", evt.type);
      return res.status(200).json({ success: true, ignored: true });
    }

    const leadId = evt?.entity?.id;
    if (!leadId) throw new Error("Missing lead id");

    // --- Retry fetch ---
    let lead = null;
    for (let i = 0; i < 5; i++) {
      const r = await atlasGet(`/leads?id=${encodeURIComponent(leadId)}`);
      const data = r?.json?.data;
      if (Array.isArray(data) && data.length > 0) {
        lead = data[0];
        break;
      }
      await sendLog(`⚠️ Lead not ready (try ${i + 1}/5)`);
      await sleep(500 + i * 500);
    }
    if (!lead) {
      await sendLog(
        "⚠️ Lead not found after retries, using event.payload fallback"
      );
      lead = evt.payload || {};
    }

    const listingId = lead?.listing?.id;
    const publicProfileId = lead?.publicProfile?.id;
    let user = null,
      listing = null;

    // Fetch user
    if (publicProfileId) {
      const userRes = await atlasGet(
        `/users?publicProfileId=${encodeURIComponent(publicProfileId)}`
      );
      user = userRes?.json?.data?.[0] || null;
    }

    // Fetch listing
    if (listingId) {
      const listRes = await atlasGet(
        `/listings?filter[ids]=${encodeURIComponent(listingId)}`
      );
      listing = listRes?.json?.results?.[0] || null;
    }

    // Extract person fields
    const fullName =
      [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() ||
      user?.publicProfile?.name ||
      lead?.sender?.name ||
      "Property Finder Lead";

    const email = user?.email || user?.publicProfile?.email || null;
    const phone = normalizePhone(
      user?.mobile ||
        user?.publicProfile?.whatsappPhone ||
        user?.publicProfile?.phone ||
        (lead?.sender?.contacts || []).find(
          (c) => (c.type || "").toLowerCase() === "phone"
        )?.value
    );

    await sendLog("👤 Person details extracted", { fullName, email, phone });

    // Create/update person
    let personId = await findPerson({ email, phone });
    if (!personId) {
      const p = await pdPost("/persons", {
        name: fullName,
        ...(email ? { email: [{ value: email, primary: true }] } : {}),
        ...(phone ? { phone: [{ value: phone, primary: true }] } : {}),
      });
      if (!p.success) throw new Error("Person create failed");
      personId = p.data.id;
    } else {
      await pdPut(`/persons/${personId}`, {
        name: fullName,
        ...(email ? { email: [{ value: email, primary: true }] } : {}),
        ...(phone ? { phone: [{ value: phone, primary: true }] } : {}),
      });
    }

    // Create deal
    const dealTitle = buildDealTitle({
      name: fullName,
      listingRef: listing?.reference,
      listingTitle: listing?.title?.en,
      channel: lead?.channel,
    });
    const amount = Number(listing?.price?.amounts?.yearly || 0);

    const deal = await pdPost("/deals", {
      title: dealTitle,
      person_id: personId,
      value: amount,
      currency: DEFAULT_CURRENCY,
      pipeline_id: CLIENTS_PIPELINE_ID,
      status: "open",
      visible_to: "3",
    });
    if (!deal.success) throw new Error("Deal creation failed");

    // Add note
    const note = {
      deal_id: deal.data.id,
      content: [
        `**Portal:** Property Finder`,
        `**Channel:** ${lead?.channel}`,
        `**Listing Ref:** ${listing?.reference}`,
        `**Price:** ${listing?.price?.amounts?.yearly || 0} AED`,
        `**Response Link:** ${lead?.responseLink}`,
        "",
        "**Raw JSON:**",
        "```json",
        JSON.stringify(lead, null, 2),
        "```",
      ].join("\n"),
    };
    await pdPost("/notes", note);

    await sendLog("✅ Deal created successfully", {
      pipedrive_person_id: personId,
      pipedrive_deal_id: deal.data.id,
    });

    res.status(200).json({
      success: true,
      pipedrive_person_id: personId,
      pipedrive_deal_id: deal.data.id,
    });
  } catch (err) {
    console.error("❌ Error:", err);
    await sendLog("❌ Error in webhook", {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ success: false, error: err.message });
  }
});

/* -------------------- START -------------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🚀 PF Atlas → Pipedrive webhook running on ${PORT}`)
);
