const { createHash, randomUUID } = require('node:crypto');
const {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} = require('node:fs');
const { join } = require('node:path');

/** Only the main process reads decrypted tokens. Files contain OS-encrypted bytes. */
class GitHubCredentials {
  constructor(storage, directory, workspace) {
    this.storage = storage;
    this.directory = directory;
    this.path = join(directory, createHash('sha256').update(workspace).digest('hex') + '.github');
  }
  available() {
    return (
      this.storage.isEncryptionAvailable() &&
      this.storage.getSelectedStorageBackend?.() !== 'basic_text'
    );
  }
  status() {
    try {
      return { available: this.available(), saved: !!this.read(), error: null };
    } catch {
      return {
        available: this.available(),
        saved: false,
        error: 'Save a new GitHub token to reconnect.',
      };
    }
  }
  read() {
    if (!existsSync(this.path)) return null;
    if (!this.available()) throw new Error('Secure credential storage is unavailable.');
    return this.storage.decryptString(readFileSync(this.path));
  }
  save(value) {
    const token = typeof value === 'string' ? value.trim() : '';
    if (
      token.length < 20 ||
      token.length > 512 ||
      !/^(?:ghp_|github_pat_)[A-Za-z0-9_]+$/.test(token)
    )
      throw new Error('Enter a GitHub personal access token.');
    if (!this.available()) throw new Error('Enable your system keyring to save a GitHub token.');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = this.path + '.' + randomUUID();
    try {
      writeFileSync(temporary, this.storage.encryptString(token), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
    return token;
  }
}
module.exports = { GitHubCredentials };
