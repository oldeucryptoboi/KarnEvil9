const fs = require('fs');
const path = require('path');
// Load .env manually
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

const auth = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET
);
auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

const gmail = google.gmail({ version: 'v1', auth });

(async () => {
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread newer_than:1d',
    maxResults: 10,
  });
  const messages = res.data.messages || [];
  if (messages.length === 0) { console.log('No unread emails from today.'); return; }

  for (const m of messages) {
    const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full', metadataHeaders: ['From', 'Subject', 'Date'] });
    const headers = msg.data.payload.headers;
    const from = headers.find(h => h.name === 'From')?.value ?? '?';
    const subject = headers.find(h => h.name === 'Subject')?.value ?? '(no subject)';
    const date = headers.find(h => h.name === 'Date')?.value ?? '?';
    const snippet = msg.data.snippet ?? '';
    console.log('---');
    console.log('From:', from);
    console.log('Subject:', subject);
    console.log('Date:', date);
    console.log('Snippet:', snippet);
    console.log('ID:', m.id, '| Thread:', m.threadId);
  }
})();
