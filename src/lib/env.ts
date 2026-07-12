export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "file:./dev.db",
  storageDir: process.env.STORAGE_DIR ?? "./storage",
  /** AES-256-GCM 主密钥（base64 的 32 字节），用于 provider apiKey 静态加密。未设置时无法保存新 Key。 */
  providerKeyEncryptionKey: process.env.PROVIDER_KEY_ENCRYPTION_KEY,
};
