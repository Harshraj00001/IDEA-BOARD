const STORAGE_KEY = 'idea-board-state-v1';
let state = { nodes: {}, selectedId: null };
let saveTimer = null;

function uid(){ return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

function scheduleSave(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch(e){ console.error('save failed', e); }
  }, 200);
}

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      if(parsed && parsed.nodes) state = parsed;
    }
  }catch(e){ /* no saved data yet, start fresh */ }
  migrateState();
  render();
}

/* ---------- Export / import to a real file ---------- */
function exportToFile(){
  const blob = new Blob([JSON.stringify(state, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0,10);
  a.href = url;
  a.download = `idea-board-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importFromFile(file){
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const parsed = JSON.parse(reader.result);
      if(!parsed || !parsed.nodes) throw new Error('not a valid board file');
      if(Object.keys(state.nodes).length > 0){
        if(!confirm('This replaces everything currently on the board with the file you picked. Continue?')) return;
      }
      state = parsed;
      migrateState();
      scheduleSave();
      render();
    }catch(e){
      alert('Could not read that file — is it an idea board JSON export?');
    }
  };
  reader.readAsText(file);
}

// Old boards stored a single parentId per node. Convert to a parentIds list
// so a box can be linked from more than one source.
function migrateState(){
  Object.values(state.nodes).forEach(n => {
    if(n.parentIds === undefined){
      n.parentIds = n.parentId ? [n.parentId] : [];
      delete n.parentId;
    }
  });
}

function parentsOf(id){ return state.nodes[id] ? state.nodes[id].parentIds : []; }
function childrenOf(id){ return Object.values(state.nodes).filter(n => n.parentIds.includes(id)); }

function createRoot(){
  const id = uid();
  state.nodes[id] = {
    id, type:'root', parentIds:[], title:'New idea collection',
    x: 60 + Math.random()*60, y: 60 + Math.random()*200,
    thumbnail:'', summary:'', link:''
  };
  state.selectedId = id;
  scheduleSave(); render();
}

function addChild(parentId){
  const parent = state.nodes[parentId];
  if(!parent) return;
  const id = uid();
  const siblings = childrenOf(parentId);
  state.nodes[id] = {
    id, type:'idea', parentIds:[parentId],
    title:'Untitled idea',
    x: parent.x + 230,
    y: parent.y + siblings.length * 120 - (siblings.length ? 20 : 0),
    thumbnail:'', summary:'', link:''
  };
  state.selectedId = id;
  scheduleSave(); render();
}

// Following DOWN from startId (through children), can we reach targetId?
// Used to stop a link from creating a loop.
function reachesDescendant(startId, targetId){
  const stack = [startId];
  const seen = new Set();
  while(stack.length){
    const cur = stack.pop();
    if(cur === targetId) return true;
    if(seen.has(cur)) continue;
    seen.add(cur);
    childrenOf(cur).forEach(c => stack.push(c.id));
  }
  return false;
}

function linkNodes(parentId, childId){
  if(parentId === childId) return { ok:false, reason:'A box can\'t link to itself.' };
  const child = state.nodes[childId];
  if(child.parentIds.includes(parentId)) return { ok:false, reason:'Those two are already linked.' };
  if(reachesDescendant(childId, parentId)) return { ok:false, reason:'That would create a loop.' };
  child.parentIds.push(parentId);
  scheduleSave(); render();
  return { ok:true };
}

function unlinkFromParent(childId, parentId){
  const child = state.nodes[childId];
  if(!child) return;
  child.parentIds = child.parentIds.filter(pid => pid !== parentId);
  scheduleSave(); render();
}

// Deleting a box only cascades to a child if that child has no other
// parent left once this box is gone — otherwise the child just loses this
// one link and stays on the board.
function getNodesToDelete(id){
  const toDelete = new Set([id]);
  let changed = true;
  while(changed){
    changed = false;
    Object.values(state.nodes).forEach(n => {
      if(toDelete.has(n.id)) return;
      if(n.parentIds.length === 0) return;
      const hadDeletedParent = n.parentIds.some(pid => toDelete.has(pid));
      const remainingParents = n.parentIds.filter(pid => !toDelete.has(pid));
      if(hadDeletedParent && remainingParents.length === 0){
        toDelete.add(n.id); changed = true;
      }
    });
  }
  return [...toDelete];
}

function deleteNode(id){
  const toDelete = getNodesToDelete(id);
  const msg = toDelete.length > 1
    ? `Delete this and ${toDelete.length - 1} idea(s) that would be left with no link?`
    : 'Delete this idea?';
  if(!confirm(msg)) return;
  toDelete.forEach(nid => delete state.nodes[nid]);
  Object.values(state.nodes).forEach(n => {
    n.parentIds = n.parentIds.filter(pid => !toDelete.includes(pid));
  });
  if(toDelete.includes(state.selectedId)) state.selectedId = null;
  scheduleSave(); render();
}

function selectNode(id){
  state.selectedId = id;
  render();
}

function updateNode(id, patch){
  if(!state.nodes[id]) return;
  Object.assign(state.nodes[id], patch);
  scheduleSave();
}

/* ---------- Link mode ---------- */
let linkMode = false;
let pendingLinkId = null;

function toggleLinkMode(){
  linkMode = !linkMode;
  pendingLinkId = null;
  document.getElementById('linkModeBtn').classList.toggle('active', linkMode);
  document.getElementById('linkHint').style.display = linkMode ? 'block' : 'none';
  render();
}

function handleLinkClick(id){
  if(!pendingLinkId){
    pendingLinkId = id;
    render();
    return;
  }
  if(pendingLinkId === id){ pendingLinkId = null; render(); return; }
  const result = linkNodes(pendingLinkId, id);
  if(!result.ok) alert(result.reason);
  pendingLinkId = null;
}

/* ---------- Rendering ---------- */

function render(){
  renderNodes();
  renderWires();
  renderTree();
  renderDetail();
}

function renderNodes(){
  const canvas = document.getElementById('canvas');
  canvas.querySelectorAll('.node, .empty-hint').forEach(el => el.remove());

  const nodes = Object.values(state.nodes);
  if(nodes.length === 0){
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = 'Nothing here yet. Click "+ New idea collection" above to start a red box, then branch green ideas off it.';
    canvas.appendChild(hint);
    return;
  }

  nodes.forEach(n => {
    const el = document.createElement('div');
    const hasChildren = childrenOf(n.id).length > 0;
    let cls = 'node ' + n.type;
    if(n.type === 'root' && hasChildren) cls += ' has-children';
    if(n.id === state.selectedId) cls += ' selected';
    if(linkMode && n.id === pendingLinkId) cls += ' link-pending';
    el.className = cls;
    el.style.left = n.x + 'px';
    el.style.top = n.y + 'px';

    let inner = '';
    if(n.type === 'idea' && n.thumbnail){
      inner += `<img class="thumb" src="${escapeAttr(n.thumbnail)}" onerror="this.style.display='none'">`;
    }
    inner += `<div class="title">${escapeHtml(n.title || 'Untitled')}</div>`;
    const linkCount = n.parentIds.length;
    let metaText;
    if(n.type === 'root') metaText = hasChildren ? 'idea collection' : 'click + to open';
    else metaText = linkCount > 1 ? `linked from ${linkCount} boxes` : (n.link ? 'has link' : 'no link yet');
    inner += `<div class="meta">${metaText}</div>`;
    inner += `<div class="btnrow">
      <span class="mini add-child">+ idea</span>
      <span class="mini del">delete</span>
    </div>`;
    el.innerHTML = inner;

    el.querySelector('.add-child').addEventListener('mousedown', e => e.stopPropagation());
    el.querySelector('.add-child').addEventListener('click', e => { e.stopPropagation(); addChild(n.id); });
    el.querySelector('.del').addEventListener('mousedown', e => e.stopPropagation());
    el.querySelector('.del').addEventListener('click', e => { e.stopPropagation(); deleteNode(n.id); });

    el.addEventListener('mousedown', e => startDrag(e, n.id));
    el.addEventListener('click', e => {
      if(dragMoved) return;
      if(linkMode) handleLinkClick(n.id);
      else selectNode(n.id);
    });
    el.addEventListener('mouseenter', e => showTooltip(n));
    el.addEventListener('mousemove', e => positionTooltip(e));
    el.addEventListener('mouseleave', () => hideTooltip());

    canvas.appendChild(el);
  });
}

function showTooltip(n){
  const tip = document.getElementById('nodeTooltip');
  tip.querySelector('.tt-title').textContent = n.title || 'Untitled';
  tip.querySelector('.tt-body').textContent = n.summary && n.summary.trim() ? n.summary : 'No summary yet.';
  tip.style.display = 'block';
}
function positionTooltip(e){
  const tip = document.getElementById('nodeTooltip');
  const offset = 16;
  let left = e.clientX + offset;
  let top = e.clientY + offset;
  const maxLeft = window.innerWidth - tip.offsetWidth - 10;
  const maxTop = window.innerHeight - tip.offsetHeight - 10;
  if(left > maxLeft) left = e.clientX - tip.offsetWidth - offset;
  if(top > maxTop) top = e.clientY - tip.offsetHeight - offset;
  tip.style.left = Math.max(10, left) + 'px';
  tip.style.top = Math.max(10, top) + 'px';
}
function hideTooltip(){
  document.getElementById('nodeTooltip').style.display = 'none';
}

function renderWires(){
  const svg = document.getElementById('wires');
  const nodes = Object.values(state.nodes);
  let paths = '';
  nodes.forEach(n => {
    n.parentIds.forEach(pid => {
      const p = state.nodes[pid];
      if(!p) return;
      const x1 = p.x + 172, y1 = p.y + 40;
      const x2 = n.x, y2 = n.y + 40;
      const midX = (x1 + x2) / 2;
      paths += `<path d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" fill="none" stroke="#8fd3e8" stroke-width="1.5" opacity="0.55"/>`;
    });
  });
  svg.innerHTML = paths;
}

