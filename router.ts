import { Express } from 'express';
import * as TelegramBot from 'node-telegram-bot-api';

import config from './config';

export default function(app: Express, bot: TelegramBot) {
  app.post(`/bot${config.token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  app.get('/', (req, res) => {
    res.render('');
  });
}
