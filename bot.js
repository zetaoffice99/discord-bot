require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
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

// ─── Fetch user tokens from dashboard API ─────────────────────────────────────

async function getUserFromDashboard(discordId) {
  const res = await fetch(`${process.env.DASHBOARD_URL}/api/bot/get-user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      discordId,
      secret: process.env.BOT_API_SECRET,
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    // Pass the friendly message back so bot can show it to user
    throw new Error(data.message || 'Could not fetch user data');
  }

  return data.user;
}

// ─── Notify dashboard when bot joins a server ─────────────────────────────────

async function notifyGuildJoined(discordId, guildId, channelId) {
  try {
    await fetch(`${process.env.DASHBOARD_URL}/api/bot/guild-joined`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        discordId,
        guildId,
        channelId,
        secret: process.env.BOT_API_SECRET,
      }),
    });
  } catch (err) {
    console.error('notifyGuildJoined error:', err.message);
  }
}

// ─── Build per-user Google Calendar client ────────────────────────────────────

function getCalendarForUser(userData) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );

  oauth2Client.setCredentials({
    access_token: userData.googleAccessToken,
    refresh_token: userData.googleRefreshToken,
    expiry_date: userData.googleTokenExpiry
      ? new Date(userData.googleTokenExpiry).getTime()
      : null,
  });

  return google.calendar({ version: 'v3', auth: oauth2Client });
}

// ─── Build per-user Gmail transporter ────────────────────────────────────────

function getTransporterForUser(userData) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost:3000'
  );

  oauth2Client.setCredentials({
    access_token: userData.googleAccessToken,
    refresh_token: userData.googleRefreshToken,
  });

  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      type: 'OAuth2',
      user: userData.googleEmail,
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      refreshToken: userData.googleRefreshToken,
      accessToken: userData.googleAccessToken,
    },
  });
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
      mode: null,
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

// ─── OpenRouter AI ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a smart, friendly, and helpful Discord assistant. You can answer ANY question on any topic — general knowledge, coding, writing, math, science, advice, creative tasks, and more. You also have two special built-in tools: sending emails and creating Google Calendar events.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🌐 GENERAL ASSISTANT MODE (default)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
For any question or task that is NOT about sending an email or creating a calendar event, just answer helpfully and conversationally. Use markdown formatting where it helps (code blocks, bullet points, bold text). Keep answers concise unless detail is needed.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📧 EMAIL TOOL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Trigger ONLY when user explicitly wants to SEND an email.
Collect: recipient email, subject, body.
When you have all 3, output EXACTLY:
READY_TO_CONFIRM_EMAIL
RECIPIENT: email@example.com
SUBJECT: subject here
BODY: email body here

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📅 CALENDAR TOOL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Trigger ONLY when user wants to CREATE a calendar event, meeting, or reminder.
Today is ${new Date().toISOString().split('T')[0]}. Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}.
Parse natural language dates into ISO 8601.
When you have title + start time, output EXACTLY:
READY_TO_CONFIRM_CALENDAR
TITLE: event title here
START: 2025-06-15T17:00:00
END: 2025-06-15T18:00:00
DESCRIPTION: optional description

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚙️ SIGNALS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
After user confirms → output: ACTION_CONFIRMED
Invalid email → output: INVALID_EMAIL then explain.

Current session: {DATA}`;

async function callOpenRouter(userId, userMessage) {
  const session = getSession(userId);
  const dataStr = JSON.stringify({
    email: session.emailData,
    calendar: session.calendarData,
    mode: session.mode,
  });
  const systemWithData = SYSTEM_PROMPT.replace('{DATA}', dataStr);

  const messages = [
    { role: 'system', content: systemWithData },
    ...session.history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const model = process.env.OPENROUTER_MODEL || 'openrouter/auto';

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.DASHBOARD_URL || 'https://discord-bot',
      'X-Title': 'Discord AI Bot',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 1000,
      route: 'fallback',
      provider: { allow_fallbacks: true },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content;
  if (!reply) throw new Error('Empty response from OpenRouter');

  session.history.push({ role: 'user', content: userMessage });
  session.history.push({ role: 'assistant', content: reply });
  if (session.history.length > 40) session.history = session.history.slice(-40);

  return reply;
}

// ─── Email + Calendar Actions ─────────────────────────────────────────────────

async function sendEmail(userId, userData) {
  const session = getSession(userId);
  const { recipient, subject, body } = session.emailData;

  // Create OAuth client
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    refresh_token: userData.googleRefreshToken,
  });

  const gmail = google.gmail({
    version: "v1",
    auth: oauth2Client,
  });

  const boundary = "boundary_" + Date.now().toString(36);
  let message = "";

  message += `From: ${userData.googleEmail}\r\n`;
  message += `To: ${recipient}\r\n`;
  message += `Subject: ${subject || "Message via Discord Bot"}\r\n`;
  message += `MIME-Version: 1.0\r\n`;

  if (session.attachments && session.attachments.length > 0) {
    // ── Email with attachments (multipart) ──────────────────────────────────
    message += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;

    // Body part
    message += `--${boundary}\r\n`;
    message += `Content-Type: text/html; charset=UTF-8\r\n\r\n`;
    message += `${(body || "").replace(/\n/g, "<br>")}\r\n\r\n`;

    // Attachment parts
    for (const file of session.attachments) {
      const base64Content = file.content.toString("base64");
      message += `--${boundary}\r\n`;
      message += `Content-Type: ${file.contentType || "application/octet-stream"}; name="${file.filename}"\r\n`;
      message += `Content-Disposition: attachment; filename="${file.filename}"\r\n`;
      message += `Content-Transfer-Encoding: base64\r\n\r\n`;
      // Base64 split into 76-char lines (MIME standard)
      message += base64Content.replace(/(.{76})/g, "$1\r\n") + "\r\n\r\n";
    }

    message += `--${boundary}--`;
  } else {
    // ── Plain email (no attachments) ────────────────────────────────────────
    message += `Content-Type: text/html; charset=UTF-8\r\n\r\n`;
    message += `${(body || "").replace(/\n/g, "<br>")}`;
  }

  // Base64URL encode the whole message
  const encodedMessage = Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const result = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: encodedMessage,
    },
  });

  return result.data.id;
}