function renderTree(){
  const list = document.getElementById('treeList');
  const nodes = Object.values(state.nodes);
  if(nodes.length === 0){
    list.innerHTML = '<div class="tree-empty">No ideas yet.</div>';
    return;
  }
  const tops = nodes.filter(n => n.parentIds.length === 0);
  let html = '';
  const renderNode = (n, depth, pathSeen) => {
    html += `<div class="tree-item ${n.id === state.selectedId ? 'selected' : ''}" style="padding-left:${16 + depth*14}px" data-id="${n.id}">
      <span class="dot ${n.type}"></span><span class="lbl">${escapeHtml(n.title || 'Untitled')}</span>
    </div>`;
    if(pathSeen.has(n.id)) return; // guard against loops
    const nextSeen = new Set(pathSeen); nextSeen.add(n.id);
    childrenOf(n.id).forEach(c => renderNode(c, depth+1, nextSeen));
  };
  tops.forEach(r => renderNode(r, 0, new Set()));
  list.innerHTML = html;
  list.querySelectorAll('.tree-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = item.dataset.id;
      selectNode(id);
      const n = state.nodes[id];
      const wrap = document.getElementById('canvasWrap');
      wrap.scrollTo({ left: Math.max(0, n.x - 300), top: Math.max(0, n.y - 200), behavior:'smooth' });
    });
  });
}

