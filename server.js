import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

const PD_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const PD_DOMAIN =
  process.env.PIPEDRIVE_DOMAIN || "https://api.pipedrive.com/v1";

// 🔍 Helper: find existing person
async function findPerson({ email, phone }) {
  try {
    if (email) {
      const r = await fetch(
        `${PD_DOMAIN}/persons/search?term=${encodeURIComponent(
          email
        )}&fields=email&exact_match=true&api_token=${PD_TOKEN}`
      );
      const j = await r.json();
      const item = j.data?.items?.[0]?.item;
      if (item?.id) return item.id;
    }
    if (phone) {
      const r = await fetch(
        `${PD_DOMAIN}/persons/search?term=${encodeURIComponent(
          phone
        )}&fields=phone&api_token=${PD_TOKEN}`
      );
      const j = await r.json();
      const item = j.data?.items?.[0]?.item;
      if (item?.id) return item.id;
    }
  } catch (err) {
    console.error("❌ Error searching person:", err);
  }
  return null;
}

app.get("/", (_, res) => res.send("✅ Pipedrive Lead Webhook is running"));

app.post("/webhook", async (req, res) => {
  try {
    const lead = req.body;
    console.log("📩 Incoming lead:", lead);

    const email = lead.email?.trim();
    const phone = lead.phone?.trim();

    // 1️⃣ Search for person
    let personId = await findPerson({ email, phone });

    // 2️⃣ If not found → create new person
    if (!personId) {
      const personPayload = {
        name: lead.name || "Webhook Lead",
        email: email ? [{ value: email, primary: true }] : [],
        phone: phone ? [{ value: phone, primary: true }] : [],
      };
      const createPerson = await fetch(
        `${PD_DOMAIN}/persons?api_token=${PD_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(personPayload),
        }
      );
      const personResp = await createPerson.json();
      console.log("👤 Person API response:", personResp);
      personId = personResp.data?.id;
    } else {
      console.log("👤 Using existing person ID:", personId);
    }

    if (!personId) throw new Error("Person not found or created");

    // 3️⃣ Create Lead
    const leadPayload = {
      title: lead.title || `New Lead - ${lead.name || "Unknown"}`,
      person_id: personId,
      value: lead.value || 0,
      currency: lead.currency || "AED",
      note: lead.message || "Created via webhook",
    };

    console.log("🧾 Creating Lead with payload:", leadPayload);

    const createLead = await fetch(`${PD_DOMAIN}/leads?api_token=${PD_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(leadPayload),
    });

    const leadResp = await createLead.json();
    console.log("📦 Lead API response:", leadResp);

    if (!leadResp.success) {
      throw new Error(
        `Pipedrive Lead not created: ${JSON.stringify(leadResp)}`
      );
    }

    res.status(200).json({
      success: true,
      pipedrive_person_id: personId,
      pipedrive_lead_id: leadResp.data?.id,
    });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook running on port ${PORT}`));
