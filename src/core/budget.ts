import type { ChatMessage } from './types';

export interface MobilePromptBudget {
  messages: ChatMessage[];
  maxTokens: number;
  omittedMessages: number;
  conservativeInputTokens: number;
  notice: string | null;
}

/**
 * The worker does not expose its tokenizer. UTF-8 bytes are deliberately used
 * as a conservative token allowance, plus per-message/template headroom.
 * This is a safety budget, not an exact tokenizer count or token display.
 */
function allowance(messages: readonly ChatMessage[]): number {
  const encoder = new TextEncoder();
  return 128 + messages.reduce((total, message) => total + 48 + encoder.encode(message.content).byteLength, 0);
}

export function prepareMobilePrompt(messages: readonly ChatMessage[], requestedMaxTokens = 512, contextWindow = 2048): MobilePromptBudget {
  const maxTokens = Number.isFinite(requestedMaxTokens) ? Math.min(512, Math.max(16, Math.floor(requestedMaxTokens))) : 512;
  const systems = messages.filter(message => message.role === 'system');
  const turns: ChatMessage[][] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') turns.push([message]);
    else if (turns.length) turns[turns.length - 1].push(message);
  }
  if (!turns.length) throw new Error('Write a message before asking LocalLLM for a response.');
  let selected = [...systems, ...turns[turns.length - 1]];
  const inputLimit = contextWindow - maxTokens;
  if (allowance(selected) > inputLimit) {
    throw new Error('This message is too long for the mobile model’s context. Shorten it or split it into smaller questions, then try again.');
  }
  for (let index = turns.length - 2; index >= 0; index--) {
    const candidate = [...systems, ...turns.slice(index).flat()];
    if (allowance(candidate) > inputLimit) break;
    selected = candidate;
  }
  const omittedMessages = messages.length - selected.length;
  return {
    messages: selected,
    maxTokens,
    omittedMessages,
    conservativeInputTokens: allowance(selected),
    notice: omittedMessages ? `${omittedMessages} older message${omittedMessages === 1 ? ' was' : 's were'} left out of this prompt to fit the mobile model. Your complete chat remains saved.` : null,
  };
}
