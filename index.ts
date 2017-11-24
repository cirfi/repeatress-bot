import * as bodyParser from 'body-parser';
import * as crypto from 'crypto';
import { addHours, format, getMonth, getYear, startOfDay } from 'date-fns';
import * as express from 'express';
import * as fs from 'fs';
// import * as moment from 'moment-timezone';
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
const chats = new Map();
pool.query('SELECT * FROM config').then(res => {
  if (res.rows.length > 0) {
    for (const row of res.rows) {
      chats.set(row.chat_id, {
        threshold: row.threshold,
        timeout: row.timeout,
        timezone: row.timezone
      });
    }
  }
});

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

let username = '';
bot.getMe().then((user: TelegramBot.User) => {
  username = user.username;
});

bot.onText(/\/status/, (msg: Message) => {
  try {
    checkCommand(msg.text.trim());
    const chatId = msg.chat.id.toString();
    const count = Array.from(chats.keys())
      .filter(c => c.startsWith('-'))
      .reduce((acc, curr) => acc + 1, 0);

    redisClient.keys(`${chatId}*`, (err, keys) => {
      if (!err) {
        bot.sendMessage(
          chatId,
          `当前会话缓存数：${keys.length}；
当前会话消息阈值：${chats.get(chatId).threshold} 条；
当前会话消息有效间隔：${chats.get(chatId).timeout} 秒；
当前会话时区：${getTimezoneAndRun(chatId, parseTimezone)}。

复读姬本次已启动${getDuration()}。
复读姬在本次启动中已复读 ${messageCount} 条消息。

已有 ${count} 个群使用了复读姬。`
        );
      }
    });
  } catch (e) {
    // do nothing
  }
});

bot.onText(/\/timeout/, (msg: Message) => {
  try {
    const [timeoutString] = checkCommand(msg.text.trim());
    const chatId = msg.chat.id.toString();
    const timeout = parseInt(timeoutString, 10);
    if (timeout >= 10 && timeout <= 32767) {
      checkConfig(chatId, { timeout });
      bot.sendMessage(
        chatId,
        `设置成功。
当前会话消息阈值：${chats.get(chatId).threshold} 条；
当前会话消息有效间隔：${chats.get(chatId).timeout} 秒；
当前会话时区：${getTimezoneAndRun(chatId, parseTimezone)}。`,
        {
          reply_to_message_id: msg.message_id
        }
      );
    } else {
      bot.sendMessage(chatId, '无效的时间，请输入 10 和 32767 之间的数字。', {
        reply_to_message_id: msg.message_id
      });
    }
  } catch (e) {
    //
  }
});

bot.onText(/\/threshold/, (msg: Message) => {
  try {
    const [thresholdString] = checkCommand(msg.text.trim());
    const chatId = msg.chat.id.toString();
    const threshold = parseInt(thresholdString, 10);
    if (threshold >= 3 && threshold <= 32767) {
      checkConfig(chatId, { threshold });
      bot.sendMessage(
        chatId,
        `设置成功。
当前会话消息阈值：${chats.get(chatId).threshold} 条；
当前会话消息有效间隔：${chats.get(chatId).timeout} 秒；
当前会话时区：${getTimezoneAndRun(chatId, parseTimezone)}。`,
        {
          reply_to_message_id: msg.message_id
        }
      );
    } else {
      bot.sendMessage(chatId, '无效的阈值，请输入 3 和 32767 之间的数字。', {
        reply_to_message_id: msg.message_id
      });
    }
  } catch (e) {
    //
  }
});

bot.onText(/\/timezone/, (msg: Message) => {
  try {
    const [timezoneString] = checkCommand(msg.text.trim());
    const chatId = msg.chat.id.toString();
    const timezone = parseInt(timezoneString, 10);
    if (timezone >= -12 && timezone <= 12) {
      checkConfig(chatId, { timezone });
      bot.sendMessage(
        chatId,
        `设置成功。
当前会话消息阈值：${chats.get(chatId).threshold} 条；
当前会话消息有效间隔：${chats.get(chatId).timeout} 秒；
当前会话时区：${getTimezoneAndRun(chatId, parseTimezone)}。`,
        {
          reply_to_message_id: msg.message_id
        }
      );
    } else {
      bot.sendMessage(chatId, '无效的时区，请输入 -12 和 12 之间的数字。', {
        reply_to_message_id: msg.message_id
      });
    }
  } catch (e) {
    //
  }
});

