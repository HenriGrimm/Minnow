import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createChatRepository } from '../../../server/chats/repository.js';

const [dbPath, chatId, commandId, executionId, checkout] = process.argv.slice(2);
const repository = createChatRepository({ db: new Database(dbPath) });
const { captured } = repository.getCommand(commandId);
repository.createExecution({ chatId, commandId, executionId, captured });
const fence = repository.claimExecution({ chatId, executionId, ownerId: 'previous-process', kind: 'server' });
repository.updateExecution(executionId, { status: 'running' }, { fence });
repository.updateCommand(commandId, { state: 'running', executionId });
repository.recordToolIntent({ chatId, executionId, invocationId: 'partial-write', toolCallId: 'save-file',
  toolName: 'save_file', input: { path: 'unfinished.txt', content: 'partial F2' } }, { fence });
writeFileSync(path.join(checkout, 'unfinished.txt'), 'partial F2');
repository.settleToolInvocation('partial-write', { content: 'Saved' }, { fence });
// Crash after the tool receipt, before the model returns or releases the lease.
process.exit(23);
