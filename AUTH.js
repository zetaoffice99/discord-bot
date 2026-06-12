// Run this ONCE to authorise Google Calendar:  node auth.js
// It generates token.json which the main bot uses.

require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');
const readline = require('readline');

const creds = JSON.parse(fs.readFileSync('credentials.json'));
const { client_secret, client_id, redirect_uris } = creds.installed;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/calendar'],
});

console.log('\n📅 Google Calendar Authorisation\n');
console.log('1. Open this URL in your browser:\n');
console.log(authUrl);
console.log('\n2. Sign in and allow access.\n3. Paste the code you receive below.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Paste code here: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oAuth2Client.getToken(code.trim());
    fs.writeFileSync('token.json', JSON.stringify(tokens, null, 2));
    console.log('\n✅ token.json saved! You can now start the bot.\n');
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
});