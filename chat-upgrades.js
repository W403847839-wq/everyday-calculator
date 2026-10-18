/* Chat reliability and privacy. Login credentials remain memory-only. */
(() => {
  const style = document.createElement("style");
  style.textContent = `.connection-bar{display:flex;gap:10px;align-items:center;padding:8px 12px;margin:8px 0;border-radius:12px;background:#edf5ef;color:#4d735c;font-size:12px}.connection-bar.warn{background:#fff1dc;color:#886123}.connection-bar.error{background:#f8e6e8;color:#a24c5a}.connection-bar span{flex:1}.connection-bar button,.local-retry{border:0;border-radius:8px;padding:6px 10px;background:#fff9;color:inherit}.local-state{max-width:100%;font-size:11px;color:#937b80}.local-state.failed{color:#aa4356}.local-state button{margin-left:8px}.local-message .bubble{opacity:.85}.privacy-shield{position:fixed;inset:0;z-index:2147483646;display:grid;place-content:center;gap:20px;text-align:center;background:#f4f7fb;color:#263851}.privacy-shield[hidden]{display:none}.privacy-shield button{padding:12px 20px;border:0;border-radius:12px;color:#fff;background:#1769d2}.photo-controls{flex-wrap:wrap;gap:7px;padding:0 8px}.photo-controls button{padding:9px 12px}.photo-save-hint{position:absolute;top:calc(env(safe-area-inset-top,0px) + 60px);left:12px;right:12px;text-align:center;font-size:12px;color:#ddd;pointer-events:none}.outbox-error{margin:4px 8px;font-size:11px;color:#a24c5a}.draft-hint{font-size:10px;color:#967f83;margin:4px 6px}.msg-meta .delivery-state{font-size:9px;color:#a18b90}`;
  document.head.append(style);
  const connection = document.createElement("div");
  connection.className = "connection-bar";
  connection.setAttribute("role", "status");
  const connectionText = document.createElement("span"), reconnect = document.createElement("button");
  reconnect.type = "button"; reconnect.textContent = "重新连接";
  connection.append(connectionText, reconnect);
  presenceStrip.before(connection);
  const quick = document.createElement("button");
  quick.type = "button"; quick.className = "lock"; quick.textContent = "计算器";
  document.querySelector(".room-head-actions").prepend(quick);
  const shield = document.createElement("div");
  shield.className = "privacy-shield"; shield.hidden = true;
  shield.innerHTML = '<p>计算器已暂停</p><button type="button" data-resume>继续使用</button><button type="button" data-calculator>返回计算器</button>';
  document.body.append(shield);
  const draftHint = document.createElement("p");
  draftHint.className = "draft-hint"; draftHint.textContent = "输入内容会自动保存到本机草稿";
  messageBody.after(draftHint);

  let owner = null, draftReady = false, suppressDraft = false, outbox = [], remote = [];
  let dbPromise, writeChain = Promise.resolve(), sendRunning = false, pollRunning = false;
  let reconnectTimer = null, reconnectAttempt = 0, firstLoad = true, gallery = [], galleryIndex = 0;
  let imageGeneration = 0;
  const localUrls = new Map();
  const deferredUrls = new Set();
  photoViewer.addEventListener("close", () => { for (const url of deferredUrls) URL.revokeObjectURL(url); deferredUrls.clear(); });
  photoStage.style.bottom = "calc(130px + env(safe-area-inset-bottom, 0px))";
  const uuid = () => crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const n = crypto.getRandomValues(new Uint8Array(1))[0] & 15; return (c === "x" ? n : (n & 3) | 8).toString(16); });
  const atBottom = () => messages.scrollHeight - messages.scrollTop - messages.clientHeight < 85;
  const memberStill = id => token && currentMember?.id === id;
  let clearingBadge = false;
  function viewingLatest() {
    return token && !document.hidden && shield.hidden && !room.classList.contains("hidden") &&
      !document.querySelector("#messagePanel").classList.contains("hidden") && (followLatest || atBottom());
  }
  async function clearReadBadge() {
    if (!viewingLatest() || clearingBadge) return;
    clearingBadge = true;
    try {
      if (typeof navigator.clearAppBadge === "function") await navigator.clearAppBadge().catch(() => {});
      else if (typeof navigator.setAppBadge === "function") await navigator.setAppBadge(0).catch(() => {});
      if (navigator.serviceWorker) {
        const registration = serviceWorkerRegistration || await navigator.serviceWorker.getRegistration("./");
        const worker = registration?.active || navigator.serviceWorker.controller;
        worker?.postMessage({ type: "CHAT_MESSAGES_READ" });
        const notifications = await registration?.getNotifications?.().catch(() => []) || [];
        notifications.filter(item => ["calculator-update", "notification-check"].includes(item.tag)).forEach(item => item.close());
      }
    } catch { /* Unsupported badge APIs must not interrupt the chat. */ }
    finally { clearingBadge = false; }
  }
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener("controllerchange", clearReadBadge);
    navigator.serviceWorker.addEventListener("message", event => { if (event.data?.type === "CHAT_PUSH_RECEIVED" && token) loadMessages(); });
    navigator.serviceWorker.getRegistration("./").then(registration => registration?.update()).catch(() => {});
  }
  const originalJump = jumpLatest.onclick;
  jumpLatest.onclick = () => { originalJump(); clearReadBadge(); };

  function database() {
    return dbPromise ||= new Promise((resolve, reject) => {
      const request = indexedDB.open("calculator-chat-drafts", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("members");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function readState(id) {
    try { const db = await database(); return await new Promise((resolve, reject) => { const r = db.transaction("members").objectStore("members").get(id); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
    catch { try { return JSON.parse(localStorage.getItem("calculator-draft-" + id) || "null"); } catch { return null; } }
  }
  function persist() {
    if (!draftReady || suppressDraft || !owner || owner !== currentMember?.id) return writeChain;
    const id = owner, value = { draft: { body: messageBody.value, file: pendingImageFile, replyTo: replyingTo }, outbox: outbox.map(item => ({ ...item, running: false })) };
    writeChain = writeChain.catch(() => {}).then(async () => {
      try { const db = await database(); await new Promise((resolve, reject) => { const tx = db.transaction("members", "readwrite"); tx.objectStore("members").put(value, id); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); }); draftHint.textContent = "草稿已保存到本机"; }
      catch { try { localStorage.setItem("calculator-draft-" + id, JSON.stringify({ draft: { body: value.draft.body, replyTo: value.draft.replyTo }, outbox: value.outbox.filter(item => !item.file) })); } catch {} draftHint.textContent = "此浏览器无法保存照片草稿，请保持页面打开"; }
    });
    return writeChain;
  }
  function showDraftImage(file) {
    if (!file) return;
    pendingImageFile = file; pendingImageUrl = URL.createObjectURL(file);
    imagePreviewImg.src = pendingImageUrl; imagePreviewName.textContent = file.name || "未发送的照片";
    imagePreview.classList.remove("hidden");
  }
  async function restore(id) {
    owner = id; draftReady = false; firstLoad = true; remote = []; outbox = [];
    const state = await readState(id);
    if (!memberStill(id)) return;
    suppressDraft = true;
    if (!messageBody.value && !pendingImageFile) {
      messageBody.value = state?.draft?.body || ""; replyingTo = state?.draft?.replyTo || null;
      showDraftImage(state?.draft?.file);
      if (replyingTo) { replyPreviewText.textContent = `回复 ${replyingTo.author}：${replyingTo.preview}`; replyPreview.classList.remove("hidden"); }
    }
    outbox = (state?.outbox || []).filter(item => item.clientId).map(item => ({ ...item, running: false, status: item.status === "sent" ? "sent" : "failed", error: item.status === "sent" ? "" : "上次发送未完成，可点击重试" }));
    suppressDraft = false; draftReady = true; renderOutbox(); persist();
    await loadMessages(true);
  }
  const originalUnlock = unlock;
  unlock = async pin => { await originalUnlock(pin); if (token && currentMember && owner !== currentMember.id) await restore(currentMember.id); };
  const originalClearImage = clearPendingImage;
  clearPendingImage = () => { originalClearImage(); persist(); };
  beginReply = message => {
    replyingTo = { id: message.id, author: message.author, preview: (message.body || "[图片]").slice(0, 120) };
    replyPreviewText.textContent = `正在回复 ${replyingTo.author}：${replyingTo.preview}`;
    replyPreview.classList.remove("hidden");
    messageBody.focus({ preventScroll: true });
    keepComposerVisible();
    persist();
  };
  let quoteHighlightTimer;
  function revealOriginal(id) {
    const target = [...messages.querySelectorAll("[data-message-id]")].find(node => node.dataset.messageId === id);
    if (!target) { status.textContent = "原消息已删除或不在当前记录中"; return; }
    followLatest = false; scrollInteraction++; cancelAnimationFrame(scrollFrame);
    messages.querySelectorAll(".quote-highlight").forEach(node => node.classList.remove("quote-highlight"));
    messages.scrollTop += target.getBoundingClientRect().top - messages.getBoundingClientRect().top - 36;
    target.classList.add("quote-highlight");
    clearTimeout(quoteHighlightTimer);
    quoteHighlightTimer = setTimeout(() => target.classList.remove("quote-highlight"), 2200);
    updateUnread();
  }
  const originalImageChange = image.onchange;
  image.onchange = event => { originalImageChange(event); persist(); };
  const originalCancelReply = document.querySelector("#cancelReply").onclick;
  document.querySelector("#cancelReply").onclick = () => { originalCancelReply(); persist(); };
  document.querySelector("#removeImage").onclick = () => clearPendingImage();
  messageBody.addEventListener("input", persist);
  document.querySelectorAll("[data-emoji]").forEach(button => button.addEventListener("click", persist));
  const originalLogout = document.querySelector("#lock").onclick;
  function returnToCalculator() {
    persist(); suppressDraft = true;
    if (photoViewer.open) photoViewer.close();
    shield.hidden = true; originalLogout();
    messageBody.value = ""; owner = null; draftReady = false; outbox = []; remote = []; imageGeneration++;
    for (const url of localUrls.values()) URL.revokeObjectURL(url); localUrls.clear();
    suppressDraft = false; clearTimeout(reconnectTimer);
  }
  document.querySelector("#lock").onclick = returnToCalculator; quick.onclick = returnToCalculator;
  shield.querySelector("[data-calculator]").onclick = returnToCalculator;
  shield.querySelector("[data-resume]").onclick = () => { shield.hidden = true; loadMessages(); };
  function cover() { if (token) { persist(); if (photoViewer.open) photoViewer.close(); shield.hidden = false; } }
  document.addEventListener("visibilitychange", () => { if (document.hidden) cover(); else if (token) loadMessages(); });
  window.addEventListener("pagehide", cover);

  function connectionState(kind, copy) {
    connection.className = "connection-bar" + (kind === "ok" ? "" : kind === "offline" ? " warn" : " error");
    connectionText.textContent = copy; reconnect.hidden = kind === "ok";
    reconnect.textContent = kind === "login" ? "重新登录" : "重新连接";
    reconnect.onclick = kind === "login" ? returnToCalculator : reconnectNow;
    if (kind === "ok") { reconnectAttempt = 0; clearTimeout(reconnectTimer); }
  }
  function errorCopy(error) {
    if (!navigator.onLine) return "网络已断开，内容已保留，联网后继续发送";
    if (error.code === "login") return "登录已过期，请重新登录，内容已保留";
    if (error.code === "format") return "照片格式无法转换，请尝试发送截屏";
    if (error.code === "large") return "照片仍然过大，请缩小后重试";
    if (error.code === "upload_expired") return "照片上传已过期，点击重试即可重新上传";
    if (error.code === "storage") return "图片保存服务暂时不可用，已保留照片，可重试";
    if (error.code === "service") return "服务暂时不可用，内容已保留，稍后重试";
    if (error.name === "AbortError") return "连接超时，内容已保留，重试不会重复发送";
    return "网络连接中断，内容已保留，可点击重试";
  }
  function failure(error) {
    const kind = !navigator.onLine ? "offline" : error.code === "login" ? "login" : "service";
    connectionState(kind, errorCopy(error));
    if (kind !== "login" && token && !document.hidden) { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(reconnectNow, Math.min(30000, 3000 * 2 ** reconnectAttempt++)); }
  }
  async function api(path, data, sessionToken = token) {
    if (!navigator.onLine) throw Object.assign(new Error("offline"), { code: "offline" });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(API + path, { method: data === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${sessionToken}`, ...(data === undefined ? {} : { "Content-Type": "application/json" }) }, body: data === undefined ? undefined : JSON.stringify(data), signal: controller.signal, cache: "no-store" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) { const code = response.status === 401 ? "login" : response.status === 413 || result.error === "invalid image" ? "large" : result.error === "image_upload_failed" ? "storage" : result.error === "upload_expired" ? "upload_expired" : "service"; throw Object.assign(new Error(result.error || `HTTP ${response.status}`), { code }); }
      return result;
    } finally { clearTimeout(timer); }
  }
  async function reconnectNow() { if (!token) return; await loadMessages(); if (navigator.onLine) { outbox.filter(item => item.status === "queued").forEach(item => item.status = "pending"); runOutbox(); } }
  window.addEventListener("offline", () => connectionState("offline", "网络已断开，草稿和未发消息已保留"));
  window.addEventListener("online", reconnectNow);
  connectionState(navigator.onLine ? "ok" : "offline", navigator.onLine ? "连接正常" : "网络已断开，内容会保留");

  function photoForFile(file, id) { if (!localUrls.has(id)) localUrls.set(id, URL.createObjectURL(file)); return localUrls.get(id); }
  function buildMessage(message, local = false) {
    const article = document.createElement("article"); article.className = "msg " + (local || message.author === currentMember?.name ? "mine" : "theirs") + (local ? " local-message" : "");
    article.dataset.messageId = message.id || `${owner}-${message.clientId}`;
    const author = document.createElement("p"); author.className = "author"; author.textContent = message.author || currentMember?.name;
    const bubble = document.createElement("div"); bubble.className = "bubble";
    if (message.replyTo) {
      const quote = document.createElement("button"); quote.type = "button"; quote.className = "reply-quote";
      quote.setAttribute("aria-label", `查看 ${message.replyTo.author} 的原消息`);
      const name = document.createElement("strong"); name.textContent = `回复 ${message.replyTo.author}`;
      const preview = document.createElement("span"); preview.textContent = message.replyTo.preview || "[图片]";
      quote.append(name, preview); quote.onclick = () => revealOriginal(message.replyTo.id); bubble.append(quote);
    }
    if (message.imageKey || message.file) {
      const img = document.createElement("img"); img.alt = "留言中的图片"; img.setAttribute("role", "button"); img.tabIndex = 0; img.setAttribute("aria-label", "放大预览图片");
      bubble.style.width = "100%"; img.style.width = "100%"; img.style.aspectRatio = "4 / 3"; img.style.objectFit = "contain";
      bubble.append(img); if (message.file) img.src = photoForFile(message.file, message.clientId); else attachImage(img, message.imageKey);
    }
    if (message.body) { const p = document.createElement("p"); p.textContent = message.body; bubble.append(p); }
    const meta = document.createElement("div"); meta.className = "msg-meta";
    const stamp = document.createElement("time"); stamp.textContent = time(message.createdAt); meta.append(stamp);
    if (!local) {
      if (message.author === currentMember?.name) { const sent = document.createElement("span"); sent.className = "delivery-state"; sent.textContent = "已发送"; meta.append(sent); }
      const reply = document.createElement("button"); reply.type = "button"; reply.className = "reply-message"; reply.textContent = "引用回复"; reply.setAttribute("aria-label", `引用回复${message.author}的消息`); reply.onclick = () => beginReply(message);
      const del = document.createElement("button"); del.type = "button"; del.className = "delete-message"; del.textContent = "删除"; del.onclick = () => removeMessage(message.id, del); meta.append(reply, del);
    } else {
      const state = document.createElement("span"); state.className = "local-state" + (message.status === "failed" ? " failed" : "");
      state.textContent = ({ pending: "等待发送", sending: message.progress || "发送中…", queued: "等待网络", failed: "发送失败", sent: "已发送" })[message.status] || "等待发送";
      if (message.status === "failed") { const retry = document.createElement("button"); retry.type = "button"; retry.className = "local-retry"; retry.textContent = "重试"; retry.onclick = () => { message.status = "pending"; message.error = ""; persist(); renderOutbox(); runOutbox(); }; state.append(retry); }
      meta.append(state);
    }
    article.append(author, bubble, meta);
    if (local && message.error) { const error = document.createElement("div"); error.className = "outbox-error"; error.textContent = message.error; article.append(error); }
    return article;
  }
  function renderOutbox() {
    const pinned = followLatest && atBottom();
    messages.querySelectorAll(".local-message").forEach(node => node.remove());
    if (outbox.length) messages.querySelector(".empty")?.remove();
    outbox.forEach(item => messages.append(buildMessage(item, true)));
    if (pinned) scrollMessagesToBottom();
  }
  function anchor() { const top = messages.getBoundingClientRect().top, node = [...messages.querySelectorAll("[data-message-id]")].find(n => n.getBoundingClientRect().bottom > top); return { id: node?.dataset.messageId, offset: node ? node.getBoundingClientRect().top - top : 0, top: messages.scrollTop }; }
  function renderRemote(pinned) {
    const saved = anchor(), old = new Map([...messages.querySelectorAll(".msg:not(.local-message)")].map(n => [n.dataset.messageId, n])), fragment = document.createDocumentFragment();
    for (const message of remote) {
      if (!pinned && unreadStartId === message.id && sessionUnreadCount) { const divider = document.createElement("div"); divider.className = "new-divider"; divider.textContent = "以下是新消息"; fragment.append(divider); }
      const signature = JSON.stringify(message); let node = old.get(message.id);
      if (!node || node.dataset.signature !== signature) { node = buildMessage(message); node.dataset.signature = signature; }
      fragment.append(node);
    }
    messages.replaceChildren(fragment);
    if (!remote.length && !outbox.length) { const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "还没有消息，写下第一句吧"; messages.append(empty); }
    renderOutbox();
    if (pinned) scrollMessagesToBottom(); else { const node = [...messages.querySelectorAll("[data-message-id]")].find(n => n.dataset.messageId === saved.id); messages.scrollTop = node ? messages.scrollTop + node.getBoundingClientRect().top - messages.getBoundingClientRect().top - saved.offset : saved.top; }
  }
  function updateUnread() { messageTabCount.textContent = String(sessionUnreadCount); messageTabCount.classList.toggle("hidden", !sessionUnreadCount); jumpLatest.textContent = sessionUnreadCount ? `↓ ${sessionUnreadCount} 条新消息 · 回到最新` : "↓ 回到最新消息"; jumpLatest.classList.toggle("hidden", atBottom()); }
  loadMessages = async (forceBottom = false) => {
    if (!token || pollRunning || document.hidden || !shield.hidden) return;
    pollRunning = true; const id = currentMember.id, sessionToken = token, interaction = scrollInteraction;
    try {
      const result = await api("/api/messages", undefined, sessionToken); if (!memberStill(id) || sessionToken !== token) return;
      const pinned = followLatest || (forceBottom && interaction === scrollInteraction), next = result.messages || [], oldIds = new Set(remote.map(item => item.id));
      if (!pinned && !firstLoad) { const added = next.filter(item => !oldIds.has(item.id) && item.author !== currentMember.name); if (added.length) { unreadStartId ||= added[0].id; sessionUnreadCount += added.length; } }
      if (pinned) { unreadStartId = null; sessionUnreadCount = 0; }
      const nextIds = new Set(next.map(item => item.id));
      const removed = outbox.filter(item => nextIds.has(`${id}-${item.clientId}`) || (item.serverId && nextIds.has(item.serverId)));
      outbox = outbox.filter(item => !removed.includes(item));
      for (const item of removed) { const url = localUrls.get(item.clientId); if (url) { if (photoViewer.open) deferredUrls.add(url); else URL.revokeObjectURL(url); } localUrls.delete(item.clientId); }
      const changed = JSON.stringify(next) !== JSON.stringify(remote) || removed.length || firstLoad;
      remote = next; if (changed) renderRemote(pinned); else if (forceBottom && pinned) scrollMessagesToBottom();
      firstLoad = false; updateUnread(); connectionState("ok", "连接正常"); persist();
      if (pinned) clearReadBadge();
    } catch (error) { if (memberStill(id)) failure(error); }
    finally { pollRunning = false; }
  };
  messages.addEventListener("scroll", () => { if (atBottom()) { sessionUnreadCount = 0; unreadStartId = null; clearReadBadge(); } updateUnread(); });
  keepComposerVisible = () => {
    const viewport = window.visualViewport, height = viewport?.height || window.innerHeight, focused = composer.contains(document.activeElement);
    if (!focused) stableViewportHeight = Math.max(stableViewportHeight, height);
    const space = Math.max(0, stableViewportHeight - height), open = focused && space > 70;
    document.documentElement.style.setProperty("--visible-height", `${height}px`);
    document.documentElement.style.setProperty("--keyboard-space", `${space}px`);
    document.body.classList.toggle("keyboard-open", open);
    if (open) requestAnimationFrame(() => {
      const bottom = (viewport?.offsetTop || 0) + height - 10, bounds = composer.getBoundingClientRect();
      if (bounds.bottom > bottom) window.scrollBy({ top: bounds.bottom - bottom, behavior: "auto" });
      if (followLatest) scrollMessagesToBottom();
    });
  };
  time = value => new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));

  async function preparePhoto(file) {
    if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type) && file.size <= 500000) return { data: await fileBase64(file), type: file.type };
    const loaded = await loadImageFile(file);
    try {
      const source = loaded.img;
      for (const side of [1600, 1280, 1080, 900, 720, 560, 420]) {
        const scale = Math.min(1, side / Math.max(source.naturalWidth, source.naturalHeight)), canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(source.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
        const ctx = canvas.getContext("2d"); if (!ctx) throw Object.assign(new Error("conversion"), { code: "format" });
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        if (file.type === "image/png") { const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png")); if (png && png.size <= 500000) return { data: await fileBase64(png), type: "image/png" }; }
        for (const quality of [.86, .74, .62, .5, .36]) { const blob = await canvasBlob(canvas, quality); if (blob.size <= 500000) return { data: await fileBase64(blob), type: "image/jpeg" }; }
        canvas.width = canvas.height = 1;
      }
      throw Object.assign(new Error("large"), { code: "large" });
    } catch (error) { error.code ||= error.message === "large" ? "large" : "format"; throw error; }
    finally { URL.revokeObjectURL(loaded.url); }
  }
  async function upload(item, sessionToken, id) {
    const check = () => { if (!memberStill(id) || token !== sessionToken) throw Object.assign(new Error("session changed"), { code: "login" }); };
    if (item.imageToken && Date.now() < item.uploadExpires) return item.imageToken;
    item.imageToken = null;
    if (!item.prepared) { item.progress = "正在压缩照片…"; renderOutbox(); item.prepared = await preparePhoto(item.file); check(); persist(); }
    const prepared = item.prepared, size = prepared.data.length * 3 / 4 - (prepared.data.endsWith("==") ? 2 : prepared.data.endsWith("=") ? 1 : 0);
    if (!item.session || item.uploadExpires <= Date.now()) { item.session = await api("/api/images/start", { size, type: prepared.type }, sessionToken); item.done = []; item.uploadExpires = Date.now() + 3000000; }
    const count = Math.ceil(prepared.data.length / item.session.chunkChars), done = new Set(item.done || []); let next = 0;
    async function worker() {
      while (next < count) {
        const index = next++; if (done.has(index)) continue; check();
        const data = prepared.data.slice(index * item.session.chunkChars, (index + 1) * item.session.chunkChars);
        await api("/api/images/chunk", { ticket: item.session.ticket, index, data }, sessionToken); check();
        done.add(index); item.done = [...done]; item.progress = `照片上传 ${Math.round(done.size / count * 100)}%`; renderOutbox(); persist();
      }
    }
    const results = await Promise.allSettled(Array.from({ length: Math.min(3, count) }, worker));
    const failed = results.find(result => result.status === "rejected");
    if (failed) { if (failed.reason.code === "upload_expired") item.session = null; throw failed.reason; }
    item.progress = "照片正在保存…"; renderOutbox();
    const result = await api("/api/images/finish", { ticket: item.session.ticket }, sessionToken); check();
    item.imageToken = result.imageToken; persist(); return result.imageToken;
  }
  async function runOutbox() {
    if (sendRunning || !token || owner !== currentMember?.id) return;
    sendRunning = true; const id = owner, sessionToken = token;
    try {
      for (const item of outbox.filter(item => item.status === "pending" || item.status === "queued")) {
        if (!memberStill(id) || sessionToken !== token) break;
        if (!navigator.onLine) { item.status = "queued"; continue; }
        item.status = "sending"; item.error = ""; renderOutbox(); persist();
        try {
          const payload = { clientId: item.clientId, body: item.body, replyTo: item.replyTo };
          if (item.file) payload.imageToken = await upload(item, sessionToken, id);
          item.progress = "正在发送…"; renderOutbox();
          const result = await api("/api/messages", payload, sessionToken);
          item.serverId = result.id; item.status = "sent"; item.progress = "";
          if (memberStill(id)) { connectionState("ok", "连接正常"); await loadMessages(); }
        } catch (error) {
          item.status = !navigator.onLine ? "queued" : "failed"; item.error = errorCopy(error);
          if (error.code === "upload_expired") { item.session = null; item.imageToken = null; }
          if (memberStill(id)) failure(error);
        }
        if (memberStill(id)) { renderOutbox(); persist(); }
      }
    } finally { sendRunning = false; if (memberStill(id)) { renderOutbox(); persist(); } if (token && navigator.onLine && outbox.some(item => item.status === "pending")) queueMicrotask(runOutbox); }
  }
  submitMessage = async () => {
    if (!token || !draftReady) return;
    const body = messageBody.value.trim(), file = pendingImageFile;
    if (!body && !file) return;
    if (file && file.size > 35 * 1024 * 1024) { status.textContent = "照片超过35MB，请先缩小后发送"; return; }
    outbox.push({ clientId: uuid(), body, file, replyTo: replyingTo, createdAt: new Date().toISOString(), status: navigator.onLine ? "pending" : "queued" });
    suppressDraft = true; messageBody.value = ""; replyingTo = null; replyPreview.classList.add("hidden"); clearPendingImage(); status.textContent = ""; suppressDraft = false;
    followLatest = true; renderOutbox(); scrollMessagesToBottom(); await persist(); runOutbox();
  };

  const toolbar = document.querySelector(".photo-controls"), counter = document.createElement("span"), saveHint = document.createElement("div");
  counter.style.cssText = "font-size:12px;min-width:36px;text-align:center";
  saveHint.className = "photo-save-hint"; photoViewer.append(saveHint);
  function galleryButton(label, action, aria) { const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.setAttribute("aria-label", aria || label); button.onclick = action; return button; }
  const previous = galleryButton("‹", () => navigatePhoto(-1), "上一张照片"), nextPhoto = galleryButton("›", () => navigatePhoto(1), "下一张照片");
  toolbar.prepend(previous, counter); toolbar.append(nextPhoto, galleryButton("保存", savePhoto));
  function showGalleryPhoto() { fullPhoto.src = gallery[galleryIndex].src; photoScale = 1; photoX = photoY = 0; photoLastTap = 0; photoPointers.clear(); paintPhoto(); counter.textContent = `${galleryIndex + 1}/${gallery.length}`; previous.disabled = galleryIndex === 0; nextPhoto.disabled = galleryIndex === gallery.length - 1; saveHint.textContent = ""; }
  function navigatePhoto(delta) { const index = galleryIndex + delta; if (index >= 0 && index < gallery.length) { galleryIndex = index; showGalleryPhoto(); } }
  const originalOpenPhoto = openPhoto;
  openPhoto = img => { gallery = [...messages.querySelectorAll(".bubble img")].filter(node => node.getAttribute("src")).map(node => ({ src: node.src, node })); galleryIndex = gallery.findIndex(item => item.node === img); if (galleryIndex < 0) return; originalOpenPhoto(img); showGalleryPhoto(); };
  photoViewer.addEventListener("keydown", event => { if (event.key === "ArrowLeft") navigatePhoto(-1); if (event.key === "ArrowRight") navigatePhoto(1); });
  let swipeStart = null;
  photoStage.addEventListener("pointerdown", event => { swipeStart = photoPointers.size ? null : { x: event.clientX, y: event.clientY }; }, true);
  photoStage.addEventListener("pointerup", event => { if (swipeStart && !photoPinched && photoScale === 1 && Math.abs(event.clientX - swipeStart.x) > 70 && Math.abs(event.clientY - swipeStart.y) < 50) navigatePhoto(event.clientX < swipeStart.x ? 1 : -1); swipeStart = null; }, true);
  async function savePhoto() {
    try {
      const blob = await (await fetch(fullPhoto.src)).blob(), extension = blob.type === "image/png" ? "png" : blob.type === "image/gif" ? "gif" : "jpg", file = new File([blob], `照片-${Date.now()}.${extension}`, { type: blob.type || "image/jpeg" });
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); saveHint.textContent = "可在系统菜单中选择存储图像或存储到文件"; }
      else { const link = document.createElement("a"); link.href = fullPhoto.src; link.download = file.name; document.body.append(link); link.click(); link.remove(); saveHint.textContent = "请在浏览器下载或保存菜单中确认保存位置"; }
    } catch (error) { if (error.name !== "AbortError") saveHint.textContent = "当前浏览器未能保存，请尝试在系统浏览器中打开"; }
  }
})();
