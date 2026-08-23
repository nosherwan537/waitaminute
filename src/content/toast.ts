/**
 * The toast is the entire product UI, so it gets disproportionate care.
 *
 * Premise 7 says the video never stops and the user never leaves the tab.
 * Consequences, all of them load-bearing:
 *
 *   - It NEVER takes focus. No button, no input, no autofocus, no tabindex.
 *     Stealing focus from the player would break spacebar-to-pause, which is
 *     a P0 bug for a tool whose whole point is not interrupting you.
 *   - Top-right, not bottom: the player's controls live along the bottom edge.
 *   - pointer-events: none while it's transient, so it can never eat a click.
 *   - Success auto-dismisses in 2s. Errors stay until clicked, because an
 *     error you didn't see is a silent failure.
 *   - Shadow DOM, so YouTube's stylesheet can't reach in and neither can ours
 *     reach out.
 */

type ToastState = "processing" | "success" | "error" | "info";

const HOST_ID = "waitaminute-toast-host";
const AUTO_DISMISS_MS = 2000;

let dismissTimer: number | undefined;
let elapsedTimer: number | undefined;

const COLORS: Record<ToastState, { bg: string; fg: string }> = {
  processing: { bg: "rgba(28,28,30,.94)", fg: "#e8e8ed" },
  success: { bg: "rgba(20,83,45,.94)", fg: "#dcfce7" },
  error: { bg: "rgba(127,29,29,.94)", fg: "#fee2e2" },
  info: { bg: "rgba(28,28,30,.94)", fg: "#c7c7cc" },
};

function ensureHost(): ShadowRoot {
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = HOST_ID;
    // Fixed on the host so page layout is never affected.
    host.style.cssText = "position:fixed;top:0;right:0;z-index:2147483647;pointer-events:none";
    document.documentElement.appendChild(host);
    host.attachShadow({ mode: "open" });
  }
  return host.shadowRoot as ShadowRoot;
}

export function showToast(state: ToastState, text: string, count?: number): void {
  const root = ensureHost();
  if (dismissTimer !== undefined) {
    clearTimeout(dismissTimer);
    dismissTimer = undefined;
  }
  if (elapsedTimer !== undefined) {
    clearInterval(elapsedTimer);
    elapsedTimer = undefined;
  }

  const { bg, fg } = COLORS[state];
  const label = state === "success" && count !== undefined ? `${text} (${count} today)` : text;
  const sticky = state === "error";

  root.innerHTML = `
    <style>
      @keyframes in { from { opacity:0; transform:translateY(-6px) } to { opacity:1; transform:none } }
      .t {
        margin: 16px 16px 0 0;
        padding: 10px 14px;
        max-width: 320px;
        border-radius: 10px;
        background: ${bg};
        color: ${fg};
        font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        box-shadow: 0 8px 24px rgba(0,0,0,.28);
        backdrop-filter: blur(12px);
        animation: in .16s ease-out;
        /* Only errors are clickable. Everything else must not intercept input. */
        pointer-events: ${sticky ? "auto" : "none"};
        ${sticky ? "cursor:pointer;" : ""}
        user-select: none;
      }
      .d { opacity:.65; font-size:11px; margin-top:3px }
    </style>
    <div class="t" role="status" aria-live="polite">
      ${escapeHtml(label)}
      ${state === "processing" ? '<div class="d"><span class="e">0</span>s</div>' : ""}
      ${sticky ? '<div class="d">click to dismiss</div>' : ""}
    </div>
  `;

  // A motionless "Noting that..." is indistinguishable from a crash. Latency is
  // not a tight constraint here (premise 7: they pressed and kept watching), but
  // AMBIGUITY is — a working 35s capture was reported as a hang for want of this.
  if (state === "processing") {
    const started = Date.now();
    elapsedTimer = window.setInterval(() => {
      const el = root.querySelector(".e");
      // The toast was replaced by a later state; stop counting against a dead node.
      if (!el) {
        clearInterval(elapsedTimer);
        elapsedTimer = undefined;
        return;
      }
      el.textContent = String(Math.round((Date.now() - started) / 1000));
    }, 1000);
  }

  if (sticky) {
    root.querySelector(".t")?.addEventListener("click", () => {
      root.innerHTML = "";
    });
  } else if (state !== "processing") {
    dismissTimer = window.setTimeout(() => {
      root.innerHTML = "";
    }, AUTO_DISMISS_MS);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}
