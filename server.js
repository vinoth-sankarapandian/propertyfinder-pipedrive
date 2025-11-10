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
const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || "AED";
const PF_API_KEY = process.env.PF_API_KEY;
const PF_API_SECRET = process.env.PF_API_SECRET;
const ATLAS_BASE = "https://atlas.propertyfinder.com/v1";

// Force Clients pipeline = 4
const CLIENTS_PIPELINE_ID = 4;

/* ---------- PIPEDRIVE CUSTOM FIELDS (DEAL) ---------- */
const CF_SOURCE_TYPE = "dd33ab8a28f1855b734beab08987eb86933706fa"; // Channel
const CF_LISTING_REF = "e0c51e09b74263ff900e7d7a1ca4b00d06e58bcf"; // Listing Ref
const CF_LISTING_PRICE = "cd786e99a8fc60d9d437d9540b5e49f1937ab8ea"; // Listing Price
const CF_RESPONSE_URL = "167d14dc0b5099bed92a67e682d7ddcbc14fd878"; // Response URL
const CF_ENQUIRY_DATE = "12dbd54260ad300537c002bd423cf48ecc618e8e"; // Enquiry Date
const CF_WHATSAPP_NUMBER = "8db7b87dc9d9147db03b063ee9e678d236879791"; // WhatsApp Number
const CF_LISTING_AGENT = "2fec03e9ce0f41f43c929cbbb1c628e9ec3db3bc"; // Listing Agent
const CF_AGENT_PHONE = "213b8e2bdbc862b02296cc0233af26689beb4e0a"; // Agent Phone
// Property Finder Event ID custom field (ProperyFinderId)
const CF_PF_EVENT_ID = "370ec98b9730defabd9813bd08bbf0c841f7c54c";

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
  return r.json();
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

// Find existing deal by PF event id stored in custom fields
async function findDealByEventId(eventId) {
  if (!eventId) return null;
  const q = `/deals/search?term=${encodeURIComponent(
    eventId
  )}&fields=custom_fields&exact_match=true`;
  const j = await pdGet(q);
  const item = j?.data?.items?.[0]?.item;
  return item || null;
}

