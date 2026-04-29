const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors()); // allow all origins — restrict in production
app.use(express.json());

// ── CONFIG ──────────────────────────────────────────
const CONSUMER_KEY    = '6GGP54twqjaXCqD4aoLDxgLWLQhWoAAd9MCniMsqEtMrzxAY';
const CONSUMER_SECRET = 'v1IrA9duGItyEEIBBqIeHfZ7WvWMIaG4SsvLZi9XW4HzqAuS2GsaR4gOrmXekF3E';
const SHORTCODE       = '174379';
const PASSKEY         = 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
const ENV             = 'sandbox'; // change to 'production' when going live
const BASE            = ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// ── HELPERS ─────────────────────────────────────────
function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function password(ts) {
  return Buffer.from(SHORTCODE + PASSKEY + ts).toString('base64');
}

function normPhone(p) {
  p = p.replace(/\D/g, '');
  if (p.startsWith('0') && p.length === 10)  return '254' + p.slice(1);
  if (p.startsWith('254') && p.length === 12) return p;
  if (p.startsWith('7') && p.length === 9)    return '254' + p;
  return null;
}

// ── ROUTES ──────────────────────────────────────────

// 1. Health check
app.get('/', (req, res) => res.json({ status: 'StrikerBet M-Pesa server running ✓' }));

// 2. Get OAuth Token
app.get('/token', async (req, res) => {
  try {
    const creds = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
    const r = await axios.get(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${creds}` }
    });
    res.json({ access_token: r.data.access_token });
  } catch (e) {
    console.error('Token error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// 3. STK Push
app.post('/stkpush', async (req, res) => {
  try {
    const { phone, amount, callbackUrl } = req.body;
    const normalizedPhone = normPhone(phone);
    if (!normalizedPhone) return res.status(400).json({ error: 'Invalid phone number' });

    // Get token
    const creds = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
    const tokenResp = await axios.get(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${creds}` }
    });
    const token = tokenResp.data.access_token;

    const ts  = timestamp();
    const pwd = password(ts);
    const CALLBACK = callbackUrl || `https://${req.hostname}/callback`;

    const body = {
      BusinessShortCode: SHORTCODE,
      Password:          pwd,
      Timestamp:         ts,
      TransactionType:   'CustomerPayBillOnline',
      Amount:            Math.floor(amount),
      PartyA:            normalizedPhone,
      PartyB:            SHORTCODE,
      PhoneNumber:       normalizedPhone,
      CallBackURL:       CALLBACK,
      AccountReference:  'StrikerBet',
      TransactionDesc:   'StrikerBet Deposit',
    };

    const r = await axios.post(`${BASE}/mpesa/stkpush/v1/processrequest`, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });

    console.log(`✓ STK Push sent to ${normalizedPhone} | Amount: ${amount} | CheckoutID: ${r.data.CheckoutRequestID}`);
    res.json(r.data);

  } catch (e) {
    console.error('STK Push error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// 4. STK Query (check payment status)
app.post('/stkquery', async (req, res) => {
  try {
    const { checkoutRequestId } = req.body;

    const creds = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
    const tokenResp = await axios.get(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${creds}` }
    });
    const token = tokenResp.data.access_token;

    const ts  = timestamp();
    const pwd = password(ts);

    const r = await axios.post(`${BASE}/mpesa/stkpushquery/v1/query`, {
      BusinessShortCode: SHORTCODE,
      Password:          pwd,
      Timestamp:         ts,
      CheckoutRequestID: checkoutRequestId,
    }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });

    res.json(r.data);
  } catch (e) {
    console.error('STK Query error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// 5. M-Pesa Callback (Safaricom posts here after payment)
app.post('/callback', (req, res) => {
  const body = req.body;
  console.log('M-Pesa Callback received:', JSON.stringify(body, null, 2));

  const stkCallback = body?.Body?.stkCallback;
  if (stkCallback) {
    const { ResultCode, ResultDesc, CallbackMetadata } = stkCallback;
    if (ResultCode === 0) {
      const items = CallbackMetadata?.Item || [];
      const get   = name => items.find(i => i.Name === name)?.Value;
      console.log('✓ Payment SUCCESS:', {
        amount:    get('Amount'),
        receipt:   get('MpesaReceiptNumber'),
        phone:     get('PhoneNumber'),
        timestamp: get('TransactionDate'),
      });
    } else {
      console.log('✗ Payment FAILED:', ResultDesc);
    }
  }
  // Always respond with 200 to Safaricom
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// ── START ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 StrikerBet M-Pesa server running on port ${PORT}`);
  console.log(`   Environment: ${ENV.toUpperCase()}`);
  console.log(`   Shortcode:   ${SHORTCODE}\n`);
});
