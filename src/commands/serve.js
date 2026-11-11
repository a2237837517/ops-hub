import { loadConfig } from '../config/index.js';
import { startHub } from '../hub/server.js';

export async function serveCommand(args) {
  const config = loadConfig(args.config);
  const hub = await startHub(config);
  const shutdown = async (signal) => {
    console.log(`\n收到 ${signal}，正在退出...`);
    await hub.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // 保持进程存活
  await new Promise(() => {});
}
