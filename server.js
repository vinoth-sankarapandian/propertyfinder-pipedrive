import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

const PD_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const PD_DOMAIN =
  process.env.PIPEDRIVE_DOMAIN || "https://api.pipedrive.com/v1";

// 🔍 Helper: search existing person by email or phone
async function findPerson({ email, phone }) {
  try {
    // Search by email first
    if (email) {
      const emailSearch = await fetch(
        `${PD_DOMAIN}/persons/search?term=${encodeURIComponent(
          email
        )}&fields=email&exact_match=true&api_token=${PD_TOKEN}`
      );
      const emailRes = await emailSearch.json();
      const found = emailRes.data?.items?.[0]?.item;
      if (found?.id) return found.id;
    }

    // Search by phone next
    if (phone) {
      const phoneSearch = await fetch(
        `${PD_DOMAIN}/persons/search?term=${encodeURIComponent(
          phone
        )}&fields=phone&exact_match=true&api_token=${PD_TOKEN}`
      );
      const phoneRes = await phoneSearch.json();
      const found = phoneRes.data?.items?.[0]?.item;
      if (found?.id) return found.id;
    }
  } catch (err) {
    console.error("❌ Error searching person:", err);
  }
  return null;
}

// 🧠 Health check
app.get("/", (_, res) => res.send("✅ Pipedrive Deal Webhook is live"));

// 🚀 Main webhook endpoint
app.post("/webhook", async (req, res) => {
  try {
    const lead = req.body;
    console.log("📩 Incoming data:", lead);

    const email = lead.email?.trim();
    const phone = lead.phone?.trim();

    // 1️⃣ Find person by email or phone
    let personId = await findPerson({ email, phone });

    // 2️⃣ If not found, create new person
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
      console.log("👤 Person create response:", personResp);
      personId = personResp.data?.id;
    } else {
      console.log("👤 Existing person found:", personId);
    }

    if (!personId) throw new Error("Person could not be found or created");

    // 3️⃣ Create Deal linked to that person
    const dealPayload = {
      title: lead.title || `New Deal - ${lead.name || "Unknown"}`,
      person_id: personId,
      value: lead.value || 0,
      currency: lead.currency || "AED",
      status: "open",
      visible_to: "3", // 3 = owner & followers
      // Add optional fields if needed:
      // "pipeline_id": 1,
      // "stage_id": 2,
      // "custom_field_key": "value"
    };

    console.log("🧾 Creating Deal with payload:", dealPayload);

    const createDeal = await fetch(`${PD_DOMAIN}/deals?api_token=${PD_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dealPayload),
    });

    const dealResp = await createDeal.json();
    console.log("📦 Deal response:", dealResp);

    if (!dealResp.success) {
      throw new Error(`Deal not created: ${JSON.stringify(dealResp)}`);
    }

    res.status(200).json({
      success: true,
      pipedrive_person_id: personId,
      pipedrive_deal_id: dealResp.data?.id,
    });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 🚀 Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