bot.onText(/\/today/, (msg: Message) => {
  try {
    checkCommand(msg.text.trim());

    const chatId = msg.chat.id.toString();
    const [start, end] = getTimezoneAndRun(chatId, getDayStartAndEnd);

    sendLogDurationInterval(chatId, start, end);
  } catch (e) {
    //
  }
});

bot.onText(/\/recent/, (msg: Message) => {
  try {
    checkCommand(msg.text.trim());

    const chatId = msg.chat.id.toString();
    const end = new Date();
    const start = addHours(end, -24);

    sendLogDurationInterval(chatId, start, end);
  } catch (e) {
    //
  }
});

bot.onText(/\/day/, (msg: Message) => {
  try {
    const [day] = checkCommand(msg.text.trim());

    const chatId = msg.chat.id.toString();

    const [start, end] = getTimezoneAndRun(chatId, getDayStartAndEnd, day);

    sendLogDurationInterval(chatId, start, end);
  } catch (e) {
    //
  }
});

bot.onText(/\/interval/, (msg: Message) => {
  try {
    const [day1, day2] = checkCommand(msg.text.trim());

    const chatId = msg.chat.id.toString();

    const [start1, end1] = getTimezoneAndRun(chatId, getDayStartAndEnd, day1);
    const [start2, end2] = getTimezoneAndRun(chatId, getDayStartAndEnd, day2);

    if (start1 > start2) {
      sendLogDurationInterval(chatId, start2, end1);
    } else {
      sendLogDurationInterval(chatId, start1, end2);
    }
  } catch (e) {
    //
  }
});

bot.onText(/\/anchor/, (msg: Message) => {
  handleMessageRecord(msg, (chatId, msgId, replyToMsgId) => {
    bot
      .sendMessage(chatId, '似乎找到了。', {
        reply_to_message_id: msgId
      })
      .then((m: Message) => {
        //
      })
      .catch(reason => {
        bot.sendMessage(
          chatId,
          '找不到啦，是谁残忍地把复读姬的消息吃掉了吗？',
          {
            reply_to_message_id: replyToMsgId
          }
        );
      });
  });
});

bot.onText(/\/forward/, (msg: Message) => {
  handleMessageRecord(msg, (chatIdR, msgIdR, replyToMsgId) => {
    bot
      .forwardMessage(chatIdR, chatIdR, msgIdR)
      .then((m: Message) => {
        //
      })
      .catch(reason => {
        bot.sendMessage(
          chatIdR,
          '找不到啦，是谁残忍地把复读姬的消息吃掉了吗？',
          {
            reply_to_message_id: replyToMsgId
          }
        );
      });
  });
});

