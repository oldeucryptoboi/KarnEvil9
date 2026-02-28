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

function stripHtml(html) {
  // Extract links before stripping tags
  const links = [];
  html.replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, url, text) => {
    const cleanText = text.replace(/<[^>]+>/g, '').trim();
    if (url && !url.startsWith('mailto:')) links.push({ url, text: cleanText });
    return '';
  });

  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, links };
}

function getBody(payload) {
  // Try text/plain first
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return { text: Buffer.from(payload.body.data, 'base64url').toString('utf-8'), links: [] };
  }
  if (payload.parts) {
    const plain = payload.parts.find(p => p.mimeType === 'text/plain');
    if (plain?.body?.data) {
      return { text: Buffer.from(plain.body.data, 'base64url').toString('utf-8'), links: [] };
    }
    // Fall back to text/html
    const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      const html = Buffer.from(htmlPart.body.data, 'base64url').toString('utf-8');
      return stripHtml(html);
    }
    // Recurse into nested multipart
    for (const part of payload.parts) {
      if (part.parts) { const r = getBody(part); if (r.text) return r; }
    }
  }
  // Single-part HTML
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    const html = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    return stripHtml(html);
  }
  return { text: '', links: [] };
}

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

  const { text, links } = getBody(msg.data.payload);
  if (text) console.log(text);

  if (links.length > 0) {
    console.log('\n--- Links ---');
    for (const link of links) {
      console.log(`[${link.text || 'link'}] ${link.url}`);
    }
  }
})();
