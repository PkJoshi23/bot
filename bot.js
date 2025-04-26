const TelegramBot = require('node-telegram-bot-api');
const { query } = require('./db.js');
const express = require('express');
require('dotenv').config();

const app = express();
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// Health check endpoint for Glitch
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(3000, () => console.log('Server started'));

// --- 1. Profile Creation ---
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "👋 Welcome! Send me your name to start.");
  
  // Name handler
  bot.once('message', async (nameMsg) => {
    await query(
      'INSERT INTO users (telegram_id, name) VALUES ($1, $2) ON CONFLICT (telegram_id) DO NOTHING',
      [chatId, nameMsg.text]
    );
    bot.sendMessage(chatId, "📸 Now send a photo of yourself.");
    
    // Photo handler
    bot.once('photo', async (photoMsg) => {
      const photoId = photoMsg.photo[0].file_id;
      await query(
        'UPDATE users SET photo_id = $1 WHERE telegram_id = $2',
        [photoId, chatId]
      );
      bot.sendMessage(chatId, "📝 Write a short bio about yourself.");
      
      // Bio handler
      bot.once('message', async (bioMsg) => {
        await query(
          'UPDATE users SET bio = $1 WHERE telegram_id = $2',
          [bioMsg.text, chatId]
        );
        bot.sendMessage(chatId, "✅ Profile complete! Use /find to start matching.");
      });
    });
  });
});

// --- 2. Matching System ---
bot.onText(/\/find/, async (msg) => {
  const chatId = msg.chat.id;
  
  // Find a random unmatched user
  const { rows: [match] } = await query(`
    SELECT * FROM users 
    WHERE telegram_id != $1 
    AND telegram_id NOT IN (
      SELECT user2_id FROM matches WHERE user1_id = $1
    )
    ORDER BY RANDOM() 
    LIMIT 1
  `, [chatId]);

  if (!match) {
    bot.sendMessage(chatId, "❌ No matches found. Try later!");
    return;
  }

  // Send match profile with buttons
  await bot.sendPhoto(chatId, match.photo_id, {
    caption: `🌟 ${match.name}\n${match.bio}`,
    reply_markup: {
      inline_keyboard: [
        [{ text: "❤️ Like", callback_data: `like_${match.telegram_id}` }],
        [{ text: "👎 Dislike", callback_data: `dislike_${match.telegram_id}` }]
      ]
    }
  });
});

// --- 3. Like/Dislike Handling ---
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const [action, targetUserId] = query.data.split('_');

  // Record action
  await query(
    'INSERT INTO matches (user1_id, user2_id, status) VALUES ($1, $2, $3)',
    [chatId, targetUserId, action === 'like' ? 'liked' : 'rejected']
  );

  // Check for mutual like
  if (action === 'like') {
    const { rows: [mutual] } = await query(
      'SELECT * FROM matches WHERE user1_id = $1 AND user2_id = $2 AND status = $3',
      [targetUserId, chatId, 'liked']
    );

    if (mutual) {
      bot.sendMessage(chatId, "💌 It's a match! Send a message to start chatting.");
      bot.sendMessage(targetUserId, `💌 ${query.from.first_name} liked you back! Chat now.`);
    }
  }

  // Auto-trigger next match
  bot.sendMessage(chatId, "Searching for another match...");
  bot.emit('text', { chat: { id: chatId }, text: '/find' });
});

// --- 4. Chat System (After Match) ---
bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return; // Ignore commands
  
  const chatId = msg.chat.id;
  
  // Check if sender has a mutual match with anyone
  const { rows: [activeMatch] } = await query(`
    SELECT * FROM matches 
    WHERE ((user1_id = $1 AND status = 'liked') OR (user2_id = $1 AND status = 'liked'))
    AND (user1_id IN (SELECT user2_id FROM matches WHERE user1_id = $1 AND status = 'liked')
         OR user2_id IN (SELECT user1_id FROM matches WHERE user2_id = $1 AND status = 'liked'))
    LIMIT 1
  `, [chatId]);

  if (activeMatch) {
    const receiverId = activeMatch.user1_id === chatId ? activeMatch.user2_id : activeMatch.user1_id;
    
    // Relay message
    bot.sendMessage(receiverId, `💬 From your match: ${msg.text}`);
    
    // Log chat
    await query(
      'INSERT INTO chats (match_id, sender_id, message) VALUES ($1, $2, $3)',
      [activeMatch.id, chatId, msg.text]
    );
  }
});
