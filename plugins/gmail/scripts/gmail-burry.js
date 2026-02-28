/**
 * gmail-burry.js — Searches Gmail for Michael Burry Substack content emails,
 * extracts the Substack URLs, and outputs a clean actionable summary.
 *
 * Usage: node scripts/gmail-burry.js [newer_than]
 *   newer_than defaults to "1d" (last 24 hours)
 *
 * Output format:
 *   CONTENT_FOUND: <count>
 *   ---
 *   TYPE: chat | article | note
 *   SUBJECT: <subject line>
 *   DATE: <date>
 *   URL: <substack url to visit>
 *   PREVIEW: <first 200 chars of body text>
 *   BODY: <full email body text>
 *   ---
 */
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

const newerThan = process.argv[2] || '1d';

function extractLinks(html) {
  const links = [];
  html.replace(/<a[^>]+href="([^"]+)"[^>]*>/gi, (_, url) => {
    links.push(url);
    return '';
  });
  return links;
}

function decodeHtmlEntities(text) {
  const named = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
  for (const [ent, ch] of Object.entries(named)) text = text.replaceAll(ent, ch);
  // Decode numeric entities: &#NNN; and &#xHHH;
  text = text.replace(/&#(\d+);/g, (_, n) => {
    const code = parseInt(n, 10);
    // Skip invisible/formatting chars
    if (code < 32 || (code >= 0x200b && code <= 0x200f) || code === 0x00ad ||
        code === 0x034f || code === 0x847 || code === 0x2007 || code === 0x2009 ||
        code === 0x2003 || code === 0x2199 || code === 0xfeff) return '';
    return String.fromCharCode(code);
  });
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return text;
}

function stripHtml(html) {
  return decodeHtmlEntities(
    html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[\u034f\u200b\u00ad\u2009\u2007\u2003\ufeff]/g, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function getHtml(payload) {
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }
  if (payload.parts) {
    const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) return Buffer.from(htmlPart.body.data, 'base64url').toString('utf-8');
    for (const part of payload.parts) {
      if (part.parts) { const r = getHtml(part); if (r) return r; }
    }
  }
  return '';
}

function getPlainText(payload) {
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }
  if (payload.parts) {
    const plain = payload.parts.find(p => p.mimeType === 'text/plain');
    if (plain?.body?.data) return Buffer.from(plain.body.data, 'base64url').toString('utf-8');
    for (const part of payload.parts) {
      if (part.parts) { const r = getPlainText(part); if (r) return r; }
    }
  }
  return '';
}

function classifyEmail(subject, links) {
  if (/verification code|login code/i.test(subject)) return null; // skip OTP emails
  if (/new thread|chat/i.test(subject)) return 'chat';
  if (/new post|new article/i.test(subject)) return 'article';
  if (/new note/i.test(subject)) return 'note';
  // Check links for clues
  if (links.some(l => l.includes('/chat/'))) return 'chat';
  if (links.some(l => l.includes('/p/'))) return 'article';
  return 'unknown';
}

function findBestUrl(links, type) {
  // Filter to substack URLs only
  const substackLinks = links.filter(l =>
    l.includes('substack.com') &&
    !l.includes('unsubscribe') &&
    !l.includes('disable_email') &&
    !l.includes('app-store-redirect') &&
    !l.includes('mailto:')
  );

  // Prefer open.substack.com links (direct access without login redirect)
  const openLink = substackLinks.find(l => l.startsWith('https://open.substack.com/'));
  if (openLink) return openLink.replace(/&amp;/g, '&');

  // Prefer chat post links
  const chatLink = substackLinks.find(l => l.includes('/chat/'));
  if (chatLink) return chatLink.replace(/&amp;/g, '&');

  // Prefer article links (/p/)
  const articleLink = substackLinks.find(l => l.includes('/p/'));
  if (articleLink) return articleLink.replace(/&amp;/g, '&');

  // Fall back to first substack link
  if (substackLinks.length > 0) return substackLinks[0].replace(/&amp;/g, '&');

  return null;
}

(async () => {
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: `from:substack newer_than:${newerThan} michael burry`,
    maxResults: 20,
  });

  const messages = res.data.messages || [];
  if (messages.length === 0) {
    console.log('CONTENT_FOUND: 0');
    console.log('No emails from Michael Burry Substack in the last ' + newerThan);
    return;
  }

  const contentItems = [];

  for (const m of messages) {
    const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
    const headers = msg.data.payload.headers;
    const subject = headers.find(h => h.name === 'Subject')?.value ?? '';
    const date = headers.find(h => h.name === 'Date')?.value ?? '';

    const html = getHtml(msg.data.payload);
    const links = html ? extractLinks(html) : [];
    const type = classifyEmail(subject, links);

    if (!type) continue; // skip verification code emails

    const url = findBestUrl(links, type);
    const plainText = getPlainText(msg.data.payload) || (html ? stripHtml(html) : '');
    const preview = plainText.substring(0, 300).replace(/\n/g, ' ').trim();
    // Extract clean body from HTML (more reliable than text/plain for Substack emails)
    const bodyRaw = html ? stripHtml(html) : plainText;
    const body = bodyRaw
      .replace(/ {2,}/g, ' ')  // collapse runs of spaces
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .substring(0, 5000);

    contentItems.push({ type, subject, date, url, preview, body, messageId: m.id });
  }

  console.log(`CONTENT_FOUND: ${contentItems.length}`);

  if (contentItems.length === 0) {
    console.log('All emails were verification codes — no new content.');
    return;
  }

  for (const item of contentItems) {
    console.log('---');
    console.log(`TYPE: ${item.type}`);
    console.log(`SUBJECT: ${item.subject}`);
    console.log(`DATE: ${item.date}`);
    console.log(`URL: ${item.url || 'NONE'}`);
    console.log(`MESSAGE_ID: ${item.messageId}`);
    console.log(`PREVIEW: ${item.preview}`);
    console.log(`BODY: ${item.body}`);
  }
})();
