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
  // 1. Handle Slack URL Verification Challenge
  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  // Always respond 200 OK immediately to Slack
  res.status(200).send('OK');

  const event = req.body.event;

  // 2. Filter: Ignore bot messages & ensure files exist
  if (!event || event.bot_id || event.subtype === 'bot_message') return;
  if (!event.files || event.files.length === 0) return;

  const channel = event.channel;
  const threadTs = event.ts;
  const pdfFile = event.files.find(f => f.mimetype === 'application/pdf') || event.files[0];

  try {
    // 3. Add 👀 Reaction via Bot Account
    await axios.post('https://slack.com/api/reactions.add', {
      channel: channel,
      timestamp: threadTs,
      name: 'eyes'
    }, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });

    // 4. Send Initial In-Thread Waiting Status Message
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: channel,
      thread_ts: threadTs,
      text: "⌛ Document received! Extracting address and submitting to IntelliPrint... Status: Waiting to print."
    }, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });

    // 5. Download Private PDF Document from Slack
    const pdfResponse = await axios.get(pdfFile.url_private, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      responseType: 'arraybuffer'
    });
    const pdfBuffer = Buffer.from(pdfResponse.data);

    // 6. Extract Address via Gemini Flash
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `Extract the postal delivery recipient details from this document as valid JSON with keys: name, line_1, postal_code, country, postage_service (default to "uk_second_class").`;
    
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

    // 7. Submit Multipart Request to IntelliPrint
    const form = new FormData();
    form.append('type', 'letter');
    form.append('confirmed', 'true');
    form.append('testmode', 'true');
    form.append('recipients[0][address][name]', addressData.name || 'Recipient');
    form.append('recipients[0][address][line]', addressData.line_1 || '');
    form.append('recipients[0][address][postcode]', addressData.postal_code || '');
    form.append('recipients[0][address][country]', addressData.country || 'UK');
    form.append('postage[service]', addressData.postage_service || 'uk_second_class');
    form.append('file', pdfBuffer, { filename: 'document.pdf', contentType: 'application/pdf' });

    const printResponse = await axios.post('https://api.intelliprint.net/v1/prints', form, {
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${INTELLIPRINT_KEY}`
      }
    });

    // 8. Post Final Confirmation In-Thread
    const printId = printResponse.data?.id || printResponse.data?.print_id || 'Submitted';
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: channel,
      thread_ts: threadTs,
      text: `✅ Print Job Submitted Successfully! Job ID: ${printId}`
    }, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });

    // 9. Log Transaction to Airtable
    if (AIRTABLE_KEY && AIRTABLE_BASE_ID) {
      await axios.post(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Print%20Logs`, {
        records: [
          {
            fields: {
              "Print ID": String(printId),
              "Requester": String(event.user),
              "Recipient Name": String(addressData.name || 'Unknown'),
              "Type of Postage": String(addressData.postage_service || 'uk_second_class'),
              "Status": "Submitted",
              "Date of Request": new Date().toISOString(),
              "Slack Thread TS": String(threadTs)
            }
          }
        ]
      }, {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_KEY}`,
          'Content-Type': 'application/json'
        }
      });
      console.log('Successfully logged to Airtable');
    }

  } catch (error) {
    console.error('Workflow Execution Error:', error.response?.data || error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
