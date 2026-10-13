import 'dotenv/config';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { MemoryStore } from './store/memory.js';
import { PostgresStore } from './store/postgres.js';
import { FileStore } from './store/file.js';

const config = loadConfig();
const store = config.databaseUrl
  ? new PostgresStore({ connectionString: config.databaseUrl })
  : config.dataFile
    ? new FileStore({ filePath: config.dataFile })
    : new MemoryStore();
await store.ping?.();
const app = createApp({ config, store });

const server = app.listen(config.port, () => {
  console.log(`API de entregas rodando em http://localhost:${config.port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(async () => {
      app.locals.webhooks.close();
      await app.locals.store.close?.();
      process.exit(0);
    });
  });
}
