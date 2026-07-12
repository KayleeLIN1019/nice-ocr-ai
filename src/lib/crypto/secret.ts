import crypto from "node:crypto";
import { env } from "@/lib/env";

/**
 * Provider API Key 等敏感串的静态加密（encryption at rest）。
 *
 * 采用 Node 内置 AES-256-GCM（带认证标签，防篡改），主密钥来自环境变量
 * PROVIDER_KEY_ENCRYPTION_KEY（base64 编码的 32 字节）。密文格式：
 *   enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 *
 * 解密对“无前缀”的旧明文原样返回，便于迁移期平滑过渡（先上线读路径兼容，
 * 再用 scripts/encrypt-secrets.ts 把存量明文加密）。
 */

const PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function getMasterKey(): Buffer {
  const raw = env.providerKeyEncryptionKey;
  if (!raw) {
    throw new Error(
      "PROVIDER_KEY_ENCRYPTION_KEY 未设置。请用 `openssl rand -base64 32` 生成一个 32 字节密钥并写入 .env，再保存 provider API Key。",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      "PROVIDER_KEY_ENCRYPTION_KEY 必须是 base64 编码的 32 字节密钥（例如 `openssl rand -base64 32` 的输出）。",
    );
  }
  return key;
}

export function hasEncryptionKey(): boolean {
  return Boolean(env.providerKeyEncryptionKey);
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function encryptSecret(plain: string): string {
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

/**
 * 写库前加密。
 * - undefined → 透传（表示“不更新该字段”）。
 * - "" → 透传（表示“清空 Key”）。
 * - 已加密（带前缀）→ 原样返回，幂等。
 * - 明文 → 加密。
 */
export function encryptSecretForStorage(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === "") return "";
  if (isEncrypted(value)) return value;
  return encryptSecret(value);
}

/**
 * 读库后解密。
 * - 空值 → ""。
 * - 无前缀的旧明文 → 原样返回（迁移期兼容）。
 * - 带前缀密文 → 解密（密钥缺失或被篡改会抛错）。
 */
export function decryptSecret(value: string | null | undefined): string {
  if (!value) return "";
  if (!isEncrypted(value)) return value;
  const [ivB64, tagB64, ctB64] = value.slice(PREFIX.length).split(":");
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error("加密的密钥值格式不正确（无法解析 iv/tag/ciphertext）。");
  }
  const key = getMasterKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]);
  return plain.toString("utf8");
}
