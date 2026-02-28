const fs = require('fs');
const emailBody = fs.readFileSync(process.argv[2], 'utf-8');

// Look for michaeljburry.substack.com URLs
const urlRegex = /https:\/\/michaeljburry\.substack\.com\/[^\s"<>)]+/g;
const matches = emailBody.match(urlRegex);

if (matches && matches.length > 0) {
  // Filter out unsubscribe/settings links, prefer chat/thread URLs
  const contentUrls = matches.filter(url => 
    !url.includes('unsubscribe') && 
    !url.includes('settings') &&
    !url.includes('email-settings')
  );
  
  if (contentUrls.length > 0) {
    console.log(contentUrls[0]);
  } else {
    console.log(matches[0]);
  }
} else {
  console.error('No Substack URLs found');
  process.exit(1);
}