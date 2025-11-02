import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

const PD_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const PD_DOMAIN =
  process.env.PIPEDRIVE_DOMAIN || "https://api.pipedrive.com/v1";

// ✅ Helper function: search person by email or phone
async function findPerson({ email, phone }) {
  try {
    if (email) {
      const searchEmail = await fetch(
        `${PD_DOMAIN}/persons/search?term=${encodeURIComponent(
          email
        )}&fields=email&exact_match=true&api_token=${PD_TOKEN}`
      );
      const emailRes = await searchEmail.json();
      const item = emailRes.data?.items?.[0]?.item;
      if (item?.id) return item.id;
    }

    if (phone) {
      const searchPhone = await fetch(
        `${PD_DOMAIN}/persons/search?term=${encodeURIComponent(
          phone
        )}&fields=phone&api_token=${PD_TOKEN}`
      );
      const phoneRes = await searchPhone.json();
      const item = phoneRes.data?.items?.[0]?.item;
      if (item?.id) return item.id;
    }
  } catch (err) {
    console.error("Error finding person:", err);
  }
  return null;
}

// ✅ Health check
app.get("/", (req, res) => res.send("✅ Pipedrive Lead Webhook is running"));

// 🚀 Main webhook endpoint
app.post("/webhook", async (req, res) => {
  try {
    const lead = req.body;
    console.log("Received lead payload:", lead);

    const email = lead.email?.trim();
    const phone = lead.phone?.trim();

    // 1️⃣ Check if person already exists
    let personId = await findPerson({ email, phone });

    // 2️⃣ If not found, create a new person
    if (!personId) {
      const personPayload = {
        name: lead.name || "New Lead",
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
      personId = personResp.data?.id;
      console.log("New person created:", personId);
    } else {
      console.log("Existing person found:", personId);
    }

    // 3️⃣ Create Lead linked to that person
    const leadPayload = {
      title: lead.title || `New Lead - ${lead.name || "Unknown"}`,
      person_id: personId,
      value: lead.value || 0,
      currency: lead.currency || "AED",
      note: lead.message || "Created via webhook",
    };

    const createLead = await fetch(`${PD_DOMAIN}/leads?api_token=${PD_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(leadPayload),
    });
    const leadData = await createLead.json();

    console.log("Lead created:", leadData.data?.id);

    res.status(200).json({
      success: true,
      pipedrive_person_id: personId,
      pipedrive_lead_id: leadData.data?.id,
    });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook running on port ${PORT}`));
