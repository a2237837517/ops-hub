export const PROTOCOL_VERSION = 1;

export const MSG = {
  HELLO: 'hello',
  HELLO_ACK: 'hello_ack',
  HELLO_ERROR: 'hello_error',
  HEARTBEAT: 'heartbeat',
  HEARTBEAT_ACK: 'heartbeat_ack',
  RPC: 'rpc',
  RPC_RESULT: 'rpc_result',
  EXEC_START: 'exec.start',
  EXEC_STARTED: 'exec.started',
  EXEC_CHUNK: 'exec.chunk',
  EXEC_CHUNK_ACK: 'exec.chunk.ack',
  EXEC_EXIT: 'exec.exit',
  EXEC_ERROR: 'exec.error',
  EXEC_CANCEL: 'exec.cancel',
  EXEC_RESUME: 'exec.resume',
  EXEC_LOST: 'exec.lost',
  FILE_UPLOAD_START: 'file.upload.start',
  FILE_UPLOAD_READY: 'file.upload.ready',
  FILE_UPLOAD_CHUNK: 'file.upload.chunk',
  FILE_UPLOAD_ACK: 'file.upload.ack',
  FILE_UPLOAD_DONE: 'file.upload.done',
  FILE_UPLOAD_ERROR: 'file.upload.error',
  FILE_DOWNLOAD_START: 'file.download.start',
  FILE_DOWNLOAD_CHUNK: 'file.download.chunk',
  FILE_DOWNLOAD_ACK: 'file.download.ack',
  FILE_DOWNLOAD_DONE: 'file.download.done',
  FILE_DOWNLOAD_ERROR: 'file.download.error',
  FILE_DOWNLOAD_CANCEL: 'file.download.cancel',
};

export const JOB_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  DISCONNECTED: 'disconnected',
  EXITING: 'exiting',
  EXITED: 'exited',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted',
  LOST: 'lost',
};

export const TRANSFER_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor(value) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function isDangerousCommand(command, patterns) {
  const text = String(command || '').toLowerCase();
  return (patterns || []).some((pattern) => text.includes(String(pattern).toLowerCase()));
}
