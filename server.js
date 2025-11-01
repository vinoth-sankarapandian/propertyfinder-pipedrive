import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

// Basic check route
app.get("/", (req, res) => res.send("✅ Property Finder → Pipedrive is live"));

// Main webhook endpoint
app.post("/webhook", async (req, res) => {
  try {
    const lead = req.body;
    console.log("Received lead:", lead);

    const PD_TOKEN = process.env.PIPEDRIVE_API_TOKEN;

    const personPayload = {
      name: lead.name || "Property Finder Lead",
      email: lead.email ? [{ value: lead.email, primary: true }] : [],
      phone: lead.phone ? [{ value: lead.phone, primary: true }] : [],
    };

    // Create person
    const personRes = await fetch(
      `https://api.pipedrive.com/v1/persons?api_token=${PD_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(personPayload),
      }
    );
    const personData = await personRes.json();
    const personId = personData.data?.id;
    if (!personId) throw new Error("Failed to create person");

    // Create deal
    const dealPayload = {
      title: `${lead.name || "PF Lead"} - ${lead.listing_id || ""}`,
      person_id: personId,
      value: lead.budget || 0,
      currency: lead.currency || "AED",
    };

    const dealRes = await fetch(
      `https://api.pipedrive.com/v1/deals?api_token=${PD_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dealPayload),
      }
    );
    const dealData = await dealRes.json();

    res.json({ success: true, person: personData.data, deal: dealData.data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
