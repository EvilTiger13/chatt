// E-post: skickar via SMTP om SMTP_HOST är satt, annars skrivs mejlet ut i terminalen (utvecklingsläge).
function createMailer(env = process.env) {
  if (!env.SMTP_HOST) {
    return {
      dev: true,
      async send(to, subject, text) {
        console.log(`\n==== E-post (utvecklingsläge) ====\nTill:  ${to}\nÄmne:  ${subject}\n\n${text}\n==================================\n`);
      },
    };
  }
  const nodemailer = require('nodemailer');
  const port = Number(env.SMTP_PORT || 587);
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return {
    dev: false,
    async send(to, subject, text) {
      await transport.sendMail({ from: env.MAIL_FROM || env.SMTP_USER, to, subject, text });
    },
  };
}

module.exports = { createMailer };