bot.on('message', (msg: Message) => {
  const chatId = msg.chat.id.toString();
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
    if (result === chats.get(chatId).threshold) {
      messageCount++;
      bot.forwardMessage(chatId, chatId, msgId).then((res: Message) => {
        save(chatId, msgId, res.message_id, text);
      });
    }
    redisClient.expire(key, chats.get(chatId).timeout);
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

const defaultSetting = {
  threshold: 3,
  timeout: 30,
  timezone: 0
};

function checkConfig(chatId, toSet = null) {
  if (!chats.has(chatId)) {
    chats.set(chatId, Object.assign({}, defaultSetting, toSet));
    const setting = chats.get(chatId);
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
    chats.set(chatId, Object.assign({}, chats.get(chatId), toSet));
    const setting = chats.get(chatId);
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

function checkCommand(msg: string) {
  const items = msg.split(' ').filter(i => i);
  const command = items[0];
  const splitedComand = command.split('@');
  const uname = splitedComand[1];
  if (uname && uname !== username) {
    throw new Error(uname);
  }
  return items.slice(1);
}

const globalTimezone = Math.round(new Date().getTimezoneOffset() / -60);

function getTimezoneAndRun(chatId, func, arg1 = null, arg2 = null) {
  const timezone = chats.get(chatId).timezone;
  if (!arg1) {
    return func(timezone);
  } else if (!arg2) {
    return func(timezone, arg1);
  } else {
    return func(timezone, arg1, arg2);
  }
}

function getDayStartAndEnd(timezone, timeString = null) {
  const offset = timezone - globalTimezone;

  const now = new Date();
  const localTime = addHours(now, offset);

  let time;
  if (timeString) {
    const dashs = timeString.split('-');
    const length = dashs.length;

    const day = dashs[length - 1];
    const month = dashs[length - 2] || getMonth(localTime);
    const year = dashs[length - 3] || getYear(localTime);
    time = new Date(`${year}-${month}-${day}`);
  } else {
    time = startOfDay(localTime);
  }

  const start = addHours(time, -offset);
  const end = addHours(time, 24 - offset);

  return [start, end];
}

function formatDate(timezone, time: Date) {
  return format(
    addHours(time, timezone - globalTimezone),
    'YYYY-MM-DD HH:mm:ss'
  );
}

function parseTimezone(zone) {
  if (zone >= 0) {
    return `GMT+${zone}`;
  } else {
    return `GMT${zone}`;
  }
}

function sendLogDurationInterval(chatId, start, end, anchor = null) {
  pool
    .query(
      'SELECT * FROM message WHERE chat_id = $1 AND create_time >= $2 AND create_time < $3',
      [chatId, start, end]
    )
    .then(res => {
      if (res.rows.length === 0) {
        bot.sendMessage(chatId, '本会话这段时间没有复读过哟，还请加油水群。');
      } else {
        const texts = [];
        const timezone = chats.get(chatId).timezone;
        for (const [index, row] of res.rows.entries()) {
          texts.push(
            `<i>[${index}] ${formatDate(
              timezone,
              row.create_time
            )} ${parseTimezone(timezone)}</i>\n${row.content}`
          );
        }
        bot
          .sendMessage(chatId, texts.join('\n\n'), { parse_mode: 'HTML' })
          .then((msg: Message) => {
            const msgId = msg.message_id;
            const msgIds = res.rows.map(r => r.msg_id);
            saveRecord(chatId, msgId, msgIds);
          });
      }
    })
    .catch(err => console.log(err.stack));
}

function saveRecord(chatId, msgId, msgIds) {
  pool
    .query(
      'INSERT INTO record (chat_id, msg_id, msg_ids) VALUES ($1, $2, $3)',
      [chatId, msgId, JSON.stringify(msgIds)]
    )
    .then(res => {
      // do nothing
    })
    .catch(err => console.log(err));
}

function getRecordAndRun(
  chatId,
  msgId,
  fromMsgId,
  index,
  func: (chatId: number, msgId: number, replyToMsgId: number) => void,
  replyToMsgId,
  forwardToChatId = null
) {
  pool
    .query('SELECT * FROM record WHERE chat_id = $1 AND msg_id = $2', [
      chatId,
      msgId
    ])
    .then(res => {
      if (res.rows.length > 0) {
        const msgIds = res.rows[0].msg_ids;
        func(chatId, msgIds[index], replyToMsgId);
      } else {
        bot.sendMessage(chatId, '这条消息的记录没找到哟～', {
          reply_to_message_id: fromMsgId
        });
      }
    })
    .catch(err => console.log(err));
}

function handleMessageRecord(
  msg: Message,
  func: (chatId: number, msgId: number, replyToMsgId: number) => void
) {
  let index;
  [index] = checkCommand(msg.text.trim());
  const chatId = msg.chat.id;
  const replyToMessage = msg.reply_to_message;
  const msgId = replyToMessage.message_id;
  const fromMsgId = msg.message_id;
  if (replyToMessage.from.username !== username) {
    bot.sendMessage(chatId, '你在回复谁呀！', {
      reply_to_message_id: fromMsgId
    });
  } else {
    getRecordAndRun(chatId, msgId, fromMsgId, index, func, fromMsgId);
  }
}