function renderDetail(){
  const panel = document.getElementById('detailPanel');
  const n = state.selectedId ? state.nodes[state.selectedId] : null;
  if(!n){
    panel.className = 'empty';
    panel.textContent = 'Click a box to see and edit its details here.';
    return;
  }
  panel.className = '';
  const parentTags = n.parentIds.map(pid => {
    const p = state.nodes[pid];
    if(!p) return '';
    return `<span class="parent-tag">${escapeHtml(p.title || 'Untitled')}<span class="unlink" data-pid="${pid}" title="Remove this link">&times;</span></span>`;
  }).join('');

  panel.innerHTML = `
    <div class="field-label">Title</div>
    <input type="text" id="f-title" value="${escapeAttr(n.title)}">

    <div class="field-label">Linked from</div>
    <div class="parent-tags">${parentTags || '<span class="tree-empty" style="padding:0;">Nothing yet — use "Link boxes" to connect it.</span>'}</div>

    <div class="field-label">Thumbnail image URL (optional)</div>
    <input type="text" id="f-thumb" value="${escapeAttr(n.thumbnail || '')}" placeholder="https://...">
    ${n.thumbnail ? `<img class="thumb-preview" src="${escapeAttr(n.thumbnail)}" onerror="this.style.display='none'">` : ''}

    <div class="field-label">Summary</div>
    <textarea id="f-summary" placeholder="A short note about this idea...">${escapeHtml(n.summary || '')}</textarea>

    <div class="field-label">Link to full page / file / site</div>
    <input type="text" id="f-link" value="${escapeAttr(n.link || '')}" placeholder="https://...">
    ${n.link ? `<a class="open-link" href="${escapeAttr(n.link)}" target="_blank" rel="noopener">${escapeHtml(n.link)}</a>` : ''}

    <div class="del-node-row">
      <button class="danger-btn" id="f-delete">Delete this idea</button>
    </div>
  `;
  document.getElementById('f-title').addEventListener('input', e => { updateNode(n.id, {title:e.target.value}); renderNodes(); renderTree(); });
  document.getElementById('f-thumb').addEventListener('change', e => { updateNode(n.id, {thumbnail:e.target.value}); render(); });
  document.getElementById('f-summary').addEventListener('input', e => updateNode(n.id, {summary:e.target.value}));
  document.getElementById('f-link').addEventListener('change', e => { updateNode(n.id, {link:e.target.value}); render(); });
  document.getElementById('f-delete').addEventListener('click', () => deleteNode(n.id));
  panel.querySelectorAll('.unlink').forEach(x => {
    x.addEventListener('click', () => unlinkFromParent(n.id, x.dataset.pid));
  });
}