async function createCalendarEvent(userId, userData) {
  const session = getSession(userId);
  const { title, startDateTime, endDateTime, description } = session.calendarData;

  const calendarClient = getCalendarForUser(userData);

  const event = {
    summary: title,
    description: description || '',
    start: { dateTime: startDateTime, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    end: { dateTime: endDateTime, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  };

  const response = await calendarClient.events.insert({
    calendarId: userData.calendarId || 'primary',
    resource: event,
  });

  return response.data;
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
    const s = new Date(session.calendarData.startDateTime);
    s.setHours(s.getHours() + 1);
    session.calendarData.endDateTime = s.toISOString().slice(0, 19);
  }

  const desc = text.match(/DESCRIPTION:\s*([^\n]+)/i);
  if (desc) session.calendarData.description = desc[1].trim();
}

// ─── Embeds ───────────────────────────────────────────────────────────────────

function emailConfirmEmbed(emailData, attachmentCount) {
  return new EmbedBuilder()
    .setColor(0x5865F2).setTitle('📧 Ready to Send Email')
    .addFields(
      { name: '📤 To', value: emailData.recipient || 'Unknown' },
      { name: '📌 Subject', value: emailData.subject || 'No Subject' },
      { name: '💬 Message', value: (emailData.body || '').slice(0, 500) || 'No body' },
      { name: '📎 Attachments', value: attachmentCount > 0 ? `${attachmentCount} file(s)` : 'None', inline: true }
    )
    .setFooter({ text: 'Reply: yes / confirm  •  cancel to abort' })
    .setTimestamp();
}

function calendarConfirmEmbed(calendarData) {
  return new EmbedBuilder()
    .setColor(0x0F9D58).setTitle('📅 Ready to Create Event')
    .addFields(
      { name: '📌 Title', value: calendarData.title || 'Untitled' },
      { name: '🕐 Start', value: calendarData.startDateTime ? new Date(calendarData.startDateTime).toLocaleString() : 'Unknown' },
      { name: '🕑 End', value: calendarData.endDateTime ? new Date(calendarData.endDateTime).toLocaleString() : 'Unknown' },
      { name: '📝 Description', value: calendarData.description || 'None' }
    )
    .setFooter({ text: 'Reply: yes / confirm  •  cancel to abort' })
    .setTimestamp();
}

function emailSuccessEmbed(emailData, messageId) {
  return new EmbedBuilder()
    .setColor(0x57F287).setTitle('✅ Email Sent!')
    .addFields(
      { name: '📤 To', value: emailData.recipient },
      { name: '📌 Subject', value: emailData.subject || 'No Subject' },
      { name: '🆔 Message ID', value: messageId || 'N/A' }
    )
    .setFooter({ text: 'Type anything to continue' }).setTimestamp();
}

function calendarSuccessEmbed(eventData) {
  return new EmbedBuilder()
    .setColor(0x0F9D58).setTitle('✅ Calendar Event Created!')
    .addFields(
      { name: '📌 Event', value: eventData.summary || 'Untitled' },
      { name: '🕐 When', value: eventData.start?.dateTime ? new Date(eventData.start.dateTime).toLocaleString() : 'N/A' },
      { name: '🔗 Link', value: `[Open in Google Calendar](${eventData.htmlLink})` }
    )
    .setFooter({ text: 'Type anything to continue' }).setTimestamp();
}

function errorEmbed(msg) {
  return new EmbedBuilder()
    .setColor(0xED4245).setTitle('❌ Error')
    .setDescription(msg).setTimestamp();
}

function notSetupEmbed(dashboardUrl) {
  return new EmbedBuilder()
    .setColor(0xFBBC04).setTitle('⚙️ Setup Required')
    .setDescription(
      `You need to connect your accounts before I can send emails or create events.\n\n` +
      `👉 **[Click here to set up](${dashboardUrl}/dashboard)** — takes less than 1 minute!`
    )
    .setFooter({ text: 'After setup, come back and try again' })
    .setTimestamp();
}

// ─── Attachment Downloader ────────────────────────────────────────────────────

// ─── Updated Attachment Downloader (with content-type) ────────────────────────

async function downloadAttachment(url, filename, contentType) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download attachment: HTTP ${res.statusCode}`));
        return;
      }
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        filename,
        content: Buffer.concat(chunks),
        contentType: contentType || 'application/octet-stream',
      }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function splitMessage(text, maxLength = 1990) {
  if (text.length <= maxLength) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < maxLength / 2) splitAt = maxLength;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

// ─── Auto-create channel when bot joins a server ──────────────────────────────

client.on('guildCreate', async (guild) => {
  try {
    console.log(`Bot joined server: ${guild.name}`);

    const channel = await guild.channels.create({
      name: 'ai-assistant',
      type: 0,
      topic: '🤖 Send emails, create calendar events, or ask me anything!',
    });

    await channel.send(
      `👋 **Hello! I'm your AI Assistant.**\n\n` +
      `I can help you:\n` +
      `📧 Send emails\n` +
      `📅 Create Google Calendar events\n` +
      `💬 Answer any question\n\n` +
      `⚠️ **First, each person needs to connect their Google account:**\n` +
      `👉 ${process.env.DASHBOARD_URL}/dashboard`
    );

    // Save to dashboard DB
    const owner = await guild.fetchOwner();
    await notifyGuildJoined(owner.user.id, guild.id, channel.id);

  } catch (err) {
    console.error('guildCreate error:', err.message);
  }
});

