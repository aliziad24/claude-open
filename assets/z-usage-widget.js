(() => {
  'use strict';

  if (window.__claudeOpenUsageWidget) return;
  window.__claudeOpenUsageWidget = true;

  const STYLE_ID = 'claude-open-usage-style';
  const ROOT_ID = 'claude-open-usage-widget';
  const POLL_MS = 10000;
  let open = false;
  let lastUsage = null;
  let lastModels = [];

  const format = (value) => {
    const number = Number(value || 0);
    if (number >= 1e9) return `${(number / 1e9).toFixed(1)}B`;
    if (number >= 1e6) return `${(number / 1e6).toFixed(1)}M`;
    if (number >= 1e3) return `${(number / 1e3).toFixed(1)}K`;
    return number.toLocaleString();
  };

  const firstNumber = (...values) => {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) return number;
    }
    return null;
  };

  function gatewayAccountSnapshot() {
    const gateway = lastUsage?.gateway;
    const plan = gateway?.plan?.available ? gateway.plan.data : null;
    const usage = gateway?.usage?.available ? gateway.usage.data : null;
    const nested = usage?.usage || plan?.usage || {};
    const used = firstNumber(
      usage?.monthly_used,
      usage?.monthly_tokens_used,
      nested.monthly_used,
      nested.monthly_tokens_used,
    );
    const cap = firstNumber(
      usage?.monthly_cap,
      usage?.monthly_token_limit,
      plan?.monthly_token_limit,
      nested.monthly_cap,
    );
    return {
      available: Boolean(gateway && (gateway.plan?.available || gateway.usage?.available)),
      used,
      cap,
      percent: used != null && cap > 0 ? Math.max(0, Math.min(100, (used / cap) * 100)) : null,
      fetchedAt: gateway?.fetchedAt || null,
    };
  }

  function addStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID}{position:fixed;right:18px;bottom:18px;z-index:2147483000;font:12px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#f5f4ef}
      #${ROOT_ID} button{font:inherit}
      .co-usage-pill{border:1px solid rgba(255,255,255,.16);background:#262624;color:#f5f4ef;border-radius:999px;padding:8px 12px;box-shadow:0 8px 28px rgba(0,0,0,.25);cursor:pointer}
      .co-usage-pill:hover{background:#302f2c}
      .co-usage-panel{position:absolute;right:0;bottom:44px;width:330px;max-height:min(520px,70vh);overflow:auto;background:#1f1e1d;border:1px solid rgba(255,255,255,.14);border-radius:14px;padding:14px;box-shadow:0 18px 60px rgba(0,0,0,.42)}
      .co-usage-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
      .co-usage-title{font-size:14px;font-weight:700}
      .co-usage-close{border:0;background:transparent;color:#b8b5a9;cursor:pointer;font-size:18px;line-height:1}
      .co-usage-refresh{border:1px solid rgba(255,255,255,.16);background:#292825;color:#f5f4ef;border-radius:7px;padding:5px 9px;cursor:pointer}
      .co-usage-refresh:disabled{cursor:wait;opacity:.7}
      .co-usage-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}
      .co-usage-card{background:#292825;border:1px solid rgba(255,255,255,.08);border-radius:9px;padding:9px}
      .co-usage-label{color:#aaa79f;font-size:10px;text-transform:uppercase;letter-spacing:.05em}
      .co-usage-value{font-size:16px;font-weight:700;margin-top:2px}
      .co-usage-note{color:#aaa79f;font-size:10px;margin:7px 0 10px}
      .co-usage-model{padding:8px 0;border-top:1px solid rgba(255,255,255,.08)}
      .co-usage-model:first-child{border-top:0}
      .co-usage-row{display:flex;justify-content:space-between;gap:10px}
      .co-usage-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:230px}
      .co-usage-muted{color:#aaa79f;font-size:10px}
      .co-usage-bar{height:4px;background:#393733;border-radius:999px;margin-top:5px;overflow:hidden}
      .co-usage-fill{height:100%;background:#d97757;border-radius:999px}
      .co-usage-error{color:#e07a74;padding:4px 0}
    `;
    document.head.appendChild(style);
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function card(label, value) {
    const node = element('div', 'co-usage-card');
    node.append(element('div', 'co-usage-label', label), element('div', 'co-usage-value', value));
    return node;
  }

  function render() {
    addStyle();
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = element('div');
      root.id = ROOT_ID;
      document.body.appendChild(root);
    }
    root.replaceChildren();

    const totals = lastUsage?.totals || {};
    const account = gatewayAccountSnapshot();
    const pillText = account.percent != null
      ? `Usage ${Math.round(account.percent)}%`
      : `Usage ${format(totals.totalTokens)} tokens`;
    const pill = element('button', 'co-usage-pill', pillText);
    pill.type = 'button';
    pill.title = 'Claude Open session usage';
    pill.addEventListener('click', () => { open = !open; render(); });
    root.appendChild(pill);
    if (!open) return;

    const panel = element('section', 'co-usage-panel');
    const head = element('div', 'co-usage-head');
    head.appendChild(element('div', 'co-usage-title', account.available ? 'Gateway usage' : 'Session usage'));
    const actions = element('div', 'co-usage-row');
    const refreshButton = element('button', 'co-usage-refresh', 'Refresh');
    refreshButton.type = 'button';
    refreshButton.addEventListener('click', async () => {
      refreshButton.disabled = true;
      refreshButton.textContent = 'Refreshing…';
      const before = lastUsage?.gateway?.fetchedAt || 0;
      await refresh({ waitForNewerThan: before });
    });
    const close = element('button', 'co-usage-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close usage');
    close.addEventListener('click', () => { open = false; render(); });
    actions.append(refreshButton, close);
    head.appendChild(actions);
    panel.appendChild(head);

    if (!lastUsage) {
      panel.appendChild(element('div', 'co-usage-error', 'Waiting for the local adapter…'));
      root.appendChild(panel);
      return;
    }

    if (account.available) {
      const accountGrid = element('div', 'co-usage-grid');
      accountGrid.append(
        card('Monthly used', account.used == null ? 'Not provided' : format(account.used)),
        card('Monthly limit', account.cap == null ? 'Not provided' : format(account.cap)),
      );
      if (account.percent != null) accountGrid.appendChild(card('Monthly usage', `${account.percent.toFixed(1)}%`));
      panel.appendChild(accountGrid);
      const freshness = account.fetchedAt ? new Date(account.fetchedAt).toLocaleTimeString() : 'just now';
      panel.appendChild(element('div', 'co-usage-note', `Fresh gateway account data · updated ${freshness}`));
      panel.appendChild(element('div', 'co-usage-title', 'This Claude Open session'));
    }

    const grid = element('div', 'co-usage-grid');
    grid.append(
      card('Requests', format(totals.requests)),
      card('Total tokens', format(totals.totalTokens)),
      card('Input', format(totals.inputTokens)),
      card('Output', format(totals.outputTokens)),
      card('Cache read', format(totals.cacheReadInputTokens)),
      card('Reasoning', format(totals.reasoningTokens)),
    );
    panel.appendChild(grid);
    panel.appendChild(element('div', 'co-usage-note', account.available
      ? 'Session tokens are observed locally; account totals above come only from the configured gateway.'
      : 'Observed in this Claude Open session. Billing and quota are not estimated. Configure mapped usage endpoints when your gateway exposes them.'));

    const models = (lastUsage.models || [])
      .filter((model) => model.requests > 0)
      .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens);
    const count = lastModels.length || (lastUsage.models || []).length;
    panel.appendChild(element('div', 'co-usage-title', `${count} available model${count === 1 ? '' : 's'}`));
    const list = element('div');
    if (!models.length) {
      list.appendChild(element('div', 'co-usage-muted', 'No completed requests yet.'));
    }
    for (const model of models.slice(0, 12)) {
      const row = element('div', 'co-usage-model');
      const top = element('div', 'co-usage-row');
      const name = element('div', 'co-usage-name', model.model);
      name.title = model.model;
      top.append(name, element('div', '', format(model.totals.totalTokens)));
      row.appendChild(top);
      const context = model.context || {};
      if (context.available && context.utilizationPercent != null) {
        const meta = element('div', 'co-usage-row co-usage-muted');
        meta.append(
          element('span', '', `Last request context: ${context.utilizationPercent}%`),
          element('span', '', format(context.window)),
        );
        const bar = element('div', 'co-usage-bar');
        const fill = element('div', 'co-usage-fill');
        fill.style.width = `${Math.max(0, Math.min(100, context.utilizationPercent))}%`;
        bar.appendChild(fill);
        row.append(meta, bar);
      } else {
        row.appendChild(element('div', 'co-usage-muted', `${model.requests} completed request${model.requests === 1 ? '' : 's'}`));
      }
      list.appendChild(row);
    }
    panel.appendChild(list);
    root.appendChild(panel);
  }

  async function readSnapshots() {
    try {
      const stamp = Date.now();
      const [usageResponse, modelsResponse] = await Promise.all([
        fetch(`/assets/v1/co-usage-session.json?_=${stamp}`, { cache: 'no-store' }),
        fetch(`/assets/v1/co-usage-models.json?_=${stamp}`, { cache: 'no-store' }),
      ]);
      if (usageResponse.ok) lastUsage = await usageResponse.json();
      if (modelsResponse.ok) {
        const payload = await modelsResponse.json();
        lastModels = Array.isArray(payload) ? payload : (payload.data || []);
      }
      return true;
    } catch {
      // The adapter may still be starting. Keep the last good snapshot.
      return false;
    }
  }

  async function refresh({ waitForNewerThan = 0 } = {}) {
    const deadline = Date.now() + 12000;
    do {
      await readSnapshots();
      if (!waitForNewerThan || Number(lastUsage?.gateway?.fetchedAt || 0) > Number(waitForNewerThan)) break;
      await new Promise((resolve) => setTimeout(resolve, 750));
    } while (Date.now() < deadline);
    render();
  }

  const start = () => {
    render();
    refresh();
    setInterval(refresh, POLL_MS);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
