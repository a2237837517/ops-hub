#!/usr/bin/env node
import crypto from 'node:crypto';
import { serveCommand } from './src/commands/serve.js';
import { clientsCommand, execCommand, doctorCommand } from './src/commands/cli.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--config' || token === '-c') {
      args.config = argv[++i];
    } else if (token === '--shell') {
      args.shell = argv[++i];
    } else if (token === '--cwd') {
      args.cwd = argv[++i];
    } else if (token === '--timeout') {
      args.timeout = argv[++i];
    } else if (token === '--yes' || token === '-y') {
      args.yes = true;
    } else if (token === '--help' || token === '-h') {
      args.help = true;
    } else if (token.startsWith('--')) {
      console.warn(`忽略未知参数: ${token}`);
    } else {
      args._.push(token);
    }
  }
  return args;
}

function usage() {
  console.log(`ops-hub - 反向连接远程运维 Agent + MCP 工具层

用法:
  node index.js serve [--config config.local.json]
  node index.js clients [--config ...]
  node index.js exec <clientId|name> <command...> [--shell cmd|powershell|bash|sh] [--cwd path] [--timeout ms] [--yes]
  node index.js doctor [--config ...]
  node index.js token [agent|mcp|admin]
  node index.js version

示例:
  node index.js serve
  node index.js clients
  node index.js exec win-app01 "Get-Service ops-*" --shell powershell
  node index.js exec win-app01 "tail -n 100 /var/log/app.log" --shell bash
`);
}

const argv = process.argv.slice(2);
const command = argv[0] || 'serve';
const rest = command === 'serve' || !argv[0] ? argv : argv.slice(1);
const args = parseArgs(rest);

try {
  switch (command) {
    case 'serve':
      if (args.help) usage();
      else await serveCommand(args);
      break;
    case 'clients':
      await clientsCommand(args);
      break;
    case 'exec':
      await execCommand(args);
      break;
    case 'doctor':
      await doctorCommand(args);
      break;
    case 'token': {
      const kind = args._[0] || 'agent';
      console.log(`${kind} token: ${crypto.randomBytes(32).toString('base64url')}`);
      break;
    }
    case 'version':
    case '--version':
    case '-v':
      console.log('ops-hub 0.1.0');
      break;
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    default:
      usage();
      process.exitCode = 1;
  }
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  if (process.env.DEBUG) console.error(error.stack);
  process.exitCode = 1;
}
