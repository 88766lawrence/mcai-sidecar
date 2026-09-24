const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = typeof window === "undefined" ? "" : sessionStorage.getItem("mcai_token") ?? "";
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401 && typeof window !== "undefined") {
      sessionStorage.removeItem("mcai_token");
      window.dispatchEvent(new Event("mcai:unauthorized"));
    }
    throw new Error(body.message ?? body.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export async function apiStream<T>(path: string, init: RequestInit, onEvent: (event: T) => void | Promise<void>): Promise<void> {
  const token = typeof window === "undefined" ? "" : sessionStorage.getItem("mcai_token") ?? "";
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401 && typeof window !== "undefined") {
      sessionStorage.removeItem("mcai_token");
      window.dispatchEvent(new Event("mcai:unauthorized"));
    }
    throw new Error(body.message ?? body.error ?? `Request failed (${response.status})`);
  }
  if (!response.body) throw new Error("浏览器未收到流式响应");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) await onEvent(JSON.parse(line) as T);
    }
    if (done) break;
  }
  if (buffer.trim()) await onEvent(JSON.parse(buffer) as T);
}
