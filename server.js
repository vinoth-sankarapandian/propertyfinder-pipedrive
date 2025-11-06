import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import dayjs from "dayjs";
dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

/* -------------------- CONFIG -------------------- */
const PD_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const PD_DOMAIN =
  process.env.PIPEDRIVE_DOMAIN || "https://api.pipedrive.com/v1";
const CLIENTS_PIPELINE_ID = Number(process.env.CLIENTS_PIPELINE_ID || 4);
const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || "AED";

const PF_API_KEY = process.env.PF_API_KEY;
const PF_API_SECRET = process.env.PF_API_SECRET;

const PF_SECRET_KEY = process.env.PF_SECRET_KEY || ""; // optional webhook auth
const ATLAS_BASE = "https://atlas.propertyfinder.com/v1";

/* ---- guard invalid Pipedrive domain (common mistake) ---- */
// if (
//   !/^https:\/\/(api\.pipedrive\.com|[a-z0-9-]+\.pipedrive\.com)\/api\/v1$/i.test(
//     PD_DOMAIN
//   )
// ) {
//   throw new Error(
//     `Invalid PIPEDRIVE_DOMAIN: ${PD_DOMAIN}. Use https://api.pipedrive.com/v1 or https://<company>.pipedrive.com/api/v1`
//   );
// }

/* -------------------- ATLAS TOKEN CACHE -------------------- */
let atlasToken = null;
let atlasTokenExpiry = 0;

async function getAtlasToken() {
  const now = Date.now();
  if (atlasToken && now < atlasTokenExpiry) return atlasToken;

  const res = await fetch(`${ATLAS_BASE}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: PF_API_KEY, apiSecret: PF_API_SECRET }),
  });

  const data = await res.json();
  if (!data?.accessToken) {
    throw new Error(`Atlas token error: ${JSON.stringify(data)}`);
  }

  atlasToken = data.accessToken;
  // refresh 1 minute early
  atlasTokenExpiry = now + Number(data.expiresIn || 3600) * 1000 - 60_000;
  return atlasToken;
}

async function atlasGet(endpointWithQuery) {
  const token = await getAtlasToken();
  const r = await fetch(`${ATLAS_BASE}${endpointWithQuery}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(
      `Atlas GET ${endpointWithQuery} failed: ${r.status} ${text}`
    );
  }
  return r.json();
}

/* -------------------- PIPEDRIVE HELPERS -------------------- */
async function pdGet(path) {
  const r = await fetch(
    `${PD_DOMAIN}${path}${path.includes("?") ? "&" : "?"}api_token=${PD_TOKEN}`
  );
  return r.json();
}

