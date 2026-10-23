import { isNativeDesktop } from './environment';
import { nativeTransport } from './native';
import type { ChatMessage, Conversation } from './types';

const DB_NAME = 'localdesk-ai';
const DB_VERSION = 1;
let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new Error('Local storage is unavailable. Use a normal browser window with storage enabled.'));
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('conversations')) request.result.createObjectStore('conversations', { keyPath: 'id' });
      if (!request.result.objectStoreNames.contains('settings')) request.result.createObjectStore('settings');
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
    request.onerror = () => { database = undefined; reject(request.error ?? new Error('Could not open local storage.')); };
    request.onblocked = () => { database = undefined; reject(new Error('Close other LocalDesk AI tabs, then try again.')); };
  });
  return database;
}

async function transact<T>(storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error('Local storage operation failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Local storage operation was interrupted.'));
  });
}

function isMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return ['user', 'assistant', 'system'].includes(String(m.role)) && typeof m.content === 'string';
}

export function isConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return typeof c.id === 'string' && typeof c.title === 'string' && typeof c.updatedAt === 'number' &&
    Array.isArray(c.messages) && c.messages.every(isMessage);
}

export async function listConversations(): Promise<Conversation[]> {
  const values: unknown = isNativeDesktop()
    ? await nativeTransport.invoke('list_conversations')
    : await transact('conversations', 'readonly', store => store.getAll());
  return Array.isArray(values) ? values.filter(isConversation).sort((a, b) => b.updatedAt - a.updatedAt) : [];
}

export async function saveConversation(conversation: Conversation): Promise<void> {
  if (!isConversation(conversation)) throw new Error('Invalid conversation.');
  if (isNativeDesktop()) await nativeTransport.invoke('save_conversation', { conversation });
  else await transact('conversations', 'readwrite', store => store.put(conversation));
}

export async function deleteConversation(id: string): Promise<void> {
  if (isNativeDesktop()) await nativeTransport.invoke('delete_conversation', { id });
  else await transact('conversations', 'readwrite', store => store.delete(id));
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const value = isNativeDesktop()
    ? await nativeTransport.invoke<T | null>('get_setting', { key })
    : await transact<T | undefined>('settings', 'readonly', store => store.get(key));
  return value == null ? fallback : value;
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  if (isNativeDesktop()) await nativeTransport.invoke('set_setting', { key, value });
  else await transact('settings', 'readwrite', store => store.put(value, key));
}

export function createConversation(title = 'New conversation'): Conversation {
  return { id: crypto.randomUUID(), title, messages: [], updatedAt: Date.now() };
}
