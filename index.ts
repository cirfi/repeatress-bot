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
  }
});

// 分组配置
// if (!fs.existsSync('chats.json')) {
//   fs.writeFileSync('chats.json', '{}');
// }
// const chats = JSON.parse(fs.readFileSync('chats.json', 'utf-8'));

// 时区配置
const timezoneData = JSON.parse(
  fs.readFileSync(
    'node_modules/moment-timezone/data/packed/latest.json',
    'utf-8'
  )
);
const zones = new Set();
for (const zone of timezoneData.zones) {
  zones.add(zone.split('|')[0]);
}
for (const zone of timezoneData.links) {
  const link = zone.split('|');
  if (zones.has(link[0])) {
    zones.add(link[1]);
  }
}

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
当前会话消息有效间隔：${chats[chatId].timeout} 秒；
当前会话时区：${chats[chatId].timezone}。

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
当前会话消息有效间隔：${chats[chatId].timeout} 秒；
当前会话时区：${chats[chatId].timezone}。`,
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
当前会话消息有效间隔：${chats[chatId].timeout} 秒；
当前会话时区：${chats[chatId].timezone}。`,
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

bot.onText(/\/timezone/, (msg: Message) => {
  const chatId = msg.chat.id;
  const timezone = msg.text.split(' ')[1].trim();
  if (zones.has(timezone)) {
    checkConfig(chatId, { timezone });
    bot.sendMessage(
      chatId,
      `设置成功。
当前会话消息阈值：${chats[chatId].threshold} 条；
当前会话消息有效间隔：${chats[chatId].timeout} 秒；
当前会话时区：${chats[chatId].timezone}。`,
      {
        reply_to_message_id: msg.message_id
      }
    );
  } else {
    bot.sendMessage(
      chatId,
      `无效时区，可用时区请查询：
https://github.com/moment/moment-timezone/blob/develop/data/packed/latest.json`,
      {
        reply_to_message_id: msg.message_id
      }
    );
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
        for (const [index, row] of res.rows.entries()) {
          texts.push(
            `<i>[${index}] ${formatDate(chatId, row.create_time)}</i>\n${
              row.content
            }`
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

  trigger(key, chatId, msgId, text);
});

function trigger(key, chatId, msgId, text) {
  redisClient.incr(key, (err, result) => {
    if (result === chats[chatId].threshold) {
      messageCount++;
      bot.forwardMessage(chatId, chatId, msgId).then((res: Message) => {
        save(chatId, msgId, res.message_id, text);
      });
    }
    redisClient.expire(key, chats[chatId].timeout);
  });
}

function save(chatId, fwdMsgId, msgId, text) {
  pool.query(
    'INSERT INTO message (chat_id, fwd_msg_id, msg_id, content, create_time) VALUES ($1, $2, $3, $4, $5)',
    [chatId, fwdMsgId, msgId, text, new Date()]
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
        timezone: 'UTC'
      },
      toSet
    );
    const setting = chats[chatId];
    // 插入，因为数据库里有唯一索引，所以不用担心插入多次
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
    // 更新
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
