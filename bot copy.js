require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const nodemailer = require('nodemailer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const fs = require('fs');
const https = require('https');

// ─── Init ─────────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ]
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD }
});

// ─── Google Calendar Auth ─────────────────────────────────────────────────────

function getCalendarClient() {
  const creds = JSON.parse(fs.readFileSync('credentials.json'));
  const { client_secret, client_id, redirect_uris } = creds.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (!fs.existsSync('token.json')) {
    throw new Error('token.json not found. Run `node auth.js` first to authorise Google Calendar.');
  }

  oAuth2Client.setCredentials(JSON.parse(fs.readFileSync('token.json')));
  return google.calendar({ version: 'v3', auth: oAuth2Client });
}

// ─── Session Store ────────────────────────────────────────────────────────────

const sessions = {};

function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = {
      history: [],
      emailData: { recipient: null, subject: null, body: null },
      calendarData: { title: null, startDateTime: null, endDateTime: null, description: null },
      attachments: [],
      awaitingConfirm: false,
      mode: null, // 'email' | 'calendar' | null (general chat)
    };
  }
  return sessions[userId];
}

function resetSession(userId) {
  sessions[userId] = {
    history: [],
    emailData: { recipient: null, subject: null, body: null },
    calendarData: { title: null, startDateTime: null, endDateTime: null, description: null },
    attachments: [],
    awaitingConfirm: false,
    mode: null,
  };
}

// ─── Gemini AI ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a smart, friendly, and helpful Discord assistant. You can answer ANY question on any topic — general knowledge, coding, writing, math, science, advice, creative tasks, and more. You also have two special built-in tools: sending emails and creating Google Calendar events.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🌐 GENERAL ASSISTANT MODE (default)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
For any question or task that is NOT about sending an email or creating a calendar event, just answer helpfully and conversationally. Use markdown formatting where it helps (code blocks, bullet points, bold text). Keep answers concise unless detail is needed. Use emojis naturally to keep things friendly.

