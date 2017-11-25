import * as bodyParser from 'body-parser';
import * as crypto from 'crypto';
import { addHours, format, getMonth, getYear, startOfDay } from 'date-fns';
import * as express from 'express';
import * as fs from 'fs';
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

// 机器人的用户名
let username = '';
bot.getMe().then((user: TelegramBot.User) => {
  username = user.username;
});

// 获取当前会话状态，以及复读姬运行状态
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

// 设置当前会话消息有效间隔
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

// 设置当前会话消息阈值
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

// 设置当前会话时区
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

// 今天复读了哪些消息？
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

// 最近 24 小时复读了哪些消息？
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

// 某天复读了哪些消息？
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

// 某天至某天复读了哪些消息？
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

// 检索消息
bot.onText(/\/search/, (msg: Message) => {
  try {
    const [text] = checkCommand(msg.text.trim());

    const chatId = msg.chat.id.toString();
    if (!text) {
      bot.sendMessage(chatId, '请输入需要查询的内容。', {
        reply_to_message_id: msg.message_id
      });
      return;
    }

    sendLog(
      chatId,
      "SELECT * FROM message WHERE chat_id = $1 AND content LIKE CONCAT('%', $2::text, '%')",
      [chatId, text],
      '复读姬没复读过这样的话。'
    );
  } catch (e) {
    //
  }
});

// 定位到消息
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

