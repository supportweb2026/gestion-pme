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

export function getToken(): string | null {
  return token;
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

/** Envoie un justificatif (octets bruts). */
export async function uploadFile(id: string, blob: Blob): Promise<void> {
  const res = await fetch(`/api/files/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": blob.type, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: blob,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, data?.error ?? `erreur ${res.status}`);
  }
}

/** Télécharge un justificatif pris sur un autre appareil. */
export async function downloadFile(id: string): Promise<Blob> {
  const res = await fetch(`/api/files/${encodeURIComponent(id)}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, res.status === 404 ? "justificatif pas encore envoyé par l'appareil qui l'a pris" : `erreur ${res.status}`);
  return res.blob();
}
