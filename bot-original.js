require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const nodemailer = require('nodemailer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const https = require('https');

// ─── Init ────────────────────────────────────────────────────────────────────

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
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// ─── Session Store (per Discord user) ────────────────────────────────────────

const sessions = {}; // { userId: { history, emailData, attachments } }

function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = {
      history: [],
      emailData: { recipient: null, subject: null, body: null },
      attachments: [],
      awaitingConfirm: false
    };
  }
  return sessions[userId];
}

function resetSession(userId) {
  sessions[userId] = {
    history: [],
    emailData: { recipient: null, subject: null, body: null },
    attachments: [],
    awaitingConfirm: false
  };
}

// ─── Gemini AI ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Discord Email Assistant Bot. Help users send emails via Discord.

Your job:
1. Extract recipient email, subject, and body from the conversation
2. If anything is missing, ask for it politely
3. Validate email format
4. When you have all 3 pieces, output EXACTLY this format (nothing before READY_TO_CONFIRM):

READY_TO_CONFIRM
RECIPIENT: email@example.com
SUBJECT: subject line here
BODY: full email body here

5. After user confirms with yes/send/confirm/proceed → output exactly: EMAIL_SENT
6. Be friendly, use emojis, keep responses short
7. If email is invalid → output INVALID_EMAIL then explain

