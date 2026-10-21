// Pip site: talks to the server API. Plain JS, no build step.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var cfg = null;
  var state = null;
  var nextAt = null; // ms timestamp of the next lesson, counted down locally
  var lastLessonCount = null;
  var oldestLesson = null;
  var typingTimer = null;
  var lastSpeak = null;

  // ---------- helpers ----------
  function api(path, opts) {
    var ac = new AbortController();
    var t = setTimeout(function () { ac.abort(); }, 20000);
    opts = opts || {};
    opts.signal = ac.signal;
    return fetch('/api' + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, ok: r.ok, json: j || {} }; });
    }).finally(function () { clearTimeout(t); });
  }
  function getJson(path) {
    return api(path).then(function (r) { return r.ok ? r.json : null; }).catch(function () { return null; });
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function fmtInt(n) { return Number(n).toLocaleString('en-US'); }
  function fmtCompact(n) {
    n = Number(n);
    if (n < 100000) return fmtInt(n);
    if (n < 1e6) return Math.round(n / 1000) + 'K';
    if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, '') + 'M';
    return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  }
  function pct(x) { return Math.round(Math.max(0, Math.min(1, Number(x))) * 100); }
  function shortAddr(a) { return a ? a.slice(0, 6) + '...' + a.slice(-4) : ''; }
  function isZero(a) { return !a || /^0x0{40}$/i.test(a); }
  function explorer() { return (cfg && cfg.explorer ? cfg.explorer : '').replace(/\/+$/, ''); }
  function ticker() { return (cfg && cfg.ticker) || 'PIP'; }
  function ethShort(v) {
    var n = Number(v);
    if (!isFinite(n)) return null;
    if (n === 0) return '0';
    if (n >= 1) return n.toFixed(3);
    if (n >= 0.01) return n.toFixed(4);
    return n.toPrecision(2);
  }
  function ago(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1800);
  }
  function copyText(text) {
    var done = function () { toast('Copied'); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  // ---------- config ----------
  function applyConfig() {
    var t = ticker();
    document.querySelectorAll('[data-ticker]').forEach(function (n) { n.textContent = t; });

    // token
    var ca = cfg.tokenAddress;
    var buy = $('buyBtn'), navBuy = $('navBuy');
    $('copyCa').hidden = !ca;
    $('caText').parentNode.classList.toggle('na', !ca);
    if (ca) {
      $('caText').textContent = ca;
      $('copyCa').disabled = false;
      $('copyCa').onclick = function () { copyText(ca); };
    }
    if (ca && cfg.buyUrl) {
      buy.href = cfg.buyUrl; buy.target = '_blank'; buy.rel = 'noopener';
      buy.removeAttribute('aria-disabled');
      $('buyNote').textContent = 'Opens the $' + t + ' page on Pons.';
      navBuy.href = cfg.buyUrl; navBuy.target = '_blank'; navBuy.rel = 'noopener';
    } else {
      buy.removeAttribute('href');
      buy.setAttribute('aria-disabled', 'true');
      buy.addEventListener('click', function (e) { e.preventDefault(); });
      navBuy.href = '#token';
    }

    // brain
    var bl = $('brainLink');
    if (cfg.brainAddress) {
      bl.textContent = cfg.brainAddress;
      bl.href = explorer() + '/address/' + cfg.brainAddress;
      bl.target = '_blank'; bl.rel = 'noopener';
    }

    // github
    var gh = cfg.githubUrl;
    document.querySelectorAll('[data-gh]').forEach(function (a) {
      if (gh) { a.href = gh; a.target = '_blank'; a.rel = 'noopener'; }
      else { a.href = '#token'; a.classList.add('off'); a.title = 'Repo link coming at launch'; a.setAttribute('aria-label', 'Repo link coming at launch'); }
    });
    document.querySelectorAll('[data-gh-btn]').forEach(function (a) {
      if (gh) { a.href = gh; a.target = '_blank'; a.rel = 'noopener'; }
      else {
        a.removeAttribute('href');
        a.setAttribute('aria-disabled', 'true');
        a.querySelector('span').textContent = 'Repo link coming at launch';
      }
    });

    // x
    if (cfg.xUrl) { var x = $('xLink'); x.href = cfg.xUrl; x.target = '_blank'; x.rel = 'noopener'; x.hidden = false; }

    // teach form
    $('burnAmt').textContent = fmtInt(cfg.burnPerLesson);
    $('deadAddr').textContent = cfg.deadAddress;
    $('copyDead').onclick = function () { copyText(cfg.deadAddress); };
    $('teachMax').textContent = cfg.maxSentence;
    $('teachText').maxLength = cfg.maxSentence;
    if (!ca || !cfg.brainAddress) {
      ['txHash', 'teachText'].forEach(function (id) { $(id).disabled = true; });
      ['teachBtn', 'connectBtn', 'oldBtn', 'useOldBtn'].forEach(function (id) { $(id).disabled = true; });
      teachClosed = true;
      setMsg('', 'Teaching opens at launch. ' + (ca ? 'Pip has not hatched yet.' : 'Contract address not deployed yet.'));
    }
  }

  // ---------- speech ----------
  function setQuiet(title, small) {
    var box = $('saidBox');
    box.classList.add('quiet');
    $('saidPrompt').textContent = '';
    $('said').textContent = '';
    $('said').appendChild(document.createTextNode(title));
    if (small) $('said').appendChild(el('small', null, small));
  }
  function typeOut(prompt, text) {
    var box = $('saidBox');
    box.classList.remove('quiet');
    clearTimeout(typingTimer);
    $('saidPrompt').textContent = prompt || '';
    var s = $('said');
    s.textContent = '';
    var i = 0;
    (function go() {
      if (i <= text.length) { s.textContent = text.slice(0, i++); typingTimer = setTimeout(go, 34); }
    })();
  }
  function speak(seed) {
    if (!state || !state.deployed) return;
    var prompt = $('prompt').value.slice(0, 40);
    var q = '/speak?n=120&seed=' + seed + (prompt.trim() ? '&prompt=' + encodeURIComponent(prompt) : '');
    var btn = $('again');
    btn.classList.add('busy'); btn.disabled = true;
    api(q).then(function (r) {
      var j = r.json || {};
      if (!r.ok || typeof j.text !== 'string') {
        if (!lastSpeak) setQuiet('Pip is thinking.', 'Try again in a moment.');
        else toast(j.error || 'Pip could not talk right now.');
        return;
      }
      lastSpeak = { j: j, seed: seed, prompt: prompt };
      var cleanPrompt = prompt.toLowerCase();
      $('afterLesson').textContent = 'after lesson ' + fmtInt(j.lesson || 0);
      typeOut(cleanPrompt, j.text);
      renderVerify();
    }).catch(function () {
      if (!lastSpeak) setQuiet('Pip is thinking.', 'Try again in a moment.');
    }).finally(function () { btn.classList.remove('busy'); btn.disabled = false; });
  }
  function renderVerify() {
    var wrap = $('verifyWrap'), box = $('verifyBox');
    var j = lastSpeak && lastSpeak.j;
    if (!j || (j.seed == null && j.tempQ12 == null) || !cfg.brainAddress) { wrap.hidden = true; return; }
    wrap.hidden = false;
    box.textContent = '';
    box.appendChild(el('p', null, 'Pip\'s words come from its brain contract. Ask it yourself with these values from the speak function and you get the same sentence.'));
    var dl = el('dl');
    var rows = [
      ['prompt', j.prompt != null ? JSON.stringify(j.prompt) : JSON.stringify(lastSpeak.prompt.toLowerCase())],
      ['n', j.n != null ? j.n : 120],
      ['seed', j.seed != null ? j.seed : lastSpeak.seed],
    ];
    if (j.tempQ12 != null) rows.push(['tempQ12', j.tempQ12]);
    if (j.lesson != null) rows.push(['after lesson', j.lesson]);
    rows.forEach(function (r) { dl.appendChild(el('dt', null, r[0])); dl.appendChild(el('dd', null, String(r[1]))); });
    box.appendChild(dl);
    var p = el('p'); p.style.margin = '10px 0 0';
    var a = el('a', null, 'Open the brain contract');
    a.href = explorer() + '/address/' + cfg.brainAddress + '?tab=read_contract';
    a.target = '_blank'; a.rel = 'noopener';
    p.appendChild(a);
    box.appendChild(p);
  }
  $('verifyBtn').addEventListener('click', function () {
    var b = $('verifyBox'); b.hidden = !b.hidden;
    $('verifyBtn').textContent = b.hidden ? 'Check this on the contract' : 'Hide the details';
  });
  $('speakForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!state || !state.deployed) return;
    speak(Math.floor(Math.random() * 1e9));
  });

  // ---------- state ----------
  function renderState() {
    var s = state;
    if (!s || !s.deployed) {
      ['sLessons', 'sLevel', 'sLeft', 'sNext'].forEach(function (id) { $(id).textContent = '-'; });
      $('sMeter').style.width = '0%';
      $('sBal').textContent = s ? 'Opens at launch' : '';
      $('sQueue').textContent = '';
      nextAt = null;
      return;
    }
    $('sLessons').textContent = fmtInt(s.lessons || 0);
    if (s.level != null) {
      $('sLevel').innerHTML = '';
      $('sLevel').appendChild(document.createTextNode(pct(s.level)));
      $('sLevel').appendChild(el('small', null, '%'));
      $('sMeter').style.width = pct(s.level) + '%';
    } else { $('sLevel').textContent = '-'; }
    var left = $('sLeft');
    left.innerHTML = '';
    if (s.lessonsLeft != null) {
      left.appendChild(document.createTextNode(fmtCompact(s.lessonsLeft) + ' '));
      left.title = fmtInt(s.lessonsLeft) + ' lessons';
      left.appendChild(el('small', null, s.lessonsLeft === 1 ? 'lesson' : 'lessons'));
    } else left.textContent = '-';
    var bal = ethShort(s.brainBalanceEth);
    $('sBal').textContent = bal != null ? bal + ' ETH in the lunch box' : '';
    $('sQueue').textContent = s.queueLength ? fmtInt(s.queueLength) + ' holder ' + (s.queueLength === 1 ? 'sentence' : 'sentences') + ' waiting' : '';
    nextAt = s.nextLessonInSec != null ? Date.now() + s.nextLessonInSec * 1000 : null;
    tick();
  }
  function tick() {
    var n = $('sNext');
    if (!state || !state.deployed) return;
    if (state.teaching) { n.textContent = 'Now'; return; }
    if (state.lessonsLeft === 0) { n.textContent = 'Hungry'; return; }
    if (nextAt == null) { n.textContent = '-'; return; }
    var sec = Math.max(0, Math.round((nextAt - Date.now()) / 1000));
    if (sec === 0) { n.textContent = 'Soon'; return; }
    var m = Math.floor(sec / 60), r = sec % 60;
    n.textContent = m + ':' + String(r).padStart(2, '0');
  }
  setInterval(tick, 1000);

  function loadState() {
    return getJson('/state').then(function (s) {
      if (!s) return;
      var first = state == null;
      state = s;
      renderState();
      if (!s.deployed) {
        setQuiet('Pip has not hatched yet.', 'It goes live at launch. Come back to hear its first words.');
        $('afterLesson').textContent = '';
        $('prompt').disabled = true; $('again').disabled = true;
        return;
      }
      $('prompt').disabled = false; $('again').disabled = false;
      if (first) speak(Math.floor(Date.now() / 15000));
      if (lastLessonCount != null && s.lessons !== lastLessonCount) { loadLessons(true); loadTimeline(); }
      lastLessonCount = s.lessons;
    });
  }

  // ---------- growth ----------
  function stageLabel(item, i, all) {
    if (i === all.length - 1 && all.length > 1) return 'now';
    if (item.lesson === 0) return 'day one';
    var l = Number(item.level) || 0;
    if (l < 0.08) return 'still noise';
    if (l < 0.15) return 'first sounds';
    if (l < 0.25) return 'first words';
    if (l < 0.35) return 'short words';
    return 'making sense';
  }
  function loadTimeline() {
    return getJson('/timeline').then(function (r) {
      var box = $('growth');
      box.textContent = '';
      var items = r && Array.isArray(r.items) ? r.items.slice().sort(function (a, b) { return a.lesson - b.lesson; }) : [];
      if (!items.length) {
        box.appendChild(el('div', 'empty', state && state.deployed ? 'Pip\'s first words will show up here after its first lesson.' : 'Pip has not hatched yet. Its first words show up here at launch.'));
        return;
      }
      items.forEach(function (it, i) {
        var g = el('div', 'g' + (i === items.length - 1 && items.length > 1 ? ' now' : ''));
        var n = el('div', 'n', 'Lesson ' + fmtInt(it.lesson));
        n.appendChild(el('span', null, stageLabel(it, i, items)));
        g.appendChild(n);
        g.appendChild(el('div', 't', it.text || ''));
        g.appendChild(el('div', 'p', it.level != null ? pct(it.level) + '%' : '-'));
        box.appendChild(g);
      });
    });
  }

  // ---------- queue ----------
  function loadQueue() {
    return getJson('/queue').then(function (r) {
      var list = $('queue');
      list.textContent = '';
      var items = r && Array.isArray(r.items) ? r.items : [];
      $('qCount').textContent = items.length ? fmtInt(items.length) + ' waiting' : '';
      if (!items.length) {
        list.appendChild(el('li', 'none', state && state.deployed ? 'Nobody is waiting. Burn and teach, and Pip learns your sentence next.' : 'The class opens at launch.'));
        return;
      }
      items.slice(0, 12).forEach(function (q) {
        var li = el('li');
        li.appendChild(el('div', 'pos', '#' + q.position));
        var body = el('div');
        body.appendChild(el('div', 'qt', q.text));
        body.appendChild(el('div', 'qb', 'from ' + shortAddr(q.by) + (q.at ? ', ' + ago(q.at) : '')));
        li.appendChild(body);
        list.appendChild(li);
      });
    });
  }

  // ---------- lessons ----------
  function lessonRow(l) {
    var row = el('div', 'lr');
    row.appendChild(el('div', 'ln', '#' + fmtInt(l.n)));
    row.appendChild(el('div', 'lt', l.text || ''));
    var holder = l.source === 'holder' && !isZero(l.by);
    var by = el('div', 'lb' + (holder ? ' holder' : ''), holder ? 'by ' + shortAddr(l.by) : 'starter book');
    if (holder) by.title = l.by;
    row.appendChild(by);
    row.appendChild(el('div', 'lc', l.rightChance != null ? pct(l.rightChance) + '%' : '-'));
    var x = el('div', 'lx');
    if (l.txHash) {
      var a = el('a', null, 'View tx');
      a.href = explorer() + '/tx/' + l.txHash; a.target = '_blank'; a.rel = 'noopener';
      x.appendChild(a);
    }
    row.appendChild(x);
    return row;
  }
  function logHead() {
    var h = el('div', 'lr head');
    ['Lesson', 'What Pip read', 'Teacher', 'Right letters', ''].forEach(function (t, i) {
      var c = el('div', ['ln', 'lt', 'lb', 'lc', 'lx'][i], t);
      h.appendChild(c);
    });
    return h;
  }
  function loadLessons(reset) {
    var q = '/lessons?limit=30' + (!reset && oldestLesson != null ? '&before=' + oldestLesson : '');
    return getJson(q).then(function (r) {
      var log = $('log');
      var items = r && Array.isArray(r.items) ? r.items : null;
      if (items == null) { if (reset && !log.children.length) log.appendChild(el('div', 'empty', 'Lessons will show up here.')); return; }
      if (reset) { log.textContent = ''; oldestLesson = null; }
      if (reset && !items.length) {
        log.appendChild(el('div', 'empty', state && state.deployed ? 'No lessons yet. The first one is on its way.' : 'No lessons yet. Pip starts learning at launch.'));
        $('moreBtn').hidden = true;
        return;
      }
      if (reset) log.appendChild(logHead());
      items.forEach(function (l) { log.appendChild(lessonRow(l)); oldestLesson = oldestLesson == null ? l.n : Math.min(oldestLesson, l.n); });
      $('moreBtn').hidden = items.length < 30 || oldestLesson <= 1;
    });
  }
  $('moreBtn').addEventListener('click', function () { loadLessons(false); });

  // ---------- teach ----------
  function setMsg(kind, text) {
    var m = $('teachMsg');
    m.className = 'msg' + (kind ? ' ' + kind : '');
    m.textContent = text;
  }
  $('teachText').addEventListener('input', function () {
    var n = $('teachText').value.length;
    $('teachCount').textContent = n;
    $('teachCount').parentNode.classList.toggle('over', cfg && n > cfg.maxSentence);
  });
  // wallet + burn + sign. Signing proves the burn is yours, so nobody can reuse someone else's burn.
  var teachClosed = false;
  var account = null;
  var busy = false;
  var ERC20 = ['function transfer(address to, uint256 amount) returns (bool)', 'function decimals() view returns (uint8)'];

  function walletError(e) {
    var code = e && (e.code || (e.info && e.info.error && e.info.error.code));
    if (code === 4001 || code === 'ACTION_REJECTED') return 'You cancelled it in your wallet.';
    var m = String((e && (e.shortMessage || e.message)) || '');
    if (/insufficient funds/i.test(m)) return 'Your wallet does not have enough ETH on Robinhood Chain to pay for the burn.';
    if (/exceeds balance|transfer amount/i.test(m)) return 'Your wallet does not hold enough $' + ticker() + ' for this burn.';
    return 'Your wallet could not finish that. Try again.';
  }
  function showAccount() {
    $('walletAddr').textContent = account ? shortAddr(account) : 'Not connected';
    $('walletAddr').title = account || '';
    $('connectBtn').textContent = account ? 'Connected' : 'Connect wallet';
  }
  function ensureChain() {
    var eth = window.ethereum;
    var hex = '0x' + Number(cfg.chainId).toString(16);
    return eth.request({ method: 'eth_chainId' }).then(function (cur) {
      if (String(cur).toLowerCase() === hex) return;
      return eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }).catch(function (e) {
        var c = e && (e.code || (e.data && e.data.originalError && e.data.originalError.code));
        if (c !== 4902 && !/unrecognized|not been added|unknown chain/i.test(String(e && e.message))) throw e;
        return eth.request({ method: 'wallet_addEthereumChain', params: [{
          chainId: hex, chainName: 'Robinhood Chain',
          rpcUrls: [cfg.rpcUrl || 'https://rpc.mainnet.chain.robinhood.com'],
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          blockExplorerUrls: [explorer()],
        }] });
      });
    });
  }
  function connect() {
    if (!window.ethereum) return Promise.reject({ friendly: 'Open this page in your wallet\'s browser or install a wallet.' });
    return window.ethereum.request({ method: 'eth_requestAccounts' }).then(function (accs) {
      account = accs && accs[0] ? accs[0] : null;
      showAccount();
      if (!account) throw { friendly: 'No wallet account was shared. Try connecting again.' };
      return ensureChain().catch(function () { throw { friendly: 'Switch your wallet to Robinhood Chain and try again.' }; });
    }).then(function () { return account; });
  }
  if (window.ethereum && window.ethereum.on) {
    window.ethereum.on('accountsChanged', function (accs) { account = accs && accs[0] ? accs[0] : null; showAccount(); });
  }
  $('connectBtn').addEventListener('click', function () {
    if (teachClosed || busy) return;
    connect().then(function () { setMsg('', ''); }, function (e) { setMsg('err', e && e.friendly ? e.friendly : walletError(e)); });
  });
  $('useOldBtn').addEventListener('click', function () {
    var o = $('oldBurn'); o.hidden = !o.hidden;
    $('useOldBtn').textContent = o.hidden ? 'Already burned? Use an existing burn' : 'Hide the existing burn option';
  });

  function readSentence() {
    var text = $('teachText').value.trim();
    if (text.length < 8) { setMsg('err', 'Write a sentence of at least 8 letters and spaces.'); $('teachText').focus(); return null; }
    if (cfg && text.length > cfg.maxSentence) { setMsg('err', 'That sentence is too long. Keep it under ' + cfg.maxSentence + ' characters.'); $('teachText').focus(); return null; }
    return text;
  }
  function setBusy(on, btn, label) {
    busy = on;
    ['teachBtn', 'oldBtn', 'connectBtn', 'useOldBtn'].forEach(function (id) { $(id).disabled = on; });
    $('teachText').disabled = on; $('txHash').disabled = on;
    if (btn) { btn.classList.toggle('busy', on); btn.textContent = label; }
  }
  function signer() {
    return new window.ethers.BrowserProvider(window.ethereum).getSigner();
  }
  // Ask the server for the exact words to sign, sign them, then queue the sentence.
  function signAndSend(txHash, text) {
    return api('/teach/message?txHash=' + encodeURIComponent(txHash) + '&text=' + encodeURIComponent(text)).then(function (r) {
      if (!r.ok || !r.json.message) throw { friendly: r.json.error || 'Something went wrong. Try again in a minute.' };
      setMsg('', 'Sign to prove it\'s you.');
      return signer().then(function (s) { return s.signMessage(r.json.message); });
    }).then(function (signature) {
      setMsg('', 'Checking your burn...');
      return api('/teach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash: txHash, text: text, signature: signature }) });
    }).then(function (r) {
      var j = r.json || {};
      if (!j.ok) throw { friendly: j.error || 'Something went wrong. Try again in a minute.' };
      setMsg('ok', 'You\'re number ' + j.position + ' in line. Pip learns your sentence soon.');
      $('txHash').value = ''; $('teachText').value = ''; $('teachCount').textContent = '0';
      loadQueue(); loadState();
    });
  }
  function fail(e) {
    if (e && e.friendly) setMsg('err', e.friendly);
    else if (e && e.name === 'TypeError') setMsg('err', 'Could not reach Pip right now. Try again in a minute.');
    else setMsg('err', walletError(e));
  }
  function walletReady() {
    if (!window.ethers) return Promise.reject({ friendly: 'The wallet tools did not load. Refresh the page and try again.' });
    return connect();
  }

  $('teachForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!cfg || teachClosed || busy) return;
    var text = readSentence();
    if (!text) return;
    var btn = $('teachBtn');
    var burnHash = null;
    setBusy(true, btn, 'Working...');
    walletReady().then(function () {
      return signer();
    }).then(function (s) {
      var token = new window.ethers.Contract(cfg.tokenAddress, ERC20, s);
      return token.decimals().then(function (d) {
        var amount = window.ethers.parseUnits(String(cfg.burnPerLesson), Number(d));
        setMsg('', 'Confirm the burn in your wallet.');
        return token.transfer(cfg.deadAddress, amount);
      });
    }).then(function (tx) {
      burnHash = tx.hash;
      $('txHash').value = tx.hash; // kept so they can retry with "Use an existing burn"
      setMsg('', 'Waiting for the burn to land...');
      return tx.wait(1);
    }).then(function (rc) {
      if (!rc || Number(rc.status) !== 1) throw { friendly: 'The burn failed on-chain, so nothing was burned.' };
      return signAndSend(burnHash, text);
    }).catch(function (e) {
      fail(e);
      if (burnHash) {
        $('oldBurn').hidden = false;
        $('useOldBtn').textContent = 'Hide the existing burn option';
        $('teachMsg').textContent += ' Your burn went through, so use "Sign and teach" below to finish.';
      }
    }).finally(function () { setBusy(false, btn, 'Burn and teach'); });
  });

  $('oldBtn').addEventListener('click', function () {
    if (!cfg || teachClosed || busy) return;
    var txHash = $('txHash').value.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) { setMsg('err', 'Paste the hash of your burn. It starts with 0x and is 66 characters long.'); $('txHash').focus(); return; }
    var text = readSentence();
    if (!text) return;
    var btn = $('oldBtn');
    setBusy(true, btn, 'Working...');
    walletReady().then(function () { return signAndSend(txHash, text); })
      .catch(fail)
      .finally(function () { setBusy(false, btn, 'Sign and teach'); });
  });

  // ---------- eye ----------
  var pupil = $('pupil');
  addEventListener('mousemove', function (e) {
    var r = pupil.ownerSVGElement.getBoundingClientRect();
    var cx = r.left + r.width * 0.535, cy = r.top + r.height * 0.425;
    var a = Math.atan2(e.clientY - cy, e.clientX - cx);
    var d = Math.min(14, Math.hypot(e.clientX - cx, e.clientY - cy) / 10);
    pupil.style.transform = 'translate(' + (Math.cos(a) * d) + 'px,' + (Math.sin(a) * d) + 'px)';
  }, { passive: true });

  // ---------- boot ----------
  getJson('/config').then(function (c) {
    cfg = c || { tokenAddress: null, brainAddress: null, buyUrl: null, explorer: '', burnPerLesson: 0, deadAddress: '', maxSentence: 120, ticker: 'PIP' };
    applyConfig();
    return loadState();
  }).then(function () {
    if (!state) {
      setQuiet('Pip is resting.', 'Try again in a moment.');
      renderState();
    }
    loadTimeline(); loadQueue(); loadLessons(true);
  });
  setInterval(function () { loadState(); loadQueue(); }, 20000);
})();
