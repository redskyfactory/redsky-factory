const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  },
});

const clean = (value, maxLength) => String(value ?? "").trim().slice(0, maxLength);
const cleanLine = (value, maxLength) => clean(value, maxLength).replace(/[\r\n]+/g, " ");

const typeLabels = {
  general: "일반 문의",
  melodywave: "MelodyWave 문의",
  onepic: "OnePic 문의",
  bug: "오류 제보",
};

async function verifyTurnstile(token, secret, remoteIp) {
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (remoteIp) body.append("remoteip", remoteIp);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
  });
  if (!response.ok) return false;
  const result = await response.json();
  return result.success === true;
}

export async function onRequestGet({ env }) {
  return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || "" });
}

export async function onRequestPost({ request, env }) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && origin !== requestUrl.origin) {
    return json({ message: "invalid_origin" }, 403);
  }

  if (!request.headers.get("Content-Type")?.includes("application/json")) {
    return json({ message: "invalid_content_type" }, 415);
  }

  const rawBody = await request.text();
  if (rawBody.length > 12000) {
    return json({ message: "request_too_large" }, 413);
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (_) {
    return json({ message: "invalid_json" }, 400);
  }

  if (clean(body.website, 200)) {
    return json({ success: true });
  }

  const type = cleanLine(body.type, 30);
  const name = cleanLine(body.name, 80);
  const email = cleanLine(body.email, 160);
  const message = clean(body.message, 5000);
  const language = body.language === "en" ? "en" : "ko";
  const openedAt = Number(body.openedAt);

  if (!typeLabels[type] || !email || !message) {
    return json({ message: "missing_fields" }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ message: "invalid_email" }, 400);
  }
  if (message.length < 10) {
    return json({ message: "message_too_short" }, 400);
  }
  if (Number.isFinite(openedAt) && Date.now() - openedAt < 1800) {
    return json({ message: "submitted_too_quickly" }, 429);
  }

  if (env.TURNSTILE_SECRET_KEY) {
    const turnstileToken = clean(body.turnstileToken, 2048);
    const remoteIp = request.headers.get("CF-Connecting-IP") || "";
    if (!turnstileToken || !(await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET_KEY, remoteIp))) {
      return json({ message: "turnstile_failed" }, 403);
    }
  }

  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_EMAIL_API_TOKEN;
  if (!accountId || !apiToken) {
    return json({ message: "email_service_not_configured" }, 503);
  }

  const recipient = env.CONTACT_TO || "contact@redskyfactory.com";
  const sender = env.CONTACT_FROM || "website@redskyfactory.com";
  const typeLabel = typeLabels[type];
  const subjectName = name || (language === "ko" ? "이름 없음" : "No name");
  const text = [
    "Redsky Factory 웹사이트에서 새 문의가 도착했습니다.",
    "",
    `문의 유형: ${typeLabel}`,
    `이름: ${name || "-"}`,
    `회신 이메일: ${email}`,
    `작성 언어: ${language.toUpperCase()}`,
    "",
    "문의 내용",
    "----------------------------------------",
    message,
  ].join("\n");

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/email/sending/send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: recipient,
        from: sender,
        reply_to: email,
        subject: `[Redsky Factory] ${typeLabel} - ${subjectName}`,
        text,
      }),
    },
  );

  const result = await response.json().catch(() => null);
  if (!response.ok || result?.success !== true) {
    console.error("Contact email delivery failed", response.status, result?.errors || result);
    return json({ message: "email_delivery_failed" }, 502);
  }

  return json({ success: true });
}
