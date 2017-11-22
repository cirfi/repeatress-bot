import * as bodyParser from 'body-parser';
import * as crypto from 'crypto';
import * as express from 'express';
import * as fs from 'fs';
import * as TelegramBot from 'node-telegram-bot-api';
import { Message } from 'node-telegram-bot-api';
import * as redis from 'redis';

import config from './config';

const token = config.token;

let bot: TelegramBot;

// 分组配置
if (!fs.existsSync('chats.json')) {
  fs.writeFileSync('chats.json', '{}');
}
const chats = JSON.parse(fs.readFileSync('chats.json', 'utf-8'));

// 连接 Redis
const client = redis.createClient();
client.on('error', err => {
  console.log('Error ' + err);
});

// 是否设置了 release 的环境变量？是则使用 webHook，否则用轮询
const releaseMode = process.env.RELEASE ? 1 : 0;

if (releaseMode === 1) {
  const url = config.webHook.url;
  const port = config.webHook.port;

  const app = express();
  app.use(bodyParser.json());

  bot = new TelegramBot(token);
  bot.setWebHook(`${url}/bot${token}`);

  app.post(`/bot${token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  app.listen(port, () => {
    console.log(`Express server is listening on ${port}`);
  });
} else {
  bot = new TelegramBot(token, { polling: true });
  bot.deleteWebHook();
}

bot.onText(/\/status/, (msg: Message) => {
  const chatId = msg.chat.id;
  client.keys(`${chatId}*`, (err, keys) => {
    if (!err) {
      bot.sendMessage(chatId, `缓存数：${keys.length}。`);
    }
  });
});

bot.onText(/\/timeout/, (msg: Message) => {
  const chatId = msg.chat.id;
  const timeoutString = msg.text.split(' ')[1];
  const timeout = parseInt(timeoutString, 10);
  if (timeout >= 10) {
    if (!chats[chatId]) {
      chats[chatId] = {
        threshold: 3,
        timeout
      };
    } else {
      chats[chatId] = Object.assign({}, chats[chatId], { timeout });
    }
    fs.writeFileSync('chats.json', JSON.stringify(chats));
    bot.sendMessage(
      chatId,
      `设置成功。
当前阈值：${chats[chatId].threshold};
当前有效时间：${chats[chatId].timeout}`,
      {
        reply_to_message_id: msg.message_id
      }
    );
  } else {
    bot.sendMessage(chatId, '请输入大于等于 10 的时间。', {
      reply_to_message_id: msg.message_id
    });
  }
});

bot.onText(/\/threshold/, (msg: Message) => {
  const chatId = msg.chat.id;
  const thresholdString = msg.text.split(' ')[1];
  const threshold = parseInt(thresholdString, 10);
  if (threshold >= 3) {
    if (!chats[chatId]) {
      chats[chatId] = {
        threshold,
        timeout: 30
      };
    } else {
      chats[chatId] = Object.assign({}, chats[chatId], { threshold });
    }
    fs.writeFileSync('chats.json', JSON.stringify(chats));
    bot.sendMessage(
      chatId,
      `设置成功。
当前阈值：${chats[chatId].threshold};
当前有效时间：${chats[chatId].timeout}`,
      {
        reply_to_message_id: msg.message_id
      }
    );
  } else {
    bot.sendMessage(chatId, '请输入大于等于 3 的阈值。', {
      reply_to_message_id: msg.message_id
    });
  }
});

bot.on('message', (msg: Message) => {
  const chatId = msg.chat.id;
  const msgId = msg.message_id;
  let text = msg.text;

  if (!chats[chatId]) {
    chats[chatId] = {
      threshold: 3,
      timeout: 30
    };
    fs.writeFileSync('chats.json', JSON.stringify(chats));
  }

  if (text.startsWith('/')) {
    return;
  }

  if (!text && msg.sticker) {
    text = msg.sticker.file_id;
  }

  // if (!text && msg.document) {
  //   text = msg.document.file_id;
  // }

  const hash = crypto
    .createHash('md5')
    .update(text)
    .digest('hex');

  const key = `${chatId}_${hash}`;

  client.get(key, (err, result) => {
    if (result !== null) {
      const now = parseInt(result, 10);
      if (now < chats[chatId].threshold) {
        incr(key, chatId, msgId);
      }
    } else {
      setnx(key, chatId, msgId);
    }
  });
});

function setnx(key, chatId, msgId) {
  client.setnx(key, '1', (err, result) => {
    if (result === 0) {
      incr(key, chatId, msgId);
    } else {
      client.expire(key, chats[chatId].timeout);
    }
  });
}

function incr(key, chatId, msgId) {
  client.incr(key, (err, result) => {
    if (result === chats[chatId].threshold) {
      bot.forwardMessage(chatId, chatId, msgId);
    }
    client.expire(key, chats[chatId].timeout);
  });
}
