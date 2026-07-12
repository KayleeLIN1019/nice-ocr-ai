import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { logger } from "@/lib/logger";

/**
 * 统一的 route handler 错误处理 + 请求体校验工具。
 *
 * 设计为「在标准 handler 内部调用」而非包裹导出函数，以免改变 Next 16 对
 * route export 的签名/类型校验（next build 会校验路由导出签名）。
 */

/** 业务错误：带 HTTP 状态码与稳定 code，路由可显式抛出，由 handleRoute 规范化。 */
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = "ERROR") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string, code = "BAD_REQUEST") => new ApiError(400, message, code);
export const notFound = (message = "未找到资源", code = "NOT_FOUND") => new ApiError(404, message, code);

/**
 * 在 route handler 内部包裹业务逻辑，集中规范化错误响应：
 * - ZodError → 400 { error, code: "VALIDATION", issues }
 * - ApiError → 其 status + code
 * - 其它未捕获异常 → 记录日志并返回 500（不向客户端泄露内部细节）
 */
export async function handleRoute(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: "请求参数校验失败", code: "VALIDATION", issues: error.issues },
        { status: 400 },
      );
    }
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    logger.error("unhandled route error", {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    return NextResponse.json({ error: "服务器内部错误", code: "INTERNAL" }, { status: 500 });
  }
}

/** 解析并用 zod schema 校验 JSON 请求体（非法 JSON → 400；校验失败抛 ZodError → handleRoute 转 400）。 */
export async function parseJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest("请求体不是合法 JSON");
  }
  return schema.parse(raw);
}
