/** Appels au serveur. Le jeton de session est gardé en mémoire et dans la base locale. */

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let token: string | null = null;

export function setToken(t: string | null): void {
  token = t;
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // réponse vide ou non JSON
  }
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `erreur ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}
