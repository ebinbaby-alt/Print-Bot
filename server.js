const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

// Load Environment Variables
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const INTELLIPRINT_KEY = process.env.INTELLIPRINT_KEY;
const AIRTABLE_KEY = process.env.AIRTABLE_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

app.post('/slack/events', async (req, res) => {
  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  res.status(200).send('OK');

  if (req.headers['x-slack-retry-num']) return;

  const event = req.body.event;

  if (!event || event.bot_id || event.subtype === 'bot_message') return;
  if (!event.files || event.files.length === 0) return;

  const MY_SLACK_ID = "U0A11N56YDC";
  if (event.user !== MY_SLACK_ID) return;
  if (!event.text || !event.text.toLowerCase().includes('print')) return;

  const channel = event.channel;
  const threadTs = event.ts;
  const pdfFile = event.files.find(f => f.mimetype === 'application/pdf') || event.files[0];

  try {
    await axios.post('https://slack.com/api/reactions.add', {
      channel: channel,
      timestamp: threadTs,
      name: 'eyes'
    }, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });

    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: channel,
      thread_ts: threadTs,
      text: "⌛ Processing request, extracting details, and submitting to IntelliPrint..."
    }, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });

    const pdfResponse = await axios.get(pdfFile.url_private, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      responseType: 'arraybuffer'
    });
    const pdfBuffer = Buffer.from(pdfResponse.data);

    const model = genAI.getGenerativeModel({ model: "gemini-3.8-flash" });
    const prompt = `
      Analyze the attached PDF and extract the delivery address. Format it strictly as JSON with these exact keys:
      - "name": The recipient's full name.
      - "line": The full street address/building details (excluding postcode and country). Use \\n for line breaks.
      - "postcode": The postal code.
      - "country": The country (default to "United Kingdom").
      
      Next, analyze this user instruction: "${event.text}".
      Map their request to one of the following exact 'postage_service' API codes:
      - "Second Class" -> 'uk_second_class' (Use this as the DEFAULT if unspecified)
      - "Second Class (Signed For)" -> 'uk_second_class_signed'
      - "First Class" -> 'uk_first_class'
      - "First Class (Signed For)" -> 'uk_first_class_signed'
      - "Tracked 24" -> 'uk_tracked_24'
      - "Tracked 48" -> 'uk_tracked_48'
      - "Special Delivery By 9AM" -> 'uk_special_delivery_9am'
      - "Special Delivery By 1PM" -> 'uk_special_delivery_1pm'
      - "International" -> 'international'

      Return ONLY valid JSON with keys: name, line, postcode, country, postage_service.
    `;
    
    const geminiResult = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: pdfBuffer.toString("base64"),
          mimeType: "application/pdf"
        }
      }
    ]);

    const extractedText = geminiResult.response.text().replace(/```json|```/g, '').trim();
    const addressData = JSON.parse(extractedText);

    const form = new FormData();
    form.append('type', 'letter');
    form.append('confirmed', 'true');
    form.append('recipients[0][address][name]', addressData.name || 'Recipient');
    form.append('recipients[0][address][line]', addressData.line || '');
    form.append('recipients[0][address][address_line1]', addressData.line || '');
    form.append('recipients[0][address][postcode]', addressData.postcode || '');
    form.append('recipients[0][address][country]', addressData.country || 'United Kingdom');
    form.append('postage[service]', addressData.postage_service || 'uk_second_class');
    form.append('file', pdfBuffer, { filename: 'document.pdf', contentType: 'application/pdf' });

    const printResponse = await axios.post('https://api.intelliprint.net/v1/prints', form, {
      headers: { ...form.getHeaders(), 'Authorization': `Bearer ${INTELLIPRINT_KEY}` }
    });

    const printId = printResponse.data?.id || printResponse.data?.print_id || 'Submitted';
    const trackingInfo = printResponse.data?.tracking_number || printResponse.data?.tracking_url || printResponse.data?.tracking_link;
    let successMessage = `✅ Print Job Submitted Successfully!\n*Job ID:* ${printId}\n*Postage:* ${addressData.postage_service}`;
    
    if (trackingInfo) {
      successMessage += `\n📦 *Tracking:* ${trackingInfo}`;
    } else if (addressData.postage_service.includes('tracked') || addressData.postage_service.includes('special')) {
      successMessage += `\n📦 *Tracking:* Will be assigned by Royal Mail upon dispatch.`;
    }

    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: channel,
      thread_ts: threadTs,
      text: successMessage
    }, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });

    if (AIRTABLE_KEY && AIRTABLE_BASE_ID) {
      await axios.post(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Print%20Logs`, {
        records: [{
          fields: {
            "Print ID": String(printId),
            "Requester": String(event.user),
            "Recipient Name": String(addressData.name || 'Unknown'),
            "Type of Postage": String(addressData.postage_service || 'uk_second_class'),
            "Status": "Submitted",
            "Date of Request": new Date().toISOString(),
            "Slack Thread TS": String(threadTs)
          }
        }]
      }, {
        headers: { 'Authorization': `Bearer ${AIRTABLE_KEY}`, 'Content-Type': 'application/json' }
      });
    }

  } catch (error) {
    let detailedError = error.message;
    if (error.response && error.response.data) {
      detailedError = typeof error.response.data === 'object' ? JSON.stringify(error.response.data) : error.response.data;
    }
    
    console.error('Workflow Error:', detailedError);
    
    // Silently log the failure to Airtable without pinging Slack
    if (AIRTABLE_KEY && AIRTABLE_BASE_ID) {
      try {
        await axios.post(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Print%20Logs`, {
          records: [{
            fields: {
              "Print ID": `Error: ${detailedError.substring(0, 100)}...`, // Preview the error in the ID field
              "Requester": String(event.user),
              "Status": "Failed",
              "Date of Request": new Date().toISOString(),
              "Slack Thread TS": String(threadTs)
            }
          }]
        }, {
          headers: { 'Authorization': `Bearer ${AIRTABLE_KEY}`, 'Content-Type': 'application/json' }
        });
      } catch (airtableErr) {
        console.error('Failed to log error to Airtable:', airtableErr.message);
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
