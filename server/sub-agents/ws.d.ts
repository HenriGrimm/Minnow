import type { Server } from 'node:http';
import type { WebSocketServer } from 'ws';

export function attachAgentsWebSocketServer(httpServer: Server): WebSocketServer;
