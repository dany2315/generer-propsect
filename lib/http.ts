export async function fetchJsonWithRetry(url: string, options: RequestInit, label: string) {
  try {
    const response = await fetch(url, options);

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After") ?? 30);
      await wait(retryAfter * 1000);
      return fetchJsonWithRetry(url, options, label);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`${label}: HTTP ${response.status} ${response.statusText} ${body.slice(0, 400)}`);
    }

    return response.json();
  } catch (error) {
    throw new Error(`${label}: ${(error as Error).message}`);
  }
}

export function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
