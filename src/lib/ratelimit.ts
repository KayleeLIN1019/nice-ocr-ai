import { NextResponse } from "next/server";

/**
 * 进程内固定窗口限流。本系统是单实例（SQLite 同进程库 + 单 Next 进程），
 * 用内存 Map 即可，无需 Redis。主要目的：防止失控客户端 / 误循环把付费
 * AI 额度烧光，独立于是否启用鉴权。
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const store = new Map<string, Bucket>();

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  limit: number;
  resetAt: number;
  retryAfterMs: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const existing = store.get(key);
  if (!existing || existing.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, limit, resetAt: now + windowMs, retryAfterMs: 0 };
  }
  if (existing.count >= limit) {
    return { ok: false, remaining: 0, limit, resetAt: existing.resetAt, retryAfterMs: existing.resetAt - now };
  }
  existing.count += 1;
  return { ok: true, remaining: limit - existing.count, limit, resetAt: existing.resetAt, retryAfterMs: 0 };
}

function clientId(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
}

/**
 * 在 route handler 顶部调用：超限返回 429 NextResponse，未超限返回 null。
 * 用法：const limited = enforceRateLimit(request, "audit", 20, 60_000); if (limited) return limited;
 */
export function enforceRateLimit(
  request: Request,
  bucket: string,
  limit: number,
  windowMs: number,
): NextResponse | null {
  const result = rateLimit(`${bucket}:${clientId(request)}`, limit, windowMs);
  if (result.ok) return null;
  const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  return NextResponse.json(
    { error: `请求过于频繁，请在 ${retryAfter} 秒后重试。`, code: "RATE_LIMITED" },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
        "X-RateLimit-Limit": String(limit),
        "X-RateLimit-Remaining": "0",
      },
    },
  );
}
