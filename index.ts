import * as bodyParser from 'body-parser';
import * as crypto from 'crypto';
import * as express from 'express';
import * as fs from 'fs';
import * as moment from 'moment-timezone';
import * as TelegramBot from 'node-telegram-bot-api';
import { Message } from 'node-telegram-bot-api';
import { Pool } from 'pg';
import * as redis from 'redis';

import config from './config';

// 启动时间
const startTime = process.hrtime();
let messageCount = 0;

const token = config.token;

let bot: TelegramBot;

// 连接 Postgres
const pool = new Pool(config.db);
// 加载配置
const chats = {};
pool.query('SELECT * FROM config').then(res => {
  if (res.rows.length > 0) {
    for (const row of res.rows) {
      chats[row.chat_id] = {
        threshold: row.threshold,
        timeout: row.timeout,
        timezone: row.timezone
      };
    }
    console.log(chats);
  }
});

// 分组配置
// if (!fs.existsSync('chats.json')) {
//   fs.writeFileSync('chats.json', '{}');
// }
// const chats = JSON.parse(fs.readFileSync('chats.json', 'utf-8'));

// 连接 Redis
const redisClient = redis.createClient();
redisClient.on('error', err => {
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
  const count = Object.keys(chats)
    .filter(c => c.startsWith('-'))
    .reduce((acc, curr) => acc + 1, 0);

  redisClient.keys(`${chatId}*`, (err, keys) => {
    if (!err) {
      bot.sendMessage(
        chatId,
        `当前会话缓存数：${keys.length}；
当前会话消息阈值：${chats[chatId].threshold} 条；
当前会话消息有效间隔：${chats[chatId].timeout} 秒。

复读姬本次已启动${getDuration()}。
复读姬在本次启动中已复读 ${messageCount} 条消息。

已有 ${count} 个群使用了复读姬。`
      );
    }
  });
});

bot.onText(/\/timeout/, (msg: Message) => {
  const chatId = msg.chat.id;
  const timeoutString = msg.text.split(' ')[1];
  const timeout = parseInt(timeoutString, 10);
  if (timeout >= 10) {
    checkConfig(chatId, { timeout });
    bot.sendMessage(
      chatId,
      `设置成功。
当前会话消息阈值：${chats[chatId].threshold} 条；
当前会话消息有效间隔：${chats[chatId].timeout} 秒。`,
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
    checkConfig(chatId, { threshold });
    bot.sendMessage(
      chatId,
      `设置成功。
当前会话消息阈值：${chats[chatId].threshold} 条；
当前会话消息有效间隔：${chats[chatId].timeout} 秒。`,
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

bot.onText(/\/today/, (msg: Message) => {
  const chatId = msg.chat.id;

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const start = new Date(now.getTime());
  now.setHours(23, 59, 59, 999);
  const end = now;

  pool
    .query(
      'SELECT * FROM message WHERE chat_id = $1 AND create_time >= $2 AND create_time <= $3',
      [chatId, start, end]
    )
    .then(res => {
      if (res.rows.length === 0) {
        bot.sendMessage(chatId, '本会话今天没有复读过哟，还请加油水群。');
      } else {
        const texts = [];
        for (const row of res.rows) {
          texts.push(
            `<i>${formatDate(chatId, row.create_time)}</i>\n${row.content}`
          );
        }
        bot.sendMessage(chatId, texts.join('\n\n'), { parse_mode: 'HTML' });
      }
    })
    .catch(err => console.log(err.stack));
});

bot.on('message', (msg: Message) => {
  const chatId = msg.chat.id;
  const msgId = msg.message_id;
  let text = msg.text;

  checkConfig(chatId);

  if (text && text.startsWith('/')) {
    return;
  }

  if (!text && msg.sticker) {
    text = `(sticker) ${msg.sticker.file_id}`;
  }

  // if (!text && msg.document) {
  //   text = msg.document.file_id;
  // }

  if (!text) {
    return;
  }

  const hash = crypto
    .createHash('md5')
    .update(text)
    .digest('hex');

  const key = `${chatId}_${hash}`;

  // redisClient.get(key, (err, result) => {
  //   if (result !== null) {
  //     const now = parseInt(result, 10);
  //     if (now < chats[chatId].threshold) {
  //       incr(key, chatId, msgId);
  //     }
  //   } else {
  //     setnx(key, chatId, msgId);
  //   }
  // });

  trigger(key, chatId, msgId, text);
});

// function setnx(key, chatId, msgId) {
//   redisClient.setnx(key, '1', (err, result) => {
//     if (result === 0) {
//       trigger(key, chatId, msgId);
//     } else {
//       redisClient.expire(key, chats[chatId].timeout);
//     }
//   });
// }

function trigger(key, chatId, msgId, text) {
  redisClient.incr(key, (err, result) => {
    if (result === chats[chatId].threshold) {
      messageCount++;
      bot.forwardMessage(chatId, chatId, msgId);
      save(chatId, msgId, text);
    }
    redisClient.expire(key, chats[chatId].timeout);
  });
}

function save(chatId, msgId, text) {
  pool.query(
    'INSERT INTO message (chat_id, msg_id, content, create_time) VALUES ($1, $2, $3, $4)',
    [chatId, msgId, text, new Date()]
  );
}

function getDuration() {
  const totalSeconds = process.hrtime(startTime)[0];
  const seconds = totalSeconds % 60;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;

  const totalHours = Math.floor(totalMinutes / 60);
  const hours = Math.floor(totalHours / 24);

  const totalDays = Math.floor(totalHours / 24);
  const days = totalDays;

  let result = '';
  if (seconds > 0) {
    if (minutes > 0) {
      if (hours > 0) {
        if (days > 0) {
          result += ` ${days} 天`;
        }
        result += ` ${hours} 小时`;
      }
      result += ` ${minutes} 分`;
    }
    result += ` ${seconds} 秒`;
  }

  return result;
}

function formatDate(chatId, time: Date) {
  const timezone = chats[chatId].timezone;
  return (
    moment(time)
      .tz(timezone)
      .format('YYYY-MM-DD HH:mm:ss') + ` ${timezone}`
  );
}

function checkConfig(chatId, toSet = null) {
  if (!chats[chatId]) {
    chats[chatId] = Object.assign(
      {},
      {
        threshold: 3,
        timeout: 30,
        timezone: 'Asia/Shanghai'
      },
      toSet
    );
    const setting = chats[chatId];
    pool
      .query(
        'INSERT INTO config (chat_id, threshold, timeout, timezone) VALUES ($1, $2, $3, $4)',
        [chatId, setting.threshold, setting.timeout, setting.timezone]
      )
      .then(res => {
        console.log(`GROUP ${chatId}'s setting has been updated.`);
      })
      .catch(err => console.log(err));
  } else if (toSet) {
    chats[chatId] = Object.assign({}, chats[chatId], toSet);
    const setting = chats[chatId];
    pool
      .query(
        'UPDATE config SET threshold = $2, timeout = $3, timezone = $4 WHERE chat_id = $1',
        [chatId, setting.threshold, setting.timeout, setting.timezone]
      )
      .then(res => {
        console.log(`GROUP ${chatId}'s setting has been updated.`);
      })
      .catch(err => console.log(err));
  }
}
