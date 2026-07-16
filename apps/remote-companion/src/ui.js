export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#171715">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>Claude Open Companion</title>
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <main class="shell">
    <section id="pair-view" class="pair-card">
      <div class="mark" aria-hidden="true">C</div>
      <p class="eyebrow">CLAUDE OPEN</p>
      <h1>Pair your companion</h1>
      <p class="lede">Enter the temporary code shown in Claude Open Control Center. The code and your gateway key never appear in the URL.</p>
      <form id="pair-form">
        <label for="pair-code">Pairing code</label>
        <input id="pair-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000" required>
        <button class="primary" type="submit">Pair securely</button>
      </form>
      <p id="pair-error" class="error" role="alert"></p>
      <p class="trust">Connect only through localhost or a trusted private HTTPS tunnel.</p>
    </section>

    <section id="app-view" class="app" hidden>
      <header class="topbar">
        <div>
          <p class="eyebrow">REMOTE COMPANION</p>
          <h1>Claude Open</h1>
        </div>
        <div class="top-actions">
          <button id="install-app" class="icon-button" type="button" hidden>Install</button>
          <button id="new-chat" class="icon-button" type="button">New chat</button>
        </div>
      </header>

      <div class="status-strip">
        <span id="connection-dot" class="dot waiting"></span>
        <span id="connection-status">Connecting</span>
        <span id="usage" class="usage">Session usage unavailable</span>
      </div>

      <section class="controls" aria-label="Model controls">
        <label>Model<select id="model-select" aria-label="Model"></select></label>
        <label>Effort<select id="effort-select" aria-label="Reasoning effort"><option value="">Default</option></select></label>
      </section>

      <section id="messages" class="messages" aria-live="polite" aria-label="Conversation">
        <div id="empty-state" class="empty-state">
          <div class="orb"></div>
          <h2>Ready when you are</h2>
          <p>Messages travel through your PC and its configured gateway. This companion cannot access Cowork, SSH, or normal Claude.</p>
        </div>
      </section>

      <form id="composer" class="composer">
        <textarea id="prompt" rows="1" maxlength="100000" placeholder="Message your model" aria-label="Message" required></textarea>
        <button id="stop" class="stop" type="button" hidden>Stop</button>
        <button id="send" class="send" type="submit" aria-label="Send message">Send</button>
      </form>
    </section>
  </main>
  <script type="module" src="/app.js"></script>
