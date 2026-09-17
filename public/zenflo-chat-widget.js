/* ZenFlo support chat widget.
   Paste this ONE line before </body> on every zenflo.co.uk page you want it on:
   <script src="/zenflo-chat-widget.js"></script>
   Talks to the /api/chat endpoint on app.zenflo.co.uk. */
(function () {
  var API_URL = 'https://app.zenflo.co.uk/api/chat';

  var css = `
    .zf-chat-bubble{position:fixed;bottom:24px;right:24px;width:58px;height:58px;border-radius:50%;
      background:#1B8A6B;border:none;cursor:pointer;box-shadow:0 6px 20px rgba(13,27,42,0.4);
      display:flex;align-items:center;justify-content:center;z-index:9998;transition:transform .2s;
      animation:zf-pulse 2.5s infinite;}
    .zf-chat-bubble:hover{transform:scale(1.06);background:#4DC4A0;}
    .zf-chat-bubble svg{width:26px;height:26px;}
    @keyframes zf-pulse{
      0%{box-shadow:0 6px 20px rgba(13,27,42,0.4), 0 0 0 0 rgba(77,196,160,0.55);}
      70%{box-shadow:0 6px 20px rgba(13,27,42,0.4), 0 0 0 14px rgba(77,196,160,0);}
      100%{box-shadow:0 6px 20px rgba(13,27,42,0.4), 0 0 0 0 rgba(77,196,160,0);}
    }
    .zf-teaser{position:fixed;bottom:34px;right:92px;max-width:210px;background:#162235;color:#F4F7F5;
      padding:10px 34px 10px 14px;border-radius:12px;font-size:13px;line-height:1.4;
      border:1px solid rgba(77,196,160,0.18);box-shadow:0 8px 24px rgba(13,27,42,0.45);
      z-index:9997;opacity:0;transform:translateY(8px);pointer-events:none;
      transition:opacity .3s ease, transform .3s ease;cursor:pointer;}
    .zf-teaser.zf-show{opacity:1;transform:translateY(0);pointer-events:auto;}
    .zf-teaser.zf-blink{animation:zf-teaser-blink 0.7s ease-in-out 4;}
    @keyframes zf-teaser-blink{
      0%,100%{opacity:1;}
      50%{opacity:0.4;}
    }
    .zf-teaser-close{position:absolute;top:6px;right:8px;background:none;border:none;
      color:rgba(244,247,245,0.5);font-size:15px;cursor:pointer;line-height:1;padding:2px;}
    .zf-teaser-close:hover{color:#F4F7F5;}
    @media (max-width:480px){ .zf-teaser{display:none;} }
    .zf-chat-panel{position:fixed;bottom:94px;right:24px;width:340px;max-width:calc(100vw - 32px);
      height:460px;max-height:calc(100vh - 140px);background:#0D1B2A;border:1px solid rgba(77,196,160,0.18);
      border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,0.5);display:none;flex-direction:column;
      overflow:hidden;z-index:9999;font-family:'DM Sans',sans-serif;}
    .zf-chat-panel.zf-open{display:flex;}
    .zf-chat-header{background:#162235;padding:16px 18px;display:flex;align-items:center;justify-content:space-between;
      border-bottom:1px solid rgba(77,196,160,0.18);}
    .zf-chat-header-title{font-family:'DM Serif Display',serif;color:#F4F7F5;font-size:17px;}
    .zf-chat-header-sub{color:rgba(244,247,245,0.5);font-size:12px;margin-top:2px;}
    .zf-chat-close{background:none;border:none;color:rgba(244,247,245,0.5);font-size:20px;cursor:pointer;line-height:1;padding:4px;}
    .zf-chat-close:hover{color:#F4F7F5;}
    .zf-chat-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;}
    .zf-msg{max-width:85%;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.5;}
    .zf-msg-bot{background:#1e2f44;color:#F4F7F5;align-self:flex-start;border-bottom-left-radius:4px;}
    .zf-msg-user{background:#1B8A6B;color:#F4F7F5;align-self:flex-end;border-bottom-right-radius:4px;}
    .zf-msg-error{background:rgba(224,96,96,0.15);color:#F4F7F5;border:1px solid rgba(224,96,96,0.4);align-self:flex-start;}
    .zf-chat-input-row{display:flex;gap:8px;padding:12px;border-top:1px solid rgba(77,196,160,0.18);background:#162235;}
    .zf-chat-input{flex:1;background:#0D1B2A;border:1px solid rgba(77,196,160,0.18);border-radius:8px;
      color:#F4F7F5;padding:10px 12px;font-family:'DM Sans',sans-serif;font-size:14px;resize:none;outline:none;}
    .zf-chat-input:focus{border-color:#1B8A6B;}
    .zf-chat-send{background:#1B8A6B;border:none;border-radius:8px;width:40px;color:#F4F7F5;cursor:pointer;
      display:flex;align-items:center;justify-content:center;flex-shrink:0;}
    .zf-chat-send:hover{background:#4DC4A0;}
    .zf-chat-send:disabled{opacity:0.5;cursor:default;}
    .zf-typing{color:rgba(244,247,245,0.5);font-size:13px;padding:0 16px 8px;}
  `;
  var styleTag = document.createElement('style');
  styleTag.textContent = css;
  document.head.appendChild(styleTag);

  var bubble = document.createElement('button');
  bubble.className = 'zf-chat-bubble';
  bubble.setAttribute('aria-label', 'Open ZenFlo help chat');
  bubble.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#F4F7F5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>';

  var panel = document.createElement('div');
  panel.className = 'zf-chat-panel';
  panel.innerHTML =
    '<div class="zf-chat-header">' +
      '<div><div class="zf-chat-header-title">ZenFlo Help</div><div class="zf-chat-header-sub">Ask a quick question</div></div>' +
      '<button class="zf-chat-close" aria-label="Close chat">&times;</button>' +
    '</div>' +
    '<div class="zf-chat-messages" id="zf-messages"></div>' +
    '<div class="zf-typing" id="zf-typing" style="display:none;">ZenFlo is typing…</div>' +
    '<div class="zf-chat-input-row">' +
      '<textarea class="zf-chat-input" id="zf-input" rows="1" placeholder="Ask about features, pricing…" maxlength="800"></textarea>' +
      '<button class="zf-chat-send" id="zf-send" aria-label="Send">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#F4F7F5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>' +
      '</button>' +
    '</div>';

  var teaser = document.createElement('div');
  teaser.className = 'zf-teaser';
  teaser.innerHTML = 'Got a question? Ask me anything! 👋<button class="zf-teaser-close" aria-label="Dismiss">&times;</button>';

  document.body.appendChild(bubble);
  document.body.appendChild(panel);
  document.body.appendChild(teaser);

  var messagesEl = panel.querySelector('#zf-messages');
  var inputEl = panel.querySelector('#zf-input');
  var sendBtn = panel.querySelector('#zf-send');
  var typingEl = panel.querySelector('#zf-typing');
  var closeBtn = panel.querySelector('.zf-chat-close');
  var teaserCloseBtn = teaser.querySelector('.zf-teaser-close');
  var hasGreeted = false;

  function addMessage(text, kind) {
    var div = document.createElement('div');
    div.className = 'zf-msg zf-msg-' + kind;
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function openPanel() {
    panel.classList.add('zf-open');
    if (!hasGreeted) {
      addMessage("Hi! I'm the ZenFlo help bot. Ask me about features, pricing, or how to use anything in the app.", 'bot');
      hasGreeted = true;
    }
    inputEl.focus();
  }

  function hideTeaser() {
    teaser.classList.remove('zf-show');
    try { sessionStorage.setItem('zfTeaserSeen', '1'); } catch (e) {}
  }

  var teaserAlreadySeen = false;
  try { teaserAlreadySeen = sessionStorage.getItem('zfTeaserSeen') === '1'; } catch (e) {}

  if (!teaserAlreadySeen) {
    setTimeout(function () {
      if (!panel.classList.contains('zf-open')) {
        teaser.classList.add('zf-show');
        teaser.classList.add('zf-blink');
        setTimeout(function () { teaser.classList.remove('zf-blink'); }, 2800);
      }
    }, 1000);
    setTimeout(hideTeaser, 11000);
  }

  teaser.addEventListener('click', function (e) {
    if (e.target === teaserCloseBtn) { hideTeaser(); return; }
    hideTeaser();
    bubble.style.animationPlayState = 'paused';
    openPanel();
  });

  bubble.addEventListener('click', function () {
    hideTeaser();
    if (panel.classList.contains('zf-open')) {
      panel.classList.remove('zf-open');
      bubble.style.animationPlayState = 'running';
    } else {
      openPanel();
      bubble.style.animationPlayState = 'paused';
    }
  });
  closeBtn.addEventListener('click', function () {
    panel.classList.remove('zf-open');
    bubble.style.animationPlayState = 'running';
  });

  function send() {
    var text = inputEl.value.trim();
    if (!text) return;
    addMessage(text, 'user');
    inputEl.value = '';
    sendBtn.disabled = true;
    typingEl.style.display = 'block';
    messagesEl.scrollTop = messagesEl.scrollHeight;

    fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        typingEl.style.display = 'none';
        sendBtn.disabled = false;
        if (data.error) {
          addMessage(data.error, 'error');
        } else {
          addMessage(data.reply, 'bot');
        }
      })
      .catch(function () {
        typingEl.style.display = 'none';
        sendBtn.disabled = false;
        addMessage("Couldn't reach ZenFlo right now — try again shortly, or email hello@zenflo.co.uk", 'error');
      });
  }

  sendBtn.addEventListener('click', send);
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
})();