/* -------------------- MAIN HANDLER -------------------- */
app.post("/webhook", async (req, res) => {
  try {
    await sendLog("📩 Incoming webhook", req.body);

    const evt = req.body;
    if (!evt?.payload) throw new Error("Missing payload in event");
    const lead = evt.payload;

    // Idempotency: check by PF event id (e.g., lead-created-XXXX)
    const eventId = req.body?.id || null;
    if (eventId) {
      const existing = await findDealByEventId(eventId);
      if (existing?.id) {
        await sendLog("ℹ️ PF duplicate detected via eventId; skipping deal", {
          eventId,
          deal_id: existing.id,
        });
        return res.status(200).json({
          success: true,
          deduped: true,
          pipedrive_deal_id: existing.id,
        });
      }
    }

    // Extract sender (customer)
    const senderName = lead?.sender?.name || "Property Finder Lead";
    const senderPhone = normalizePhone(
      (lead?.sender?.contacts || []).find(
        (c) => (c.type || "").toLowerCase() === "phone"
      )?.value
    );
    const senderEmail =
      (lead?.sender?.contacts || []).find(
        (c) => (c.type || "").toLowerCase() === "email"
      )?.value || null;

    // Extract listing and agent IDs
    const listingId = lead?.listing?.id;
    const publicProfileId = lead?.publicProfile?.id;

    // Fetch agent details from /users
    let user = null;
    if (publicProfileId) {
      const userRes = await atlasGet(
        `/users?publicProfileId=${encodeURIComponent(publicProfileId)}`
      );
      user = userRes?.json?.data?.[0] || null;
    }

    // Fetch listing details (for title, price, etc.)
    let listing = null;
    if (listingId) {
      const listRes = await atlasGet(
        `/listings?filter[ids]=${encodeURIComponent(listingId)}`
      );
      listing = listRes?.json?.results?.[0] || null;
    }

    const listingRef = listing?.reference || lead?.listing?.reference || "";
    const listingTitle = listing?.title?.en || "";
    const listingPrice = Number(listing?.price?.amounts?.yearly || 0);
    const channel = lead?.channel || "";

    const agentName =
      [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() ||
      user?.publicProfile?.name ||
      "";
    const agentPhone = normalizePhone(
      user?.mobile ||
        user?.publicProfile?.whatsappPhone ||
        user?.publicProfile?.phone ||
        null
    );

    await sendLog("🧾 Extracted lead info", {
      senderName,
      senderPhone,
      channel,
      listingRef,
      listingPrice,
      agentName,
      agentPhone,
    });

    // Create/update Person
    let personId = await findPerson({ email: senderEmail, phone: senderPhone });
    if (!personId) {
      const p = await pdPost("/persons", {
        name: senderName,
        ...(senderEmail
          ? { email: [{ value: senderEmail, primary: true }] }
          : {}),
        ...(senderPhone
          ? { phone: [{ value: senderPhone, primary: true }] }
          : {}),
      });
      if (!p.success) throw new Error("Person create failed");
      personId = p.data.id;
    } else {
      await pdPut(`/persons/${personId}`, {
        name: senderName,
        ...(senderEmail
          ? { email: [{ value: senderEmail, primary: true }] }
          : {}),
        ...(senderPhone
          ? { phone: [{ value: senderPhone, primary: true }] }
          : {}),
      });
    }

    // Create Deal in Clients pipeline (4) with mapped fields
    const dealPayload = {
      title: buildDealTitle({
        name: senderName,
        listingRef,
        listingTitle,
        channel,
      }),
      person_id: personId,
      value: listingPrice,
      currency: DEFAULT_CURRENCY,
      pipeline_id: CLIENTS_PIPELINE_ID,
      status: "open",
      visible_to: "3",

      // === Primary PF → Pipedrive field mappings ===
      [CF_SOURCE_TYPE]: channel || null, // Source Type
      [CF_LISTING_REF]: listing?.reference || null, // Listing Ref
      [CF_LISTING_PRICE]: listingPrice || 0, // Listing Price
      [CF_RESPONSE_URL]: lead?.responseLink || null, // Response URL
      [CF_ENQUIRY_DATE]: lead?.createdAt || null, // Enquiry Date
      [CF_WHATSAPP_NUMBER]: senderPhone || null, // WhatsApp Number
      [CF_LISTING_AGENT]: agentName || null, // Listing Agent
      [CF_AGENT_PHONE]: agentPhone || null, // Agent Phone

      // Persist PF event id if a field key is configured
      ...(CF_PF_EVENT_ID && eventId ? { [CF_PF_EVENT_ID]: eventId } : {}),

      // === Additional Property / Agent info ===
      "146ce25cf22cf5635f7cabde8c81214ff2202c2c":
        user?.email || user?.publicProfile?.email || null, // Agent Email
      cb6454716c95c7f906666d170b46483631a770b0:
        user?.id || user?.publicProfile?.id || null, // Agent Portal ID
      "50332e118438da736f8b85d589d24448da38bd5e": listing?.bedrooms || null, // Listing Beds
      ba303d13dded1058170bf910484040e4129db439: listing?.category || null, // Listing Category
      "5611eb969142e83db4b1e8bee1463a55da8b341c":
        listing?.furnishingType || null, // Listing Furnished
      "299efb50006c0b2dd4d88ad4db4e78b34b950238":
        Object.keys(listing?.products || {})[0] || null, // Listing Product (first key)
      "406b4db7f3830ff67e2f30b02c76586888defeb3":
        listing?.qualityScore?.value || null, // Listing Quality Score
      aea31d4cd4f0db5db2991d08051a52094b53704b: listing?.size || null, // Listing Size
      "53966df67e491c5ed892a94d250f980ea6a00eeb": listing?.title?.en || null, // Listing Title
      d30bed5545084db670f2a84815adf7eb120d5773: listing?.type || null, // Listing Property Type
      eb855d59f7d59f5b352c1ad2e3bb518752382f2d:
        listing?.verificationStatus || null, // Listing Verified
    };
    const deal = await pdPost("/deals", dealPayload);
    if (!deal.success) throw new Error("Deal creation failed");

    // Add Note (for reference)
    const note = {
      deal_id: deal.data.id,
      content: [
        `**Portal:** Property Finder`,
        `**Channel:** ${channel}`,
        `**Listing Ref:** ${listingRef}`,
        `**Price:** ${listingPrice} AED`,
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
      deal_id: deal.data.id,
      person_id: personId,
      pipeline_id: CLIENTS_PIPELINE_ID,
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

/* ============================================================
   🟢 BAYUT WEBHOOK — Call / WhatsApp / Enquiry Leads
   ============================================================ */
app.post("/webhook/bayut", async (req, res) => {
  try {
    await sendLog("📩 Incoming Bayut webhook", req.body);
    const lead = req.body;

    // ✅ Validate the payload shape
    if (!lead) throw new Error("Invalid Bayut payload");

    // Extract base data (Bayut Push API provides different types — call/whatsapp/email)
    const portal = "Bayut";
    const sourceType = lead?.lead_type || "call"; // call / whatsapp / email etc.
    const leadTime = lead?.created_at || new Date().toISOString();
    const channel = lead?.lead_type || "call";

    // Caller details (buyer/enquirer)
    const customerName = lead?.enquirer?.name || "Bayut Lead";
    const customerPhone = normalizePhone(lead?.enquirer?.phone_number);
    const customerEmail = lead?.enquirer?.email || null;

    // Agent / Listing info
    const agentName = lead?.agent?.name || "";
    const agentPhone = normalizePhone(lead?.agent?.phone);
    const agentEmail = lead?.agent?.email || "";
    const listingRef = lead?.listing?.reference || "";
    const listingTitle = lead?.listing?.title || "";
    const listingPrice = lead?.listing?.price || 0;
    const listingBeds = lead?.listing?.bedrooms || null;
    const listingSize = lead?.listing?.size || null;
    const listingFurnished = lead?.listing?.furnished_status || null;
    const listingType = lead?.listing?.type || null;
    const listingVerified = lead?.listing?.verified || null;
    const listingCategory = lead?.listing?.category || null;
    const listingUrl = lead?.listing?.url || "";

    // Create / Find person (customer)
    let personId = await findPerson({
      email: customerEmail,
      phone: customerPhone,
    });
    if (!personId) {
      const p = await pdPost("/persons", {
        name: customerName,
        ...(customerEmail
          ? { email: [{ value: customerEmail, primary: true }] }
          : {}),
        ...(customerPhone
          ? { phone: [{ value: customerPhone, primary: true }] }
          : {}),
      });
      if (!p.success) throw new Error("Person create failed");
      personId = p.data.id;
    }

    // Create Deal in Clients pipeline (4)
    const dealTitle = `${customerName} | ${listingTitle} | ${listingRef} (${channel})`;
    const dealPayload = {
      title: dealTitle,
      person_id: personId,
      value: listingPrice,
      currency: DEFAULT_CURRENCY,
      pipeline_id: 4,
      status: "open",
      visible_to: "3",

      // ✅ Basic source mapping
      dd33ab8a28f1855b734beab08987eb86933706fa: channel, // Source Type
      e0c51e09b74263ff900e7d7a1ca4b00d06e58bcf: listingRef, // Listing Ref
      cd786e99a8fc60d9d437d9540b5e49f1937ab8ea: listingPrice, // Listing Price
      "12dbd54260ad300537c002bd423cf48ecc618e8e": leadTime, // Enquiry Date
      "8db7b87dc9d9147db03b063ee9e678d236879791": customerPhone, // WhatsApp Number

      // ✅ Agent details
      "2fec03e9ce0f41f43c929cbbb1c628e9ec3db3bc": agentName,
      "213b8e2bdbc862b02296cc0233af26689beb4e0a": agentPhone,
      "146ce25cf22cf5635f7cabde8c81214ff2202c2c": agentEmail,

      // ✅ Listing info
      "50332e118438da736f8b85d589d24448da38bd5e": listingBeds,
      aea31d4cd4f0db5db2991d08051a52094b53704b: listingSize,
      "5611eb969142e83db4b1e8bee1463a55da8b341c": listingFurnished,
      d30bed5545084db670f2a84815adf7eb120d5773: listingType,
      eb855d59f7d59f5b352c1ad2e3bb518752382f2d: listingVerified,
      ba303d13dded1058170bf910484040e4129db439: listingCategory,
      "53966df67e491c5ed892a94d250f980ea6a00eeb": listingTitle,
    };

    const deal = await pdPost("/deals", dealPayload);
    if (!deal.success) throw new Error("Deal creation failed");

    // Add Note
    const note = {
      deal_id: deal.data.id,
      content: [
        `**Portal:** ${portal}`,
        `**Lead Type:** ${sourceType}`,
        `**Agent:** ${agentName}`,
        `**Agent Email:** ${agentEmail}`,
        `**Agent Phone:** ${agentPhone}`,
        `**Customer:** ${customerName}`,
        `**Customer Phone:** ${customerPhone}`,
        `**Listing Ref:** ${listingRef}`,
        `**Listing URL:** ${listingUrl}`,
        "",
        "**Raw JSON:**",
        "```json",
        JSON.stringify(lead, null, 2),
        "```",
      ].join("\n"),
    };
    await pdPost("/notes", note);

    await sendLog("✅ Bayut lead processed successfully", {
      deal_id: deal.data.id,
      person_id: personId,
    });

    res.status(200).json({ success: true, deal_id: deal.data.id });
  } catch (err) {
    console.error("❌ Bayut webhook error:", err);
    await sendLog("❌ Error in Bayut webhook", {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Place near top of file ---
import crypto from "crypto";

// If you don't already capture raw body globally, add a route-level raw parser:
app.post(
  "/webhook/dubizzle",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      // 1) Verify signature
      const secret = process.env.DUBIZZLE_SECRET || "";
      const rawBody = req.body?.toString("utf8") || "";
      const receivedSig = (
        req.get("X-dubizzle-Signature") ||
        req.get("x-dubizzle-signature") ||
        ""
      ).trim();
      const expectedSig = crypto
        .createHash("md5")
        .update(secret + rawBody)
        .digest("hex");

      if (!secret || !receivedSig || receivedSig !== expectedSig) {
        await sendLog("❌ Dubizzle signature verification failed", {
          receivedSig,
          expectedSig,
          hasSecret: !!secret,
        });
        return res
          .status(401)
          .json({ success: false, error: "Invalid signature" });
      }

      // 2) Parse payload
      let lead;
      try {
        lead = JSON.parse(rawBody);
      } catch {
        await sendLog("❌ Dubizzle invalid JSON");
        return res.status(400).json({ success: false, error: "Invalid JSON" });
      }

      await sendLog("📩 Incoming Dubizzle webhook (verified)", lead);

      // 3) Extract data (per Dubizzle Push API WhatsApp payload)
      const portal = "Dubizzle";
      const channel = "whatsapp"; // per Push payload type
      const enquiryDate = lead?.received_at || new Date().toISOString();

      const customerName = lead?.enquirer?.name || "Dubizzle Lead";
      const customerPhone = normalizePhone(lead?.enquirer?.phone_number);
      const responseUrl = lead?.enquirer?.contact_link || ""; // chat contact link

      const listingRef = lead?.listing?.reference || "";
      const listingUrl = lead?.listing?.url || "";
      const listingTitle = ""; // Dubizzle Push payload does not include a title
      const listingPrice = 0; // Not present in Push payload

      // 4) Create / update Person (customer)
      let personId = await findPerson({ phone: customerPhone });
      if (!personId) {
        const p = await pdPost("/persons", {
          name: customerName,
          ...(customerPhone
            ? { phone: [{ value: customerPhone, primary: true }] }
            : {}),
        });
        if (!p?.success)
          throw new Error(`Person create failed: ${JSON.stringify(p)}`);
        personId = p.data.id;
      } else {
        // Optional: update basic details
        await pdPut(`/persons/${personId}`, {
          name: customerName,
          ...(customerPhone
            ? { phone: [{ value: customerPhone, primary: true }] }
            : {}),
        });
      }

      // 5) Create Deal in Clients pipeline (id=4) with your custom mappings
      const dealTitle = `${customerName}${
        listingTitle ? " | " + listingTitle : ""
      }${listingRef ? " | " + listingRef : ""} (${channel})`;

      const dealPayload = {
        title: dealTitle,
        person_id: personId,
        value: listingPrice,
        currency: DEFAULT_CURRENCY,
        pipeline_id: 4,
        status: "open",
        visible_to: "3",

        // --- Your existing custom fields ---
        // Source Type (Op)
        dd33ab8a28f1855b734beab08987eb86933706fa: channel,
        // Listing Ref (Op)
        e0c51e09b74263ff900e7d7a1ca4b00d06e58bcf: listingRef,
        // Listing Price (Op) -> 0 (not provided by Dubizzle Push)
        cd786e99a8fc60d9d437d9540b5e49f1937ab8ea: listingPrice,
        // Response URL (Op) -> use contact link if present; else listing URL
        "167d14dc0b5099bed92a67e682d7ddcbc14fd878":
          responseUrl || listingUrl || null,
        // Enquiry Date (Op)
        "12dbd54260ad300537c002bd423cf48ecc618e8e": enquiryDate,
        // WhatsApp Number (Deal)
        "8db7b87dc9d9147db03b063ee9e678d236879791": customerPhone || null,

        // Fields you mapped for PF/Bayut which aren't present in Dubizzle Push payload
        // will simply be omitted or left null here (agent details, title, etc.)
        "53966df67e491c5ed892a94d250f980ea6a00eeb": listingTitle || null, // Listing Title (if you later enrich)
      };

      const deal = await pdPost("/deals", dealPayload);
      if (!deal?.success)
        throw new Error(`Deal creation failed: ${JSON.stringify(deal)}`);

      // 6) Add a note with raw JSON for audit
      const note = {
        deal_id: deal.data.id,
        content: [
          `**Portal:** ${portal}`,
          `**Channel:** ${channel}`,
          `**Listing Ref:** ${listingRef}`,
          `**Listing URL:** ${listingUrl}`,
          `**Contact Link:** ${responseUrl}`,
          "",
          "**Raw JSON:**",
          "```json",
          JSON.stringify(lead, null, 2),
          "```",
        ].join("\n"),
      };
      await pdPost("/notes", note);

      await sendLog("✅ Dubizzle lead → Deal created", {
        deal_id: deal.data.id,
        person_id: personId,
      });

      res
        .status(200)
        .json({ success: true, deal_id: deal.data.id, person_id: personId });
    } catch (err) {
      console.error("❌ Dubizzle webhook error:", err);
      await sendLog("❌ Error in Dubizzle webhook", {
        error: err.message,
        stack: err.stack,
      });
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

/* -------------------- START -------------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🚀 PF Atlas → Pipedrive webhook running on ${PORT}`)
);
