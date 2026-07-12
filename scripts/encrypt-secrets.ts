import "dotenv/config";

import { prisma } from "@/lib/db/client";
import { encryptSecret, isEncrypted } from "@/lib/crypto/secret";

/**
 * 一次性迁移：把数据库里 provider 的明文 apiKey 就地加密为 AES-256-GCM 密文。
 * 幂等——已加密（带 enc:v1: 前缀）或为空的会跳过。
 * 需要先在 .env 设置 PROVIDER_KEY_ENCRYPTION_KEY。
 *
 * 用法：pnpm db:encrypt-secrets
 */
async function main() {
  const providers = await prisma.aiProviderConfig.findMany();
  let migrated = 0;
  let skipped = 0;
  for (const provider of providers) {
    const key = provider.apiKey;
    if (!key || isEncrypted(key)) {
      skipped += 1;
      continue;
    }
    await prisma.aiProviderConfig.update({
      where: { id: provider.id },
      data: { apiKey: encryptSecret(key) },
    });
    migrated += 1;
  }
  console.log(`已加密 ${migrated} 个 provider 的 API Key（跳过 ${skipped} 个：空或已加密）。`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
