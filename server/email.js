// email.js - the one thing this app sends, and how it gets out.
//
// There is exactly one transactional email: a password reset link. That is a
// deliberately small surface, and it is why there is no template engine, no
// queue, and no npm dependency here - a fetch to a provider's API and a
// fallback are the whole of it.
//
// THE FALLBACK IS THE IMPORTANT PART. With no provider configured this does not
// fail: it writes the reset link to the server log. That means password reset
// works from the first day on a self-hosted box with no API key, no DNS
// records and no account with anyone - the operator reads the link out of the
// log and hands it over. It also means the entire flow is testable without
// sending a single email, which is what makes it testable at all here.
//
// Sending for real is then one environment variable, in the same shape as the
// TURN key: the secret stays on the server and never goes near the repo.
//
//   EMAIL_API_KEY  - Resend API key. Absent means log-only (see above).
//   EMAIL_FROM     - the From address, e.g. "AIO Darts <noreply@aiodarts.com>".
//                    Must be a domain verified with the provider, or mail will
//                    be accepted and then silently dropped.
//   PUBLIC_URL     - the site's own address, used to build the link. Without it
//                    the link cannot be built correctly, so it falls back to
//                    logging even when a key IS set: a reset email pointing at
//                    the wrong host is worse than no email.

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export function emailConfigured() {
  return Boolean(process.env.EMAIL_API_KEY && process.env.EMAIL_FROM && process.env.PUBLIC_URL);
}

export function resetUrl(token) {
  // A VISIBLE placeholder when PUBLIC_URL is unset, rather than an empty
  // string. Without one the logged link came out as "/#/reset?token=..." - a
  // bare path that reads as broken and has to be mentally prefixed with the
  // site's address, in the one path that exists for people running this
  // themselves.
  //
  // The host is deliberately NOT taken from the request's Host header, which
  // would produce a correct URL automatically and is the obvious fix. That is
  // password reset poisoning: a forged Host makes the link point at an
  // attacker's server, which then collects the token. An explicit PUBLIC_URL
  // is the whole defence, so the fallback stays obviously-a-template instead
  // of quietly trusting input.
  const base = (process.env.PUBLIC_URL || "").replace(/\/+$/, "") || "https://YOUR-SITE";
  // The hash route, because this is a single page with tabs and accountui.js
  // already routes on the hash - see applyHash().
  return `${base}/#/reset?token=${encodeURIComponent(token)}`;
}

// Never throws. A provider outage must not turn "we sent you a link" into a
// 500, and must not tell the caller whether the address existed - the endpoint
// answers identically either way, so a failure here is logged and swallowed.
export async function sendPasswordReset(email, token) {
  const url = resetUrl(token);

  if (!emailConfigured()) {
    // Not a warning: on a self-hosted deployment this is the intended path.
    console.log(
      `\n  password reset for ${email}\n    ${url}\n` +
      (process.env.PUBLIC_URL
        ? "    (no mail provider configured - logging instead of sending)\n"
        : "    (set PUBLIC_URL to have the real address here; replace YOUR-SITE by hand for now)\n")
    );
    return { sent: false, logged: true };
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.EMAIL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: [email],
        subject: "Reset your AIO Darts password",
        // Plain text only. An HTML mail would need a template, and every mail
        // client renders this correctly without one.
        text:
          "Someone asked to reset the password for your AIO Darts account.\n\n" +
          `${url}\n\n` +
          "The link works once and expires in an hour.\n\n" +
          "If this wasn't you, you can ignore this - your password has not changed.",
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { sent: true, logged: false };
  } catch (err) {
    // Logged WITH the link, so a provider outage does not also mean a locked
    // out player: the operator can still read it out of the log.
    console.warn(
      `Password reset email to ${email} failed (${err.message}). Link was:\n    ${url}`
    );
    return { sent: false, logged: true };
  }
}
