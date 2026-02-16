const fs = require('fs');
const path = require('path');
const envPath = path.resolve(__dirname, '..', '.env');
for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq);
  let val = trimmed.slice(eq + 1);
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (!process.env[key]) process.env[key] = val;
}

const { google } = require('googleapis');
const auth = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET);
auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
const gmail = google.gmail({ version: 'v1', auth });

const messageId = process.argv[2];
if (!messageId) { console.error('Usage: node scripts/gmail-read.js <messageId>'); process.exit(1); }

(async () => {
  const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const headers = msg.data.payload.headers;
  const from = headers.find(h => h.name === 'From')?.value;
  const to = headers.find(h => h.name === 'To')?.value;
  const subject = headers.find(h => h.name === 'Subject')?.value;
  const date = headers.find(h => h.name === 'Date')?.value;
  console.log('From:', from);
  console.log('To:', to);
  console.log('Subject:', subject);
  console.log('Date:', date);
  console.log('Thread:', msg.data.threadId);
  console.log('---');

  function getBody(payload) {
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    }
    if (payload.parts) {
      const plain = payload.parts.find(p => p.mimeType === 'text/plain');
      if (plain?.body?.data) return Buffer.from(plain.body.data, 'base64url').toString('utf-8');
      for (const part of payload.parts) {
        if (part.parts) { const r = getBody(part); if (r) return r; }
      }
    }
    return '';
  }
  console.log(getBody(msg.data.payload));
})();
