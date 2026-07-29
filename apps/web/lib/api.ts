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
