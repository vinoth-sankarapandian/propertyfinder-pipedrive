import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

// ✅ Health check
app.get("/", (req, res) => {
  res.send("✅ Pipedrive Lead Webhook is running");
});

// 🚀 Webhook endpoint to create a lead in Pipedrive
app.post("/webhook", async (req, res) => {
  try {
    const lead = req.body;
    console.log("Received Lead Payload:", lead);

    // --- REQUIRED CONFIG ---
    const PD_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
    const PD_DOMAIN =
      process.env.PIPEDRIVE_DOMAIN || "https://api.pipedrive.com/v1";

    // --- Create a Person (optional but recommended) ---
    const personPayload = {
      name: lead.name || "New Lead",
      email: lead.email ? [{ value: lead.email, primary: true }] : [],
      phone: lead.phone ? [{ value: lead.phone, primary: true }] : [],
    };

    const personResp = await fetch(
      `${PD_DOMAIN}/persons?api_token=${PD_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(personPayload),
      }
    );
    const personData = await personResp.json();
    const personId = personData.data?.id;
    console.log("Person created:", personId);

    // --- Create the Lead ---
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
    console.log("Lead created:", leadData.data);

    res.status(200).json({
      success: true,
      pipedrive_lead_id: leadData.data?.id,
      pipedrive_person_id: personId,
    });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook running on port ${PORT}`));