Examples of general questions you should answer directly:
- "What is machine learning?"
- "Write me a Python function to sort a list"
- "What's the capital of France?"
- "Give me 5 ideas for a birthday party"
- "Explain quantum computing simply"
- "How do I fix a merge conflict in Git?"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📧 EMAIL TOOL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Trigger ONLY when user explicitly wants to SEND an email to someone.
Collect: recipient email, subject, body.
When you have all 3, output EXACTLY:
READY_TO_CONFIRM_EMAIL
RECIPIENT: email@example.com
SUBJECT: subject here
BODY: email body here

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📅 CALENDAR TOOL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Trigger ONLY when user explicitly wants to CREATE a calendar event, meeting, or reminder.
Collect: event title, start date/time, end date/time.
Today is ${new Date().toISOString().split('T')[0]}. Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}.
Parse natural language dates ("tomorrow", "Friday", "next Monday at 3pm") into ISO 8601.
When you have title + start time, output EXACTLY:
READY_TO_CONFIRM_CALENDAR
TITLE: event title here
START: 2025-06-15T17:00:00
END: 2025-06-15T18:00:00
DESCRIPTION: optional description here

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚙️ SYSTEM SIGNALS (internal use)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
After user confirms with yes/send/confirm → output: ACTION_CONFIRMED
Invalid email address → output: INVALID_EMAIL then explain.
Ambiguous date/time → ask for clarification before outputting the block.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IMPORTANT RULES:
- Default to general assistant mode for anything not clearly email/calendar related.
- Never refuse to answer a general question just because you also have email/calendar features.
- Keep Discord responses concise. Use code blocks (\`\`\`) for code. Use bullet points for lists.
- Current session context: {DATA}`;

async function callGemini(userId, userMessage) {
  const session = getSession(userId);
  const dataStr = JSON.stringify({ email: session.emailData, calendar: session.calendarData, mode: session.mode });
  const systemWithData = SYSTEM_PROMPT.replace('{DATA}', dataStr);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  // Build conversation history as context
  const conversationText = session.history.map(m => `${m.role}: ${m.content}`).join('\n');
  const fullPrompt = `${systemWithData}\n\nConversation so far:\n${conversationText}\n\nuser: ${userMessage}\n\nassistant:`;

  const result = await model.generateContent(fullPrompt);
  const reply = result.response.text();

  session.history.push({ role: 'user', content: userMessage });
  session.history.push({ role: 'assistant', content: reply });

  // Keep last 40 messages (20 exchanges) for context
  if (session.history.length > 40) session.history = session.history.slice(-40);

  return reply;
}

// ─── Calendar Event Creator ───────────────────────────────────────────────────

async function createCalendarEvent(userId) {
  const session = getSession(userId);
  const { title, startDateTime, endDateTime, description } = session.calendarData;

  const calendar = getCalendarClient();

  const event = {
    summary: title,
    description: description || '',
    start: { dateTime: startDateTime, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    end:   { dateTime: endDateTime,   timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  };

  const response = await calendar.events.insert({
    calendarId: 'primary',
    resource: event,
  });

  return response.data; // { id, htmlLink, summary, start, end }
}

// ─── Email Sender ─────────────────────────────────────────────────────────────

async function sendEmail(userId) {
  const session = getSession(userId);
  const { recipient, subject, body } = session.emailData;

  const mailOptions = {
    from: `"Discord Bot" <${process.env.EMAIL_USER}>`,
    to: recipient,
    subject: subject || 'Message via Discord Bot',
    html: (body || '').replace(/\n/g, '<br>'),
    attachments: session.attachments,
  };

  const info = await transporter.sendMail(mailOptions);
  return info.messageId;
}

// ─── Parse AI Reply ───────────────────────────────────────────────────────────

function extractEmailData(text, session) {
  const r = text.match(/RECIPIENT:\s*([^\n]+)/i);
  if (r) session.emailData.recipient = r[1].trim();
  const s = text.match(/SUBJECT:\s*([^\n]+)/i);
  if (s) session.emailData.subject = s[1].trim();
  const b = text.match(/BODY:\s*([\s\S]+?)(?:\n[A-Z]+:|$)/i);
  if (b) session.emailData.body = b[1].trim();
}

function extractCalendarData(text, session) {
  const t = text.match(/TITLE:\s*([^\n]+)/i);
  if (t) session.calendarData.title = t[1].trim();

  const start = text.match(/START:\s*([^\n]+)/i);
  if (start) session.calendarData.startDateTime = start[1].trim();

  const end = text.match(/END:\s*([^\n]+)/i);
  if (end) {
    session.calendarData.endDateTime = end[1].trim();
  } else if (session.calendarData.startDateTime) {
    const startDate = new Date(session.calendarData.startDateTime);
    startDate.setHours(startDate.getHours() + 1);
    session.calendarData.endDateTime = startDate.toISOString().slice(0, 19);
  }

  const desc = text.match(/DESCRIPTION:\s*([^\n]+)/i);
  if (desc) session.calendarData.description = desc[1].trim();
}

// ─── Discord Embeds ───────────────────────────────────────────────────────────

function emailConfirmEmbed(emailData, attachmentCount) {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📧 Ready to Send Email')
    .addFields(
      { name: '📤 To',          value: emailData.recipient || 'Unknown' },
      { name: '📌 Subject',     value: emailData.subject   || 'No Subject' },
      { name: '💬 Message',     value: (emailData.body || '').slice(0, 500) || 'No body' },
      { name: '📎 Attachments', value: attachmentCount > 0 ? `${attachmentCount} file(s)` : 'None', inline: true }
    )
    .setFooter({ text: 'Reply: yes / send / confirm  •  OR  cancel to abort' })
    .setTimestamp();
}

function calendarConfirmEmbed(calendarData) {
  const start = calendarData.startDateTime ? new Date(calendarData.startDateTime).toLocaleString() : 'Unknown';
  const end   = calendarData.endDateTime   ? new Date(calendarData.endDateTime).toLocaleString()   : 'Unknown';

  return new EmbedBuilder()
    .setColor(0x0F9D58)
    .setTitle('📅 Ready to Create Calendar Event')
    .addFields(
      { name: '📌 Title',       value: calendarData.title       || 'Untitled' },
      { name: '🕐 Start',       value: start },
      { name: '🕑 End',         value: end },
      { name: '📝 Description', value: calendarData.description || 'None' }
    )
    .setFooter({ text: 'Reply: yes / confirm  •  OR  cancel to abort' })
    .setTimestamp();
}

function emailSuccessEmbed(emailData, messageId) {
  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('✅ Email Sent!')
    .addFields(
      { name: '📤 Sent To', value: emailData.recipient },
      { name: '📌 Subject', value: emailData.subject || 'No Subject' },
      { name: '🆔 Message ID', value: messageId || 'N/A' }
    )
    .setFooter({ text: 'Type anything to continue chatting' })
    .setTimestamp();
}

function calendarSuccessEmbed(eventData) {
  const start = eventData.start?.dateTime
    ? new Date(eventData.start.dateTime).toLocaleString()
    : 'N/A';

  return new EmbedBuilder()
    .setColor(0x0F9D58)
    .setTitle('✅ Calendar Event Created!')
    .addFields(
      { name: '📌 Event',  value: eventData.summary || 'Untitled' },
      { name: '🕐 When',  value: start },
      { name: '🔗 Link',  value: `[Open in Google Calendar](${eventData.htmlLink})` }
    )
    .setFooter({ text: 'Type anything to continue chatting' })
    .setTimestamp();
}

function errorEmbed(message) {
  return new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('❌ Error')
    .setDescription(message)
    .setTimestamp();
}

// ─── Attachment Downloader ────────────────────────────────────────────────────

async function downloadAttachment(url, filename) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    https.get(url, (res) => {
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ filename, content: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
  });
}

// ─── Split long messages for Discord's 2000 char limit ───────────────────────

function splitMessage(text, maxLength = 1990) {
  if (text.length <= maxLength) return [text];

  const parts = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    // Try to split on a newline near the limit
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < maxLength / 2) splitAt = maxLength; // No good newline found
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

// ─── Main Message Handler ─────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const isMentioned    = message.mentions.has(client.user);
  const isEmailChannel = message.channel.name === 'email-bot';
  const isDM           = message.channel.type === 1;
  if (!isMentioned && !isEmailChannel && !isDM) return;

  const userId  = message.author.id;
  const session = getSession(userId);

  await message.channel.sendTyping();

  const userText = message.content.replace(`<@${client.user.id}>`, '').trim();

  // ── Cancel command ──────────────────────────────────────────────────────────
  if (userText.toLowerCase() === 'cancel') {
    // Only reset email/calendar state, keep conversation history
    session.emailData     = { recipient: null, subject: null, body: null };
    session.calendarData  = { title: null, startDateTime: null, endDateTime: null, description: null };
    session.attachments   = [];
    session.awaitingConfirm = false;
    session.mode          = null;
    await message.reply('🚫 Task cancelled! Feel free to ask me anything.');
    return;
  }

  // ── File attachments ────────────────────────────────────────────────────────
  if (message.attachments.size > 0) {
    for (const [, attachment] of message.attachments) {
      try {
        const file = await downloadAttachment(attachment.url, attachment.name);
        session.attachments.push(file);
        await message.react('📎');
      } catch (err) {
        console.error('Attachment error:', err);
      }
    }
    if (!userText) {
      await message.reply(`📎 Got ${session.attachments.length} attachment(s)! Tell me where to send the email.`);
      return;
    }
  }

  // ── Confirmation handler ────────────────────────────────────────────────────
  const confirmWords = ['yes', 'send', 'confirm', 'proceed', 'ok', 'okay'];
  if (session.awaitingConfirm && confirmWords.includes(userText.toLowerCase())) {
    await message.channel.sendTyping();

    if (session.mode === 'email') {
      try {
        const messageId = await sendEmail(userId);
        const savedEmailData = { ...session.emailData };
        // Reset only tool state, keep history for continued conversation
        session.emailData     = { recipient: null, subject: null, body: null };
        session.attachments   = [];
        session.awaitingConfirm = false;
        session.mode          = null;
        await message.reply({ embeds: [emailSuccessEmbed(savedEmailData, messageId)] });
      } catch (err) {
        await message.reply({ embeds: [errorEmbed(`Email failed: ${err.message}`)] });
      }
      return;
    }

    if (session.mode === 'calendar') {
      try {
        const eventData = await createCalendarEvent(userId);
        // Reset only tool state, keep history for continued conversation
        session.calendarData  = { title: null, startDateTime: null, endDateTime: null, description: null };
        session.awaitingConfirm = false;
        session.mode          = null;
        await message.reply({ embeds: [calendarSuccessEmbed(eventData)] });
      } catch (err) {
        await message.reply({ embeds: [errorEmbed(`Calendar error: ${err.message}`)] });
      }
      return;
    }
  }

  // ── Call Gemini ─────────────────────────────────────────────────────────────
  try {
    const aiReply = await callGemini(userId, userText);

    if (aiReply.includes('READY_TO_CONFIRM_EMAIL')) {
      extractEmailData(aiReply, session);
      session.mode = 'email';
      session.awaitingConfirm = true;
      await message.reply({ embeds: [emailConfirmEmbed(session.emailData, session.attachments.length)] });

    } else if (aiReply.includes('READY_TO_CONFIRM_CALENDAR')) {
      extractCalendarData(aiReply, session);
      session.mode = 'calendar';
      session.awaitingConfirm = true;
      await message.reply({ embeds: [calendarConfirmEmbed(session.calendarData)] });

    } else if (aiReply.includes('INVALID_EMAIL')) {
      await message.reply(`⚠️ ${aiReply.replace('INVALID_EMAIL', '').trim()}`);

    } else {
      // General AI response — strip any leftover signal tokens and send
      const clean = aiReply
        .replace(/READY_TO_CONFIRM_EMAIL/g, '')
        .replace(/READY_TO_CONFIRM_CALENDAR/g, '')
        .replace(/ACTION_CONFIRMED/g, '')
        .trim();

      // Handle Discord's 2000-character message limit
      const parts = splitMessage(clean);
      for (let i = 0; i < parts.length; i++) {
        if (i === 0) {
          await message.reply(parts[i]);
        } else {
          await message.channel.send(parts[i]);
        }
      }
    }

  } catch (err) {
    console.error('Gemini error:', err);
    await message.reply({ embeds: [errorEmbed(`AI error: ${err.message}`)] });
  }
});

// ─── Ready ────────────────────────────────────────────────────────────────────

client.once('clientReady', () => {
  console.log(`✅ Bot ready as ${client.user.tag}`);
  console.log(`📧 Email: ${process.env.EMAIL_USER}`);
  client.user.setActivity('💬 Ask me anything!', { type: 0 });
});

client.login(process.env.DISCORD_TOKEN);