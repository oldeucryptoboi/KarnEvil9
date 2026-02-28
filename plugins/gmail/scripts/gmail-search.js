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

const query = process.argv[2];
const maxResults = parseInt(process.argv[3] || '20', 10);
const verbose = process.argv.includes('--verbose');

if (!query) {
  console.error('Usage: node scripts/gmail-search.js <query> [maxResults] [--verbose]');
  console.error('Examples:');
  console.error("  node scripts/gmail-search.js 'from:substack newer_than:1d michael burry'");
  console.error("  node scripts/gmail-search.js 'from:substack newer_than:5m login code' 5 --verbose");
  process.exit(1);
}

function stripHtml(html) {
  const links = [];
  html.replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, url, text) => {
    const cleanText = text.replace(/<[^>]+>/g, '').trim();
    if (url && !url.startsWith('mailto:')) links.push(`[${cleanText || 'link'}] ${url}`);
    return '';
  });
  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
  return text + (links.length > 0 ? '\nLinks: ' + links.join(' | ') : '');
}

function getBody(payload) {
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }
  if (payload.parts) {
    const plain = payload.parts.find(p => p.mimeType === 'text/plain');
    if (plain?.body?.data) return Buffer.from(plain.body.data, 'base64url').toString('utf-8');
    const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) return stripHtml(Buffer.from(htmlPart.body.data, 'base64url').toString('utf-8'));
    for (const part of payload.parts) {
      if (part.parts) { const r = getBody(part); if (r) return r; }
    }
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return stripHtml(Buffer.from(payload.body.data, 'base64url').toString('utf-8'));
  }
  return '';
}

(async () => {
  const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults });
  const messages = res.data.messages || [];

  if (messages.length === 0) {
    console.log(`No emails found for query: ${query}`);
    return;
  }

  console.log(`Found ${messages.length} email(s) for query: ${query}\n`);

  for (const m of messages) {
    const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
    const headers = msg.data.payload.headers;
    const from = headers.find(h => h.name === 'From')?.value ?? '?';
    const subject = headers.find(h => h.name === 'Subject')?.value ?? '(no subject)';
    const date = headers.find(h => h.name === 'Date')?.value ?? '?';
    const snippet = msg.data.snippet ?? '';

    console.log('---');
    console.log('ID:', m.id);
    console.log('Thread:', m.threadId);
    console.log('From:', from);
    console.log('Subject:', subject);
    console.log('Date:', date);
    console.log('Snippet:', snippet);

    if (verbose) {
      const body = getBody(msg.data.payload);
      if (body) {
        console.log('Body:');
        console.log(body);
      }
    }
  }
})();