// ─── Main Message Handler ─────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const isMentioned = message.mentions.has(client.user);
  const isAIChannel = message.channel.name === 'ai-assistant' || message.channel.name === 'email-bot';
  const isDM = message.channel.type === 1;
  if (!isMentioned && !isAIChannel && !isDM) return;

  const userId = message.author.id;
  const session = getSession(userId);

  await message.channel.sendTyping();

  const userText = message.content.replace(`<@${client.user.id}>`, '').trim();

  // ── Cancel ──────────────────────────────────────────────────────────────────
  if (userText.toLowerCase() === 'cancel') {
    resetSession(userId);
    await message.reply('🚫 Cancelled! Ask me anything.');
    return;
  }

  // ── Attachments ─────────────────────────────────────────────────────────────
  if (message.attachments.size > 0) {
    for (const [, attachment] of message.attachments) {
      try {
        if (attachment.size > 8 * 1024 * 1024) {
          await message.reply(`⚠️ **${attachment.name}** is too large (max 8MB).`);
          continue;
        }
      const file = await downloadAttachment(attachment.url, attachment.name, attachment.contentType);  
        session.attachments.push(file);
        await message.react('📎');
      } catch (err) {
        await message.reply(`❌ Could not download **${attachment.name}**: ${err.message}`);
      }
    }
    if (!userText) {
      const fileList = session.attachments.map(f => `• \`${f.filename}\``).join('\n');
      await message.reply(`📎 **${session.attachments.length} file(s) ready:**\n${fileList}\n\nNow tell me where to send them!`);
      return;
    }
  }

  // ── Confirmation ─────────────────────────────────────────────────────────────
  const confirmWords = ['yes', 'send', 'confirm', 'proceed', 'ok', 'okay'];
  if (session.awaitingConfirm && confirmWords.includes(userText.toLowerCase())) {
    await message.channel.sendTyping();

    // Fetch user tokens at the point of action
    let userData;
    try {
      userData = await getUserFromDashboard(userId);
    } catch (err) {
      await message.reply({ embeds: [notSetupEmbed(process.env.DASHBOARD_URL)] });
      return;
    }

    if (session.mode === 'email') {
      try {
        const messageId = await sendEmail(userId, userData);
        const saved = { ...session.emailData };
        session.emailData = { recipient: null, subject: null, body: null };
        session.attachments = [];
        session.awaitingConfirm = false;
        session.mode = null;
        await message.reply({ embeds: [emailSuccessEmbed(saved, messageId)] });
      } catch (err) {
        await message.reply({ embeds: [errorEmbed(`Email failed: ${err.message}`)] });
      }
      return;
    }

    if (session.mode === 'calendar') {
      try {
        const eventData = await createCalendarEvent(userId, userData);
        session.calendarData = { title: null, startDateTime: null, endDateTime: null, description: null };
        session.awaitingConfirm = false;
        session.mode = null;
        await message.reply({ embeds: [calendarSuccessEmbed(eventData)] });
      } catch (err) {
        await message.reply({ embeds: [errorEmbed(`Calendar error: ${err.message}`)] });
      }
      return;
    }
  }

  // ── Call OpenRouter (no token check needed for general chat) ─────────────────
  try {
    const aiReply = await callOpenRouter(userId, userText);

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
      const clean = aiReply
        .replace(/READY_TO_CONFIRM_EMAIL/g, '')
        .replace(/READY_TO_CONFIRM_CALENDAR/g, '')
        .replace(/ACTION_CONFIRMED/g, '')
        .trim();

      const parts = splitMessage(clean);
      for (let i = 0; i < parts.length; i++) {
        if (i === 0) await message.reply(parts[i]);
        else await message.channel.send(parts[i]);
      }
    }

  } catch (err) {
    console.error('Error:', err);
    await message.reply({ embeds: [errorEmbed(err.message)] });
  }
});

// ─── Ready ────────────────────────────────────────────────────────────────────

client.once('clientReady', () => {
  console.log(`✅ Bot ready as ${client.user.tag}`);
  console.log(`🌐 Dashboard: ${process.env.DASHBOARD_URL}`);
  client.user.setActivity('💬 Ask me anything!', { type: 0 });
});

client.login(process.env.DISCORD_TOKEN);