function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s){ return escapeHtml(s); }

/* ---------- Dragging ---------- */
let dragId = null, dragOffsetX = 0, dragOffsetY = 0, dragMoved = false;

function startDrag(e, id){
  if(e.target.classList.contains('mini')) return;
  dragId = id; dragMoved = false;
  hideTooltip();
  const n = state.nodes[id];
  const wrap = document.getElementById('canvasWrap');
  const rect = wrap.getBoundingClientRect();
  dragOffsetX = e.clientX + wrap.scrollLeft - rect.left - n.x;
  dragOffsetY = e.clientY + wrap.scrollTop - rect.top - n.y;
  document.addEventListener('mousemove', onDrag);
  document.addEventListener('mouseup', endDrag);
}
function onDrag(e){
  if(!dragId) return;
  dragMoved = true;
  const wrap = document.getElementById('canvasWrap');
  const rect = wrap.getBoundingClientRect();
  const x = Math.max(0, e.clientX + wrap.scrollLeft - rect.left - dragOffsetX);
  const y = Math.max(0, e.clientY + wrap.scrollTop - rect.top - dragOffsetY);
  state.nodes[dragId].x = x;
  state.nodes[dragId].y = y;
  renderNodes(); renderWires();
}
function endDrag(){
  if(dragId) scheduleSave();
  dragId = null;
  document.removeEventListener('mousemove', onDrag);
  document.removeEventListener('mouseup', endDrag);
  setTimeout(() => dragMoved = false, 50);
}

/* ---------- Toolbar ---------- */
document.getElementById('newRootBtn').addEventListener('click', createRoot);
document.getElementById('toggleTree').addEventListener('click', () => {
  document.getElementById('treePanel').classList.toggle('hidden');
});
document.getElementById('linkModeBtn').addEventListener('click', toggleLinkMode);
document.getElementById('exportBtn').addEventListener('click', exportToFile);
document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importInput').click());
document.getElementById('importInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if(file) importFromFile(file);
  e.target.value = '';
});

document.getElementById('howToBtn').addEventListener('click', () => {
  document.getElementById('howToOverlay').classList.add('open');
});
document.getElementById('howToClose').addEventListener('click', () => {
  document.getElementById('howToOverlay').classList.remove('open');
});
document.getElementById('howToOverlay').addEventListener('click', e => {
  if(e.target.id === 'howToOverlay') document.getElementById('howToOverlay').classList.remove('open');
});
document.addEventListener('keydown', e => {
  if(e.key === 'Escape'){
    document.getElementById('howToOverlay').classList.remove('open');
    document.getElementById('themeOverlay').classList.remove('open');
  }
});

/* ---------- Theme picker ---------- */
const THEME_KEY = 'idea-board-theme';
const BG_KEY = 'idea-board-custom-bg';

function applyTheme(theme){
  if(theme && theme !== 'blueprint') document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
  document.querySelectorAll('.theme-swatch').forEach(sw => {
    sw.classList.toggle('active', sw.dataset.theme === (theme || 'blueprint'));
  });
  try { localStorage.setItem(THEME_KEY, theme || 'blueprint'); } catch(e){}
}

