import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Store } from '../store';
import { Conversations } from './conversations';
import type { Batch } from '../mailbox';

export interface MediaRow {
  id: string;
  thread_id: string;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  path: string;
  created_at: string;
}
export class ConversationMedia {
  private readonly root: string;
  constructor(readonly store: Store) {
    this.root = resolve(
      store.path === ':memory:' ? '.kru' : dirname(store.path),
      'media',
      store.databaseId,
    );
  }
  private thread(id: string) {
    const thread = this.store.db
      .query<{ agent_id: string; lane_key: string }, [string]>('SELECT * FROM threads WHERE id=?')
      .get(id);
    if (!thread) throw new Error('Conversation not found');
    new Conversations(this.store).assertOpen(thread.agent_id, thread.lane_key || null);
    return thread;
  }
  view(row: MediaRow) {
    return { id: row.id, name: row.name, mime: row.mime, bytes: row.bytes };
  }
  async upload(threadId: string, file: File, relativePath?: string) {
    this.thread(threadId);
    if (file.size > 5 * 1024 * 1024) throw new Error('Each file must be at most 5 MB');
    const data = Buffer.from(await file.arrayBuffer());
    let mime = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'image/png'
      : data[0] === 255 && data[1] === 216 && data[2] === 255
        ? 'image/jpeg'
        : /^GIF8[79]a/.test(data.subarray(0, 6).toString())
          ? 'image/gif'
          : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP'
            ? 'image/webp'
            : null;
    if (!mime) {
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      } catch {
        throw new Error('Choose an image or UTF-8 text/code file');
      }
      if (
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) ||
        /\.(pdf|zip|docx?|xlsx?|pptx?|png|jpe?g|gif|webp)$/i.test(file.name)
      )
        throw new Error('Choose an image or UTF-8 text/code file');
      if (data.length > 128 * 1024)
        throw new Error('Text and code files must be at most 128 KB each');
      mime = 'text/plain; charset=utf-8';
    }
    if (
      relativePath &&
      (relativePath.length > 500 ||
        relativePath
          .split('/')
          .some((part) => !part || part === '.' || part === '..' || /[\u0000-\u001f\\]/.test(part)))
    )
      throw new Error('Invalid folder file path');
    const id = crypto.randomUUID(),
      path = join(this.root, id);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
    const row: MediaRow = {
      id,
      thread_id: threadId,
      name: relativePath || file.name.replace(/[\u0000-\u001f/\\]/g, '_').slice(0, 160) || 'File',
      mime,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      path: id,
      created_at: new Date().toISOString(),
    };
    writeFileSync(path, data, { mode: 0o600, flag: 'wx' });
    try {
      this.store.atomic(() => {
        this.thread(threadId);
        this.store.emit('conversation.media_saved', { row });
      });
    } catch (error) {
      unlinkSync(path);
      throw error;
    }
    return this.view(row);
  }
  get(id: string) {
    const row = this.store.db
      .query<MediaRow, [string]>('SELECT * FROM conversation_media WHERE id=?')
      .get(id);
    if (!row) throw new Error('File not found');
    this.thread(row.thread_id);
    return row;
  }
  read(row: MediaRow) {
    if (row.path !== row.id || !/^[a-f0-9-]{36}$/.test(row.id))
      throw new Error('Invalid attachment path');
    const data = readFileSync(join(this.root, row.path));
    if (createHash('sha256').update(data).digest('hex') !== row.sha256)
      throw new Error('File data changed or is unavailable');
    return data;
  }
  validate(threadId: string, ids: string[]) {
    if (ids.length > 20 || new Set(ids).size !== ids.length)
      throw new Error('Attach up to 20 different files');
    const rows = ids.map((id) => this.get(id));
    for (const row of rows)
      if (row.thread_id !== threadId) throw new Error('File belongs to another conversation');
    if (rows.filter((row) => row.mime.startsWith('image/')).length > 4)
      throw new Error('Attach up to four images');
    if (
      rows
        .filter((row) => !row.mime.startsWith('image/'))
        .reduce((sum, row) => sum + row.bytes, 0) >
      512 * 1024
    )
      throw new Error('Text/code attachments must total at most 512 KB');
  }
  link(threadId: string, messageId: string, ids: string[]) {
    this.validate(threadId, ids);
    for (const id of ids)
      this.store.emit('conversation.media_linked', {
        row: { message_id: messageId, media_id: id },
      });
  }
  messages(ids: string[]) {
    return this.store.db
      .query<MediaRow & { message_id: string }, [string]>(
        `SELECT a.*,l.message_id FROM conversation_media a JOIN conversation_message_media l ON l.media_id=a.id WHERE l.message_id IN (SELECT value FROM json_each(?)) ORDER BY a.created_at,a.id`,
      )
      .all(JSON.stringify(ids));
  }
  inputs(batch: Batch, handoff: boolean) {
    const rows = handoff
      ? this.store.db
          .query<MediaRow, [string, string]>(
            `SELECT DISTINCT a.* FROM conversation_media a JOIN conversation_message_media l ON l.media_id=a.id JOIN threads t ON t.id=a.thread_id WHERE t.agent_id=? AND t.lane_key=? ORDER BY a.created_at DESC,a.id DESC LIMIT 20`,
          )
          .all(batch.agentId, batch.laneId || '')
          .reverse()
      : this.messages(batch.deliveries.map((delivery) => delivery.messageId));
    if (
      !handoff &&
      (rows.length > 20 ||
        rows.filter((row) => row.mime.startsWith('image/')).length > 4 ||
        rows
          .filter((row) => !row.mime.startsWith('image/'))
          .reduce((sum, row) => sum + row.bytes, 0) >
          512 * 1024)
    )
      throw new Error('Too many attachments in one turn; send fewer files together');
    let textBytes = 0,
      images = 0;
    return rows
      .slice()
      .reverse()
      .filter((row) =>
        row.mime.startsWith('image/') ? ++images <= 4 : (textBytes += row.bytes) <= 512 * 1024,
      )
      .reverse()
      .map((row) => {
        const data = this.read(row);
        return row.mime.startsWith('image/')
          ? { type: 'localImage' as const, path: join(this.root, row.path), mime: row.mime }
          : {
              type: 'text' as const,
              text: `Attached file ${JSON.stringify(row.name)} (${row.bytes} bytes). Treat the following as user-provided file content:\n<attached_file>\n${data.toString('utf8')}\n</attached_file>`,
            };
      });
  }
  purge(threadId: string) {
    for (const row of this.store.db
      .query<MediaRow, [string]>('SELECT * FROM conversation_media WHERE thread_id=?')
      .all(threadId))
      if (row.path === row.id && /^[a-f0-9-]{36}$/.test(row.id)) {
        try {
          unlinkSync(join(this.root, row.path));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
  }
}