async function pdPost(path, body) {
  const r = await fetch(`${PD_DOMAIN}${path}?api_token=${PD_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function pdPut(path, body) {
  const r = await fetch(`${PD_DOMAIN}${path}?api_token=${PD_TOKEN}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
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

/* -------------------- UTILS -------------------- */
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

function buildNote({ lead, user, listing }) {
  const lines = [];
  lines.push(`**Portal:** Property Finder`);
  if (lead?.channel) lines.push(`**Channel:** ${lead.channel}`);
  if (lead?.status) lines.push(`**Lead Status:** ${lead.status}`);
  if (lead?.createdAt) lines.push(`**Lead Created At:** ${lead.createdAt}`);
  if (lead?.responseLink) lines.push(`**Response Link:** ${lead.responseLink}`);

  if (user) {
    const fullName =
      [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
      user?.publicProfile?.name;
    if (fullName) lines.push(`**User Name:** ${fullName}`);
    if (user.email || user?.publicProfile?.email)
      lines.push(`**User Email:** ${user.email || user.publicProfile.email}`);
    const phone =
      user.mobile ||
      user?.publicProfile?.whatsappPhone ||
      user?.publicProfile?.phone;
    if (phone) lines.push(`**User Phone:** ${phone}`);
    if (user?.publicProfile?.linkedinAddress)
      lines.push(`**LinkedIn:** ${user.publicProfile.linkedinAddress}`);
    if (
      Array.isArray(user?.publicProfile?.compliances) &&
      user.publicProfile.compliances.length
    ) {
      const brn = user.publicProfile.compliances.find(
        (c) => c.type === "brn"
      )?.value;
      if (brn) lines.push(`**BRN:** ${brn}`);
    }
  }

  if (listing) {
    if (listing.reference) lines.push(`**Listing Ref:** ${listing.reference}`);
    if (listing.title?.en) lines.push(`**Listing Title:** ${listing.title.en}`);
    const amount = listing?.price?.amounts?.yearly;
    if (amount) lines.push(`**Price (yearly):** ${amount} AED`);
    if (listing.uaeEmirate) lines.push(`**Emirate:** ${listing.uaeEmirate}`);
    if (listing.type) lines.push(`**Type:** ${listing.type}`);
    if (listing.bedrooms) lines.push(`**Bedrooms:** ${listing.bedrooms}`);
    if (listing.bathrooms) lines.push(`**Bathrooms:** ${listing.bathrooms}`);
    if (listing.furnishingType)
      lines.push(`**Furnishing:** ${listing.furnishingType}`);
    if (listing.availableFrom)
      lines.push(`**Available From:** ${listing.availableFrom}`);
  }

  lines.push("");
  lines.push("**Raw Lead JSON:**");
  lines.push("```json");
  lines.push(JSON.stringify(lead, null, 2));
  lines.push("```");
  return lines.join("\n");
}

/* -------------------- ROUTES -------------------- */
app.get("/", (_, res) =>
  res.send("✅ PF Atlas → Pipedrive webhook is running")
);

app.post("/webhook", async (req, res) => {
  try {
    // Optional shared-secret check
    if (PF_SECRET_KEY) {
      const key = req.headers["x-api-key"];
      if (!key || key !== PF_SECRET_KEY)
        return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const evt = req.body;
    if (evt?.type !== "lead.created") {
      return res.status(200).json({
        success: true,
        ignored: true,
        reason: "Not a lead.created event",
      });
    }

    // 1) Pull full lead from Atlas (/leads?id=...)
    const leadId = evt?.entity?.id;
    if (!leadId) throw new Error("Missing lead id");
    const leadResp = await atlasGet(`/leads?id=${encodeURIComponent(leadId)}`);
    const lead = leadResp?.data?.[0];
    if (!lead) throw new Error("Lead not found on Atlas");

    const channel = lead.channel || null;
    const publicProfileId = lead.publicProfile?.id || null;
    const listingId = lead.listing?.id || null;

    // 2) Person comes from USERS API (source of truth)
    let user = null;
    if (publicProfileId) {
      const userResp = await atlasGet(
        `/users?publicProfileId=${encodeURIComponent(publicProfileId)}`
      );
      user = userResp?.data?.[0] || null;
    }

    // Extract person fields from USERS (fallback to lead if missing)
    const fullNameFromUser =
      [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() ||
      user?.publicProfile?.name ||
      lead?.sender?.name ||
      "Property Finder Lead";
    const emailFromUser = user?.email || user?.publicProfile?.email || null;
    const phoneFromUser = normalizePhone(
      user?.mobile ||
        user?.publicProfile?.whatsappPhone ||
        user?.publicProfile?.phone ||
        (lead?.sender?.contacts || []).find(
          (c) => (c.type || "").toLowerCase() === "phone"
        )?.value
    );

    // 3) Listing details
    let listing = null;
    if (listingId) {
      const listingResp = await atlasGet(
        `/listings?filter[ids]=${encodeURIComponent(listingId)}`
      );
      listing = listingResp?.results?.[0] || null;
    }

    // 4) Find or create (or update) Person in Pipedrive
    let personId = await findPerson({
      email: emailFromUser,
      phone: phoneFromUser,
    });
    if (!personId) {
      const personPayload = {
        name: fullNameFromUser,
        ...(emailFromUser
          ? { email: [{ value: emailFromUser, primary: true }] }
          : {}),
        ...(phoneFromUser
          ? { phone: [{ value: phoneFromUser, primary: true }] }
          : {}),
        // Optional: map extra to custom fields (replace keys accordingly):
        // "person_linkedin_cf": user?.publicProfile?.linkedinAddress,
        // "person_brn_cf":      (user?.publicProfile?.compliances || []).find(c => c.type === "brn")?.value,
        // "person_role_cf":     user?.role?.name
      };
      const p = await pdPost("/persons", personPayload);
      if (!p?.success)
        throw new Error(`Create person failed: ${JSON.stringify(p)}`);
      personId = p.data.id;
    } else {
      // Optional: keep person updated with fresher PF data
      const updatePayload = {
        name: fullNameFromUser,
        ...(emailFromUser
          ? { email: [{ value: emailFromUser, primary: true }] }
          : {}),
        ...(phoneFromUser
          ? { phone: [{ value: phoneFromUser, primary: true }] }
          : {}),
      };
      await pdPut(`/persons/${personId}`, updatePayload);
    }

    // 5) Create Deal in Clients pipeline
    const dealTitle = buildDealTitle({
      name: fullNameFromUser,
      listingRef: listing?.reference,
      listingTitle: listing?.title?.en,
      channel,
    });
    const dealAmount = Number(listing?.price?.amounts?.yearly || 0);

    const dealPayload = {
      title: dealTitle,
      person_id: personId,
      value: dealAmount,
      currency: DEFAULT_CURRENCY,
      pipeline_id: CLIENTS_PIPELINE_ID,
      status: "open",
      visible_to: "3",
      // Optional:
      // stage_id: <your stage id in Clients pipeline>,
      // "deal_listing_reference_cf": listing?.reference,
      // "deal_listing_id_cf": listingId,
      // "deal_channel_cf": channel
    };

    const d = await pdPost("/deals", dealPayload);
    if (!d?.success)
      throw new Error(`Create deal failed: ${JSON.stringify(d)}`);
    const dealId = d.data.id;

    // 6) Add Note with PF context + raw JSON
    const noteContent = buildNote({ lead, user, listing });
    const noteResp = await pdPost("/notes", {
      deal_id: dealId,
      content: noteContent,
    });
    if (!noteResp?.success) {
      console.warn("Note creation failed:", noteResp);
    }

    return res.status(200).json({
      success: true,
      pipedrive_person_id: personId,
      pipedrive_deal_id: dealId,
    });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* -------------------- START -------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 PF Atlas → Pipedrive webhook running on ${PORT}`)
);