Current collected data: {DATA}`;

async function callGemini(userId, userMessage) {
  const session = getSession(userId);
  const dataStr = JSON.stringify(session.emailData);
  const systemWithData = SYSTEM_PROMPT.replace('{DATA}', dataStr);

  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const conversationText = session.history
    .map(m => `${m.role}: ${m.content}`)
    .join('\n');

  const fullPrompt = `${systemWithData}\n\nConversation so far:\n${conversationText}\n\nuser: ${userMessage}\n\nassistant:`;

  const result = await model.generateContent(fullPrompt);
  const reply = result.response.text();

  session.history.push({ role: 'user', content: userMessage });
  session.history.push({ role: 'assistant', content: reply });

  if (session.history.length > 30) session.history = session.history.slice(-30);

  return reply;
}

// ─── Email Sender ─────────────────────────────────────────────────────────────

async function sendEmail(userId) {
  const session = getSession(userId);
  const { recipient, subject, body } = session.emailData;

  const mailOptions = {
    from: `"Discord Email Bot" <${process.env.EMAIL_USER}>`,
    to: recipient,
    subject: subject || 'Message via Discord Bot',
    html: (body || '').replace(/\n/g, '<br>'),
    attachments: session.attachments
  };

  const info = await transporter.sendMail(mailOptions);
  return info.messageId;
}

// ─── Download Discord Attachment ──────────────────────────────────────────────

async function downloadAttachment(url, filename) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    https.get(url, (res) => {
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        filename,
        content: Buffer.concat(chunks)
      }));
      res.on('error', reject);
    });
  });
}

// ─── Parse AI Reply for Email Data ───────────────────────────────────────────

function extractEmailData(text, session) {
  const recipientMatch = text.match(/RECIPIENT:\s*([^\n]+)/i);
  if (recipientMatch) session.emailData.recipient = recipientMatch[1].trim();

  const subjectMatch = text.match(/SUBJECT:\s*([^\n]+)/i);
  if (subjectMatch) session.emailData.subject = subjectMatch[1].trim();

  const bodyMatch = text.match(/BODY:\s*([\s\S]+?)(?:\n[A-Z]+:|$)/i);
  if (bodyMatch) session.emailData.body = bodyMatch[1].trim();
}

// ─── Discord Embeds ───────────────────────────────────────────────────────────

function confirmEmbed(emailData, attachmentCount) {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📧 Ready to Send Email')
    .addFields(
      { name: '📤 To', value: emailData.recipient || 'Unknown', inline: false },
      { name: '📌 Subject', value: emailData.subject || 'No Subject', inline: false },
      { name: '💬 Message', value: (emailData.body || '').slice(0, 500) || 'No body', inline: false },
      { name: '📎 Attachments', value: attachmentCount > 0 ? `${attachmentCount} file(s)` : 'None', inline: true }
    )
    .setFooter({ text: 'Reply with: yes / send / confirm  OR  cancel to abort' })
    .setTimestamp();
}

function successEmbed(emailData, messageId) {
  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('✅ Email Sent Successfully!')
    .addFields(
      { name: '📤 Sent To', value: emailData.recipient, inline: false },
      { name: '📌 Subject', value: emailData.subject || 'No Subject', inline: false },
      { name: '🆔 Message ID', value: messageId || 'N/A', inline: false }
    )
    .setFooter({ text: 'Type anything to send another email' })
    .setTimestamp();
}

function errorEmbed(message) {
  return new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('❌ Error')
    .setDescription(message)
    .setTimestamp();
}

// ─── Main Message Handler ─────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  // Ignore bots
  if (message.author.bot) return;

  // Only respond to DMs or messages mentioning the bot or in #email channel
  const isMentioned = message.mentions.has(client.user);
  const isEmailChannel = message.channel.name === 'email-bot';
  const isDM = message.channel.type === 1;

  if (!isMentioned && !isEmailChannel && !isDM) return;

  const userId = message.author.id;
  const session = getSession(userId);

  // Show typing indicator
  await message.channel.sendTyping();

  // Handle cancel
  const userText = message.content
    .replace(`<@${client.user.id}>`, '')
    .trim();

  if (userText.toLowerCase() === 'cancel') {
    resetSession(userId);
    await message.reply('🚫 Email cancelled. Type anything to start over!');
    return;
  }

  // Handle file attachments from Discord
  if (message.attachments.size > 0) {
    for (const [, attachment] of message.attachments) {
      try {
        const file = await downloadAttachment(attachment.url, attachment.name);
        session.attachments.push(file);
        await message.react('📎');
      } catch (err) {
        console.error('Attachment download error:', err);
      }
    }

    if (!userText) {
      const count = session.attachments.length;
      await message.reply(`📎 Got it! ${count} attachment(s) saved. Now tell me where to send the email and what to write!`);
      return;
    }
  }

  // Handle confirmation
  const confirmWords = ['yes', 'send', 'confirm', 'proceed', 'ok', 'okay'];
  if (session.awaitingConfirm && confirmWords.includes(userText.toLowerCase())) {
    try {
      await message.channel.sendTyping();
      const messageId = await sendEmail(userId);
      const embed = successEmbed(session.emailData, messageId);
      await message.reply({ embeds: [embed] });
      resetSession(userId);
    } catch (err) {
      const embed = errorEmbed(`Failed to send email: ${err.message}\n\nCheck your Gmail App Password in .env`);
      await message.reply({ embeds: [embed] });
    }
    return;
  }

  // Call Gemini AI
  try {
    const aiReply = await callGemini(userId, userText);

    if (aiReply.includes('READY_TO_CONFIRM')) {
      extractEmailData(aiReply, session);
      session.awaitingConfirm = true;

      const embed = confirmEmbed(session.emailData, session.attachments.length);
      await message.reply({ embeds: [embed] });

    } else if (aiReply.includes('EMAIL_SENT')) {
      // AI said send — actually send it
      try {
        const messageId = await sendEmail(userId);
        const embed = successEmbed(session.emailData, messageId);
        await message.reply({ embeds: [embed] });
        resetSession(userId);
      } catch (err) {
        const embed = errorEmbed(`Failed to send: ${err.message}`);
        await message.reply({ embeds: [embed] });
      }

    } else if (aiReply.includes('INVALID_EMAIL')) {
      const clean = aiReply.replace('INVALID_EMAIL', '').trim();
      await message.reply(`⚠️ ${clean}`);

    } else {
      // Regular conversational reply
      const clean = aiReply
        .replace('READY_TO_CONFIRM', '')
        .replace('EMAIL_SENT', '')
        .trim();
      await message.reply(clean);
    }

  } catch (err) {
    console.error('Gemini error:', err);
    const embed = errorEmbed('AI error: ' + err.message + '\n\nCheck your GEMINI_API_KEY in .env');
    await message.reply({ embeds: [embed] });
  }
});

// ─── Bot Ready ────────────────────────────────────────────────────────────────

client.once('clientReady', () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  console.log(`📧 Email service: ${process.env.EMAIL_USER}`);
  client.user.setActivity('📧 Sending Emails', { type: 0 });
});

client.login(process.env.DISCORD_TOKEN);