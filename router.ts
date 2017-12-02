import * as Koa from 'koa';
import { Context } from 'koa';
import * as Router from 'koa-router';
import * as send from 'koa-send';
import * as TelegramBot from 'node-telegram-bot-api';

import config from './config';

export default function(app: Koa, bot: TelegramBot) {
  const router = new Router();

  router.post(`/bot${config.token}`, (ctx: Context) => {
    bot.processUpdate(ctx.request.body);
    ctx.status = 200;
  });

  router.get('/static/(.*)', async (ctx: Context, next) => {
    await send(ctx, ctx.path, { root: __dirname });
  });

  router.get('/(.*)', (ctx: Context) => {
    // res.render('');
  });

  app.use(router.routes()).use(router.allowedMethods());
}
