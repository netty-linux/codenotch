export function gatewayUrl(base: string, endpoint: string) {
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Invalid gateway URL");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("Remote gateways require HTTPS");
  return `${base.replace(/\/$/, "").replace(/\/v1$/, "")}/v1/${endpoint}`;
}
export async function complete(
  base: string,
  key: string,
  model: string,
  messages: { role: string; content: string }[],
  signal: AbortSignal,
) {
  const response = await fetch(gatewayUrl(base, "chat/completions"), {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ model, messages, stream: false }),
    signal,
  });
  if (!response.ok) throw new Error(`Gateway HTTP ${response.status}`);
  const data = (await response.json()) as any;
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Gateway returned no text");
  return {
    content,
    model: typeof data.model === "string" ? data.model : model,
  };
}