</body>
</html>`;

export const APP_CSS = `:root{color-scheme:dark;--bg:#171715;--surface:#222220;--surface-2:#2b2a27;--line:#45423d;--text:#f4f1e8;--muted:#aaa69d;--clay:#d97757;--clay-2:#ef9b7e;--green:#7ac59b;--red:#e07a74;--shadow:0 24px 70px rgba(0,0,0,.35);font-family:Inter,"Segoe UI",system-ui,sans-serif}*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:radial-gradient(circle at 10% 0,#30251f 0,transparent 32rem),var(--bg);color:var(--text)}body{min-height:100dvh}.shell{width:min(920px,100%);min-height:100dvh;margin:auto}.pair-card{width:min(460px,calc(100% - 32px));margin:clamp(52px,13vh,130px) auto;padding:34px;border:1px solid var(--line);border-radius:28px;background:rgba(34,34,32,.94);box-shadow:var(--shadow)}.mark{display:grid;place-items:center;width:54px;height:54px;border-radius:16px;background:linear-gradient(135deg,var(--clay),#8055c9);font:800 28px Georgia,serif}.eyebrow{margin:22px 0 6px;color:var(--clay-2);font-size:11px;font-weight:800;letter-spacing:.16em}.pair-card h1,.topbar h1{margin:0;font:600 clamp(30px,7vw,42px) Georgia,serif}.lede,.trust{color:var(--muted);line-height:1.55}.trust{margin:22px 0 0;font-size:12px}label{display:grid;gap:8px;color:var(--muted);font-size:12px;font-weight:700}input,select,textarea{width:100%;border:1px solid var(--line);border-radius:14px;background:var(--surface-2);color:var(--text);font:inherit;outline:none}input:focus,select:focus,textarea:focus{border-color:var(--clay);box-shadow:0 0 0 3px rgba(217,119,87,.14)}#pair-code{height:62px;padding:0 18px;text-align:center;font-size:28px;font-weight:800;letter-spacing:.28em}.primary{width:100%;height:50px;margin-top:14px;border:0;border-radius:14px;background:var(--clay);color:white;font-weight:800}.error{min-height:20px;color:var(--red);font-size:13px}.app{min-height:100dvh;padding:0 20px 118px}.topbar{display:flex;align-items:end;justify-content:space-between;padding:calc(18px + env(safe-area-inset-top)) 2px 16px;border-bottom:1px solid var(--line)}.topbar .eyebrow{margin:0 0 3px}.topbar h1{font-size:27px}.top-actions{display:flex;gap:8px}.icon-button{height:36px;padding:0 13px;border:1px solid var(--line);border-radius:12px;background:transparent;color:var(--text);font-weight:700}.status-strip{display:flex;align-items:center;gap:8px;min-height:42px;color:var(--muted);font-size:12px}.dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 0 4px rgba(122,197,155,.1)}.dot.waiting{background:#d6ac62}.dot.offline{background:var(--red)}.usage{margin-left:auto;text-align:right}.controls{display:grid;grid-template-columns:minmax(0,2fr) minmax(110px,1fr);gap:10px;padding:12px 0 18px}.controls select{height:43px;padding:0 12px}.messages{display:flex;flex-direction:column;gap:16px;min-height:calc(100dvh - 300px);padding:12px 0 24px}.empty-state{margin:auto;text-align:center;color:var(--muted);max-width:430px}.empty-state h2{margin:18px 0 8px;color:var(--text);font:600 25px Georgia,serif}.empty-state p{line-height:1.55}.orb{width:62px;height:62px;margin:auto;border-radius:50%;background:radial-gradient(circle at 35% 30%,#ffc0a8,var(--clay) 35%,#633968 75%);box-shadow:0 14px 48px rgba(217,119,87,.22)}.message{max-width:min(82%,680px);padding:14px 16px;border-radius:19px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}.message.user{align-self:flex-end;background:var(--clay);color:#fff;border-bottom-right-radius:6px}.message.assistant{align-self:flex-start;background:var(--surface);border:1px solid var(--line);border-bottom-left-radius:6px}.message.error{align-self:flex-start;border:1px solid rgba(224,122,116,.45);background:rgba(224,122,116,.08);color:#ffd8d4}.cursor::after{content:"";display:inline-block;width:7px;height:15px;margin-left:4px;vertical-align:-2px;background:var(--clay-2);animation:blink 1s steps(2) infinite}@keyframes blink{50%{opacity:0}}.composer{position:fixed;z-index:5;left:50%;bottom:0;transform:translateX(-50%);display:flex;align-items:flex-end;gap:8px;width:min(920px,100%);padding:12px 20px calc(12px + env(safe-area-inset-bottom));background:linear-gradient(transparent,rgba(23,23,21,.96) 18%,var(--bg) 42%)}.composer textarea{min-height:52px;max-height:170px;resize:none;padding:15px 14px;line-height:1.4}.send,.stop{height:48px;padding:0 17px;border:0;border-radius:14px;color:white;font-weight:800}.send{background:var(--clay)}.stop{background:var(--surface-2);border:1px solid var(--line)}button{cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}@media(max-width:560px){.app{padding-left:14px;padding-right:14px}.topbar{align-items:center}.controls{grid-template-columns:1fr}.usage{max-width:48%}.message{max-width:91%}.composer{padding-left:12px;padding-right:12px}.pair-card{padding:26px}.icon-button{padding:0 10px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation:none!important}}`;

export const APP_JS = `const $=(s)=>document.querySelector(s);const pairView=$('#pair-view'),appView=$('#app-view'),pairForm=$('#pair-form'),pairError=$('#pair-error'),messages=$('#messages'),empty=$('#empty-state'),modelSelect=$('#model-select'),effortSelect=$('#effort-select'),composer=$('#composer'),prompt=$('#prompt'),send=$('#send'),stop=$('#stop'),newChat=$('#new-chat'),connectionStatus=$('#connection-status'),connectionDot=$('#connection-dot'),usage=$('#usage'),installButton=$('#install-app');let sessionId=sessionStorage.getItem('co-companion-session'),source=null,cursor=0,busy=false,deferredInstall=null,reconnectTimer=null,reconnectDelay=700;const bubbles=new Map();
async function api(path,opts={}){const response=await fetch(path,{credentials:'same-origin',headers:{'content-type':'application/json',...(opts.headers||{})},...opts});if(response.status===401){showPair();throw new Error('Pairing required')}const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'Request failed');return data}
function showPair(){if(source)source.close();if(reconnectTimer)clearTimeout(reconnectTimer);reconnectTimer=null;pairView.hidden=false;appView.hidden=true}
function showApp(){pairView.hidden=true;appView.hidden=false}
function connection(kind,text){connectionDot.className='dot '+kind;connectionStatus.textContent=text}
function clearConversation(){messages.querySelectorAll('.message').forEach((n)=>n.remove());bubbles.clear();cursor=0;empty.hidden=false}
function bubble(id,role,text){let node=bubbles.get(id);if(!node){node=document.createElement('article');node.className='message '+role;node.dataset.id=id;messages.appendChild(node);bubbles.set(id,node);empty.hidden=true}if(text!==undefined)node.textContent=text;return node}
function applyEvent(event){cursor=Math.max(cursor,event.id||0);const p=event.payload||{};if(event.type==='user')bubble(p.messageId,'user',p.text);if(event.type==='assistant-start'){bubble(p.messageId,'assistant','').classList.add('cursor');busy=true;syncBusy()}if(event.type==='assistant-delta'){const node=bubble(p.messageId,'assistant');node.textContent=(node.textContent||'')+(p.text||'');node.classList.add('cursor')}if(event.type==='assistant-done'||event.type==='cancelled'){const node=bubbles.get(p.messageId);if(node)node.classList.remove('cursor');busy=false;syncBusy()}if(event.type==='error'){const node=bubble(p.messageId||('error-'+event.id),'error',p.message||'The request failed.');node.classList.remove('cursor');busy=false;syncBusy()}messages.scrollTop=messages.scrollHeight;window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'})}
function syncBusy(){send.disabled=busy;modelSelect.disabled=busy;effortSelect.disabled=busy;newChat.disabled=busy;stop.hidden=!busy}
function connectEvents(){if(source)source.close();connection('waiting','Reconnecting');source=new EventSource('/api/sessions/'+encodeURIComponent(sessionId)+'/events?after='+cursor,{withCredentials:true});source.addEventListener('open',()=>{reconnectDelay=700;connection('','Connected')});source.addEventListener('companion',(e)=>{try{const event=JSON.parse(e.data);if(event.id>cursor+1)return scheduleReconnect(0);applyEvent(event)}catch{}});source.addEventListener('error',()=>{source.close();connection('offline',navigator.onLine?'Reconnecting':'Offline');scheduleReconnect()})}
function scheduleReconnect(delay=reconnectDelay){if(reconnectTimer||!navigator.onLine||!sessionId)return;reconnectTimer=setTimeout(async()=>{reconnectTimer=null;try{await resumeSession();reconnectDelay=700}catch{reconnectDelay=Math.min(reconnectDelay*2,30000);scheduleReconnect()}},delay)}
async function loadModels(){const result=await api('/api/models');modelSelect.replaceChildren();for(const model of result.data||[]){const option=document.createElement('option');option.value=model.id;option.textContent=model.display_name||model.id;option.dataset.efforts=JSON.stringify(model.effort_options||[]);modelSelect.appendChild(option)}refreshEfforts()}
function refreshEfforts(){effortSelect.replaceChildren(new Option('Default',''));const selected=modelSelect.selectedOptions[0];for(const effort of JSON.parse(selected?.dataset.efforts||'[]'))effortSelect.add(new Option(effort.name||effort.id,effort.id))}
async function resumeSession(){const snapshot=await api('/api/sessions/'+encodeURIComponent(sessionId));clearConversation();for(const event of snapshot.events||[])applyEvent(event);busy=Boolean(snapshot.busy);syncBusy();connectEvents()}
async function ensureSession(force=false){if(force||!sessionId){const result=await api('/api/sessions',{method:'POST',body:'{}'});sessionId=result.id;sessionStorage.setItem('co-companion-session',sessionId);clearConversation()}try{await resumeSession()}catch(e){if(!force){sessionId=null;return ensureSession(true)}throw e}}
async function refreshUsage(){try{const result=await api('/api/usage');const total=result.total||result.session||{};const input=total.input_tokens||total.inputTokens||0,output=total.output_tokens||total.outputTokens||0;usage.textContent=(input||output)?('Tokens '+input+' in / '+output+' out'):'Session usage ready'}catch{}}
async function boot(){showApp();connection('waiting','Connecting');await Promise.all([loadModels(),ensureSession()]);refreshUsage();setInterval(refreshUsage,15000)}
pairForm.addEventListener('submit',async(e)=>{e.preventDefault();pairError.textContent='';const code=$('#pair-code').value.replace(/\D/g,'');try{await api('/api/pair',{method:'POST',body:JSON.stringify({code})});$('#pair-code').value='';await boot()}catch(err){pairError.textContent=err.message}})
modelSelect.addEventListener('change',refreshEfforts);composer.addEventListener('submit',async(e)=>{e.preventDefault();const text=prompt.value.trim();if(!text||busy)return;prompt.value='';prompt.style.height='auto';try{await api('/api/sessions/'+encodeURIComponent(sessionId)+'/messages',{method:'POST',body:JSON.stringify({text,model:modelSelect.value,effort:effortSelect.value||null})});busy=true;syncBusy()}catch(err){bubble('local-error-'+Date.now(),'error',err.message)}});stop.addEventListener('click',async()=>{try{await api('/api/sessions/'+encodeURIComponent(sessionId)+'/cancel',{method:'POST',body:'{}'})}catch{}});newChat.addEventListener('click',()=>{if(!busy)ensureSession(true)});prompt.addEventListener('input',()=>{prompt.style.height='auto';prompt.style.height=Math.min(prompt.scrollHeight,170)+'px'});window.addEventListener('online',()=>{reconnectDelay=700;scheduleReconnect(250)});window.addEventListener('offline',()=>connection('offline','Offline'));window.addEventListener('beforeinstallprompt',(e)=>{e.preventDefault();deferredInstall=e;installButton.hidden=false});installButton.addEventListener('click',async()=>{if(deferredInstall){deferredInstall.prompt();await deferredInstall.userChoice;deferredInstall=null;installButton.hidden=true}});if('serviceWorker'in navigator)navigator.serviceWorker.register('/service-worker.js').catch(()=>{});api('/api/status').then((status)=>status.paired?boot():showPair()).catch(showPair);`;

export const MANIFEST = JSON.stringify({
  name: 'Claude Open Companion',
  short_name: 'Claude Open',
  description: 'Secure mobile companion for Claude Open',
  start_url: '/',
  display: 'standalone',
  background_color: '#171715',
  theme_color: '#171715',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
});

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#d97757"/><stop offset="1" stop-color="#7046a3"/></linearGradient></defs><rect width="512" height="512" rx="116" fill="#171715"/><rect x="62" y="62" width="388" height="388" rx="96" fill="url(#g)"/><path d="M 157 139 H 370 V 194 H 212 V 263 H 354 V 317 H 212 V 374 H 370 V 429 H 157 Z" fill="#fff"/></svg>`;

export const SERVICE_WORKER = `const CACHE='claude-open-companion-v1';const SHELL=['/','/app.css','/app.js','/manifest.webmanifest','/icon.svg'];self.addEventListener('install',(e)=>e.waitUntil(caches.open(CACHE).then((c)=>c.addAll(SHELL)).then(()=>self.skipWaiting())));self.addEventListener('activate',(e)=>e.waitUntil(caches.keys().then((ks)=>Promise.all(ks.filter((k)=>k!==CACHE).map((k)=>caches.delete(k)))).then(()=>self.clients.claim())));self.addEventListener('fetch',(e)=>{if(e.request.method!=='GET'||new URL(e.request.url).pathname.startsWith('/api/'))return;e.respondWith(fetch(e.request).then((r)=>{const copy=r.clone();caches.open(CACHE).then((c)=>c.put(e.request,copy));return r}).catch(()=>caches.match(e.request)))})`;
