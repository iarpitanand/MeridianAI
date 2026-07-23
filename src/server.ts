import { Server, Probot } from "probot";
import { app } from "./probot-app.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  const server = new Server({
    Probot: Probot.defaults({
      appId: config.APP_ID,
      privateKey: config.PRIVATE_KEY,
      secret: config.WEBHOOK_SECRET,
    }),
    port: config.PORT,
    log: undefined,
  });

  await server.load(app);
  await server.start();
  // eslint-disable-next-line no-console
  console.log(`MeridianAI webhook server listening on :${config.PORT}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
