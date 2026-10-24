import type { Message } from '../types';
import type { ChatStreamText } from './streaming-state';

export interface SharedChatFrame {
  chatId: string;
  hostId: string;
  sequence: number;
  running: boolean;
  epoch?: string;
  fields?: Record<string, unknown>;
  history?: { start: number; messages: Message[]; length: number };
  live?: (ChatStreamText & { phase?: string; currentTool?: string | null }) | null;
  liveAppend?: { textOffset: number; thinkingOffset: number; text: string; thinking: string };
}
