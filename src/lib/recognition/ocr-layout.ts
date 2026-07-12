/**
 * 本地 OCR 版面 provider：调用 PaddleOCR 旁路服务（tools/ocr-layout）拿到每条文字行的
 * 归一化包围盒 + 文本，作为行级原图定位的「真实坐标」来源，替代多模态模型自行估算的坐标。
 *
 * 抽象成 OcrLayoutProvider 接口（与识别 provider 一致的可插拔思路）：当前实现走本地 HTTP，
 * 后续若接云 OCR 只需新增一个实现，worker / 匹配逻辑无需改动。
 */

export interface OcrLayoutBox {
  /** 归一化到图片自然尺寸，范围 0..1；x/y 为左上角。 */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrLayoutLine {
  text: string;
  score: number;
  box: OcrLayoutBox;
}

export interface OcrLayoutResult {
  width: number;
  height: number;
  lines: OcrLayoutLine[];
}

export interface OcrLayoutRequest {
  /** 与服务同机时优先传本机路径（零拷贝）；否则传 base64。 */
  imagePath?: string;
  imageBase64?: string;
}

export interface OcrLayoutProvider {
  layout(input: OcrLayoutRequest): Promise<OcrLayoutResult>;
}

export class PaddleHttpOcrLayoutProvider implements OcrLayoutProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 60_000,
  ) {}

  async layout(input: OcrLayoutRequest): Promise<OcrLayoutResult> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/layout`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`OCR layout 服务返回 ${response.status} ${response.statusText} ${detail}`.trim());
    }
    return (await response.json()) as OcrLayoutResult;
  }
}

/**
 * 解析 OCR 版面 provider：URL 来自参数或 `OCR_LAYOUT_URL` 环境变量。
 * 未配置则返回 null（worker 据此降级回模型坐标，不报错）。
 */
export function createOcrLayoutProvider(url?: string | null): OcrLayoutProvider | null {
  const base = (url ?? process.env.OCR_LAYOUT_URL)?.trim();
  return base ? new PaddleHttpOcrLayoutProvider(base) : null;
}