function applyCustomBg(dataUrl){
  const wrap = document.getElementById('canvasWrap');
  if(dataUrl){
    wrap.style.backgroundImage = `linear-gradient(rgba(5,13,23,0.35), rgba(5,13,23,0.35)), url(${dataUrl})`;
    wrap.classList.add('has-custom-bg');
  } else {
    wrap.style.backgroundImage = '';
    wrap.classList.remove('has-custom-bg');
  }
}

function loadAppearance(){
  let theme = 'blueprint';
  try { theme = localStorage.getItem(THEME_KEY) || 'blueprint'; } catch(e){}
  applyTheme(theme);
  try {
    const bg = localStorage.getItem(BG_KEY);
    if(bg) applyCustomBg(bg);
  } catch(e){}
}

document.getElementById('themeBtn').addEventListener('click', () => {
  document.getElementById('themeOverlay').classList.add('open');
});
document.getElementById('themeClose').addEventListener('click', () => {
  document.getElementById('themeOverlay').classList.remove('open');
});
document.getElementById('themeOverlay').addEventListener('click', e => {
  if(e.target.id === 'themeOverlay') document.getElementById('themeOverlay').classList.remove('open');
});
document.querySelectorAll('.theme-swatch').forEach(sw => {
  sw.addEventListener('click', () => applyTheme(sw.dataset.theme));
});
document.getElementById('customBgBtn').addEventListener('click', () => {
  document.getElementById('customBgInput').click();
});
document.getElementById('customBgInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try{
      localStorage.setItem(BG_KEY, reader.result);
      applyCustomBg(reader.result);
    }catch(err){
      alert('That image is too large to save in the browser. Try a smaller file.');
    }
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});
document.getElementById('customBgClear').addEventListener('click', () => {
  try { localStorage.removeItem(BG_KEY); } catch(e){}
  applyCustomBg(null);
});

/* ---------- Music panel ---------- */
document.getElementById('musicBtn').addEventListener('click', () => {
  document.getElementById('musicPanel').classList.add('open');
});
document.getElementById('musicClose').addEventListener('click', () => {
  document.getElementById('musicPanel').classList.remove('open');
});

document.getElementById('audioUploadBtn').addEventListener('click', () => {
  document.getElementById('audioUploadInput').click();
});
document.getElementById('audioUploadInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if(!file) return;
  const url = URL.createObjectURL(file);
  const player = document.getElementById('audioPlayer');
  player.src = url;
  player.style.display = 'block';
});

/* YouTube background playback via the IFrame Player API */
let ytPlayer = null;
let ytApiReady = false;
let pendingVideoId = null;
const YT_KEY = 'idea-board-yt-url';

function extractYouTubeId(url){
  const m = url.match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function loadYouTubeApi(){
  if(document.getElementById('yt-iframe-api')) return;
  const tag = document.createElement('script');
  tag.id = 'yt-iframe-api';
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}
window.onYouTubeIframeAPIReady = function(){
  ytApiReady = true;
  if(pendingVideoId) createYtPlayer(pendingVideoId);
};

function createYtPlayer(videoId){
  document.getElementById('ytPlayerWrap').innerHTML = '<div id="ytPlayerTarget"></div>';
  ytPlayer = new YT.Player('ytPlayerTarget', {
    height: '113', width: '252', videoId,
    playerVars: { origin: window.location.origin }
  });
  document.getElementById('ytControls').style.display = 'flex';
}

document.getElementById('ytLoadBtn').addEventListener('click', () => {
  const url = document.getElementById('ytUrlInput').value.trim();
  const id = extractYouTubeId(url);
  if(!id){ alert('That doesn\'t look like a valid YouTube link.'); return; }
  try { localStorage.setItem(YT_KEY, url); } catch(e){}
  if(ytApiReady) createYtPlayer(id);
  else { pendingVideoId = id; loadYouTubeApi(); }
});
document.getElementById('ytPlayBtn').addEventListener('click', () => { if(ytPlayer) ytPlayer.playVideo(); });
document.getElementById('ytPauseBtn').addEventListener('click', () => { if(ytPlayer) ytPlayer.pauseVideo(); });

function loadSavedYtUrl(){
  try {
    const saved = localStorage.getItem(YT_KEY);
    if(saved) document.getElementById('ytUrlInput').value = saved;
  } catch(e){}
}

loadAppearance();
loadSavedYtUrl();
loadState();
