import { Context } from 'koa';
import * as Router from 'koa-router';
import * as TelegramBot from 'node-telegram-bot-api';

import config from './config';

export default function(router: Router, bot: TelegramBot) {
  router.post(`/bot${config.token}`, (ctx: Context) => {
    bot.processUpdate(ctx.request.body);
    ctx.response.status = 200;
  });

  router.get('/', (req, res) => {
    // res.render('');
  });
}
