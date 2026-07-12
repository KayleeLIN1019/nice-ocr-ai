/** 从错误响应解析可读消息：优先 JSON 的 { error } 字段，否则回退原始文本/状态码。 */
async function errorFromResponse(response: Response): Promise<Error> {
  const text = await response.text();
  try {
    const body = JSON.parse(text);
    if (body && typeof body.error === "string") return new Error(body.error);
  } catch {
    /* 非 JSON，回退到原始文本 */
  }
  return new Error(text || `请求失败（${response.status}）`);
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw await errorFromResponse(response);
  return response.json() as Promise<T>;
}

export async function apiJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw await errorFromResponse(response);
  return response.json() as Promise<T>;
}

export async function apiUpload<T>(path: string, formData: FormData): Promise<T> {
  const response = await fetch(path, { method: "POST", body: formData });
  if (!response.ok) throw await errorFromResponse(response);
  return response.json() as Promise<T>;
}

/**
 * 触发服务端生成的文件下载（导出 xlsx 等），从 content-disposition 解析文件名。
 */
export async function apiDownload(path: string, init: RequestInit = { method: "POST" }): Promise<void> {
  const response = await fetch(path, init);
  if (!response.ok) throw await errorFromResponse(response);
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const fileName = match?.[1] ?? "download";
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
