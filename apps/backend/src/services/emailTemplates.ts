/**
 * Transactional email templates. Everything is inline-styled, table-based HTML
 * (email clients strip <style> blocks and ignore classes) with a plain-text
 * alternative always provided. No remote images — a text wordmark keeps the
 * mail self-contained and out of spam heuristics.
 */

// Brand tokens mirrored from apps/frontend/src/styles.css (email HTML can't
// read CSS variables, so the values are pinned here).
const BRAND_YELLOW = "#f5c418";
const CARD_BG = "#1c1b1b";
const CARD_BORDER = "#414755";
const TEXT_MAIN = "#e5e2e1";
const TEXT_MUTED = "#a8adbd";
const PAGE_BG = "#f4f4f5";

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export function renderVerificationCodeEmail(code: string, expiresMinutes: number): RenderedEmail {
  const subject = `${code} is your VoxTable verification code`;

  const text = [
    "Your VoxTable verification code",
    "",
    code,
    "",
    `Enter this code on the verify screen to confirm your email. It expires in ${expiresMinutes} minutes.`,
    "",
    "Didn't create a VoxTable account? You can safely ignore this email.",
    "",
    "VoxTable — voice AI booking for restaurants",
    "Biteperk Pty Ltd · biteperk.com.au"
  ].join("\n");

  const digits = code
    .split("")
    .map(
      (d) =>
        `<td style="width:44px;height:56px;border:1px solid ${CARD_BORDER};border-radius:10px;` +
        `background:#131313;color:${BRAND_YELLOW};font-family:'Courier New',monospace;` +
        `font-size:28px;font-weight:700;text-align:center;vertical-align:middle;">${d}</td>` +
        `<td style="width:8px;"></td>`
    )
    .join("");

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:${PAGE_BG};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE_BG};padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="440" cellpadding="0" cellspacing="0"
                 style="max-width:440px;width:100%;background:${CARD_BG};border:1px solid ${CARD_BORDER};border-radius:16px;">
            <tr>
              <td style="padding:36px 32px 28px;text-align:center;">
                <div style="font-family:Helvetica,Arial,sans-serif;font-size:26px;font-weight:700;color:${BRAND_YELLOW};letter-spacing:-0.02em;">
                  VoxTable
                </div>
                <div style="font-family:'Courier New',monospace;font-size:11px;letter-spacing:0.08em;color:${TEXT_MUTED};text-transform:uppercase;margin-top:4px;">
                  Voice AI booking for restaurants
                </div>
                <hr style="border:none;border-top:1px solid ${CARD_BORDER};margin:24px 0;" />
                <div style="font-family:Helvetica,Arial,sans-serif;font-size:18px;font-weight:600;color:${TEXT_MAIN};margin-bottom:6px;">
                  Your verification code
                </div>
                <div style="font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:19px;color:${TEXT_MUTED};margin-bottom:24px;">
                  Enter this code on the verify screen to confirm your email.
                </div>
                <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto;">
                  <tr>${digits}</tr>
                </table>
                <div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;color:${TEXT_MUTED};margin-top:20px;">
                  This code expires in ${expiresMinutes} minutes.
                </div>
                <hr style="border:none;border-top:1px solid ${CARD_BORDER};margin:24px 0;" />
                <div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:${TEXT_MUTED};">
                  Didn't create a VoxTable account? You can safely ignore this email.
                </div>
              </td>
            </tr>
          </table>
          <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#8a8f9e;margin-top:16px;">
            VoxTable · Biteperk Pty Ltd · biteperk.com.au
          </div>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}