// 再转发一遍
bot.onText(/\/forward/, (msg: Message) => {
  handleMessageRecord(msg, (chatId, msgId, replyToMsgId) => {
    bot
      .forwardMessage(chatId, chatId, msgId)
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

// 因为这个 API 的 Video 有属性缺漏，所以只能自己定义一个了
interface Video extends TelegramBot.Video {
  file_id?: string;
  file_size?: number;
}

bot.on('message', (msg: Message) => {
  const chatId = msg.chat.id.toString();
  const msgId = msg.message_id;
  let text = msg.text;

  checkConfig(chatId);

  if (text && text.startsWith('/')) {
    return;
  }

  if (!text && msg.sticker) {
    text = `(sticker${msg.sticker.emoji}) ${msg.sticker.file_id} ${
      msg.sticker.set_name
    }`;
  }

  if (!text && msg.photo) {
    text = `(photo) [${msg.photo.map(p => p.file_id).join(',')}] ${
      msg.caption
    }`;
  }

  if (!text && msg.voice) {
    text = `(voice) ${msg.voice.file_id} ${msg.caption}`;
  }

  if (!text && msg.audio) {
    text = `(audio) ${msg.audio.file_id} ${msg.audio.title || '[空]'} ${
      msg.caption
    }`;
  }

  if (!text && msg.video_note) {
    text = `(video note) ${msg.video_note.file_id} ${msg.caption}`;
  }

  if (!text && msg.video) {
    const video: Video = msg.video;
    text = `(video) ${video.file_id} ${msg.caption}`;
  }

  if (!text && msg.document) {
    text = `(document) ${msg.document.file_id} ${msg.document.file_name ||
      '[空]'} ${msg.caption}`;
  }

  if (!text) {
    return;
  }

  text = text.trim();

  const hash = crypto
    .createHash('md5')
    .update(text)
    .digest('hex');

  const key = `${chatId}_${hash}`;

  trigger(key, chatId, msgId, text);
});

/**
 * 复读触发器
 * @param key 会话ID加上文字内容的哈希
 * @param chatId 会话ID，用于获取配置
 * @param msgId 消息ID，用于复读
 * @param text 消息内容，用于存档
 */
function trigger(
  key: string,
  chatId: string,
  msgId: number | string,
  text: string
): void {
  redisClient.hincrby(key, 'count', 1, (err, result) => {
    if (result === chats.get(chatId).threshold) {
      messageCount++;
      bot.forwardMessage(chatId, chatId, msgId).then((res: Message) => {
        save(chatId, msgId, res.message_id, text);
      });
    } else if (result === 1) {
      redisClient.hset(key, 'text', text);
    }
    redisClient.expire(key, chats.get(chatId).timeout);
  });
}

/**
 * 复读消息存档
 * @param chatId 会话ID
 * @param fwdMsgId 被转发的消息ID
 * @param msgId 复读姬转发后的消息的ID
 * @param 消息内容
 */
function save(
  chatId: string,
  fwdMsgId: number | string,
  msgId: number | string,
  text: string
): void {
  pool.query(
    'INSERT INTO message (chat_id, fwd_msg_id, msg_id, content, create_time) VALUES ($1, $2, $3, $4, $5)',
    [chatId, fwdMsgId, msgId, text, new Date()]
  );
}

/**
 * 获取启动时间
 */
function getDuration(): string {
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

interface Setting {
  threshold?: number;
  timeout?: number;
  timezone?: number;
}

// 默认配置
const defaultSetting: Setting = {
  threshold: 3,
  timeout: 30,
  timezone: 0
};

/**
 * 检查配置
 * @param chatId 会话ID
 * @param toSet 需要设置的内容，留空则只设置默认或不设置
 */
function checkConfig(chatId: string, toSet: Setting = null): void {
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

/**
 * 校验命令是不是发给自己的，如果是则返回参数，否则抛出异常
 * @param msg 消息内容
 */
function checkCommand(msg: string): string[] {
  const items = msg.split(/\s+/);
  const command = items[0];
  const splitedComand = command.split('@');
  const uname = splitedComand[1];
  if (uname && uname !== username) {
    throw new Error(uname);
  }
  return items.slice(1);
}

/**
 * 当前运行环境的时区
 */
const globalTimezone = Math.round(new Date().getTimezoneOffset() / -60);

/**
 * 获取会话的时区，并执行函数
 * @param chatId 会话 ID
 * @param func 执行的函数
 * @param arg2 函数参数 2
 * @param arg3 函数参数 3
 */
function getTimezoneAndRun(
  chatId: string,
  func: (timezone: number, arg2?: any, arg3?: any) => any,
  arg2: any = null,
  arg3: any = null
): any {
  const timezone = chats.get(chatId).timezone;
  if (!arg2) {
    return func(timezone);
  } else if (!arg3) {
    return func(timezone, arg2);
  } else {
    return func(timezone, arg2, arg3);
  }
}

/**
 * 获取一天的开始和结束
 * @param timezone 时区
 * @param timeString 时间，缺省为今天
 */
function getDayStartAndEnd(
  timezone: number,
  timeString: string = null
): Date[] {
  const offset = timezone - globalTimezone;

  const now = new Date();
  const localTime = addHours(now, offset);

  let time;
  if (timeString) {
    const dashs = timeString.split('-');
    const length = dashs.length;

    const day = dashs[length - 1];
    const month = dashs[length - 2] || getMonth(localTime) + 1;
    const year = dashs[length - 3] || getYear(localTime);
    time = new Date(`${year}-${month}-${day}`);
  } else {
    time = startOfDay(localTime);
  }

  const start = addHours(time, -offset);
  const end = addHours(time, 24 - offset);

  return [start, end];
}

/**
 * 按照格式输出时间
 * @param timezone 时区
 * @param time 时间
 */
function formatDate(timezone: number, time: Date): string {
  return format(
    addHours(time, timezone - globalTimezone),
    'YYYY-MM-DD HH:mm:ss'
  );
}

/**
 * 将时区转换成 GMT 字符串
 * @param zone 时区
 */
function parseTimezone(zone: number): string {
  if (zone >= 0) {
    return `GMT+${zone}`;
  } else {
    return `GMT${zone}`;
  }
}

/**
 * 发送一段时间内的消息记录
 * @param chatId 会话ID
 * @param start 开始时间
 * @param end 结束时间
 */
function sendLogDurationInterval(chatId: string, start: Date, end: Date) {
  sendLog(
    chatId,
    'SELECT * FROM message WHERE chat_id = $1 AND create_time >= $2 AND create_time < $3',
    [chatId, start, end],
    '这段时间复读姬还没复读过哟，是不是太松懈了？'
  );
}

/**
 * 发送消息记录
 * @param chatId 会话ID
 * @param sql 查询语句
 * @param params 查询语句的参数
 * @param message 没查询到结果的回应
 */
function sendLog(
  chatId: string,
  sql: string,
  params: any[],
  message: string
): void {
  pool
    .query(sql, params)
    .then(res => {
      const rows = res.rows;
      if (rows.length === 0) {
        bot.sendMessage(chatId, message);
      } else {
        const texts = [];
        const timezone = chats.get(chatId).timezone;
        for (const [index, row] of rows.entries()) {
          if (index > 19) {
            break;
          }
          texts.push(
            `<i>[${index}] ${formatDate(
              timezone,
              row.create_time
            )} ${parseTimezone(timezone)}</i>\n${restrictLength(row.content)}`
          );
        }
        if (rows.length > 20) {
          texts.push('<i>[ More ... ]</i>');
        }
        bot
          .sendMessage(chatId, texts.join('\n\n'), { parse_mode: 'HTML' })
          .then((msg: Message) => {
            const msgId = msg.message_id;
            const msgIds = rows.map(r => r.msg_id);
            saveRecord(chatId, msgId, msgIds);
          });
      }
    })
    .catch(err => console.log(err.stack));
}

/**
 * 限制发送消息的长度
 * @param text 消息
 */
function restrictLength(text: string): string {
  if (text.length < 140) {
    return text;
  } else {
    return text.slice(0, 180) + '<i>[ More ... ]</i>';
  }
}

/**
 * 保存查询记录
 * @param chatId 会话ID
 * @param msgId 消息ID
 * @param msgIds 查询到的消息ID
 */
function saveRecord(
  chatId: string,
  msgId: number | string,
  msgIds: number[] | string[]
) {
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

/**
 * 查询到记录并且运行函数
 * @param chatId 会话ID
 * @param msgId 消息ID
 * @param fromMsgId 查询命令来自的消息ID
 * @param index 消息是之前查询结果的第几个？
 * @param func 函数
 */
function getRecordAndRun(
  chatId,
  msgId,
  fromMsgId,
  index,
  func: (chatId: number, msgId: number, replyToMsgId: number) => void
) {
  pool
    .query('SELECT * FROM record WHERE chat_id = $1 AND msg_id = $2', [
      chatId,
      msgId
    ])
    .then(res => {
      if (res.rows.length > 0) {
        const msgIds = res.rows[0].msg_ids;
        if (index >= msgIds.length) {
          bot.sendMessage(chatId, '诶，复读姬有复读过这么多消息吗？', {
            reply_to_message_id: fromMsgId
          });
        } else {
          func(chatId, msgIds[index], fromMsgId);
        }
      } else {
        bot.sendMessage(chatId, '这条消息的记录没找到哟～', {
          reply_to_message_id: fromMsgId
        });
      }
    })
    .catch(err => console.log(err));
}

/**
 * 消息记录相关方法
 * @param msg 消息
 * @param func 函数
 */
function handleMessageRecord(
  msg: Message,
  func: (chatId: number, msgId: number, replyToMsgId: number) => void
): void {
  let index;
  [index] = checkCommand(msg.text.trim()).map(i => parseInt(i, 10));
  const chatId = msg.chat.id;
  const fromMsgId = msg.message_id;
  const replyToMessage = msg.reply_to_message;
  if (!replyToMessage) {
    bot.sendMessage(chatId, '这条命令，请以回复复读姬搜索结果的方式使用啦。', {
      reply_to_message_id: fromMsgId
    });
    return;
  }
  const msgId = replyToMessage.message_id;
  if (replyToMessage.from.username !== username) {
    bot.sendMessage(chatId, '你在回复谁呀！', {
      reply_to_message_id: fromMsgId
    });
  } else {
    getRecordAndRun(chatId, msgId, fromMsgId, index, func);
  }
}
