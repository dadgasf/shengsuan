(function () {
  'use strict';

  var E = window.SuanSearch;
  if (!E) {
    document.body.innerHTML = '<p style="padding:24px;font-family:sans-serif">搜索模块加载失败，请刷新页面。</p>';
    return;
  }

  // 第三方公开索引接口（与 maishou88 的公开客户端字段一致）。
  // 注意：这是第三方数据，不是淘宝/京东/拼多多的官方接口。
  var SEARCH_ENDPOINT = 'https://appapi.maishou88.com/api/v1/homepage/searchList';
  var SHARE_ENDPOINT = 'https://msapi.maishou88.com/api/v1/share/getTargetUrl';
  var OPENID = '564bdce0fa408fc9e1d5d42fd022ef0b';
  var INVITE_CODE = '6110440';
  var API_VERSION = '3.7.7.2';
  var SEARCH_CACHE_MS = 5 * 60 * 1000;

  var state = {
    keyword: '',
    all: [],
    summary: null,
    loading: false,
    error: '',
    platform: 'all',
    sort: 'price',
    couponOnly: false,
    rawCount: 0
  };
  var searchCache = new Map();
  var linkCache = new Map();
  var itemById = new Map();
  var toastTimer = null;
  var activeSheet = null;

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function escAttr(value) {
    return esc(value).replace(/`/g, '&#96;');
  }

  function money(value) {
    return (Math.max(0, Number(value) || 0)).toFixed(2);
  }

  function toast(message) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('show');
    }, 2800);
  }

  function platformMeta(platform) {
    return E.PLATFORMS[platform] || { name: platform, short: '?', id: platform };
  }

  function shortPlatformName(platform) {
    if (platform === 'taobao') return '淘宝';
    if (platform === 'jd') return '京东';
    if (platform === 'pdd') return '拼多多';
    return platform;
  }

  function safeImage(url) {
    if (!url) return '';
    try {
      var parsed = new URL(String(url), location.href);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
    } catch (error) {
      return '';
    }
    return '';
  }

  function safeHttpUrl(url) {
    if (!url) return '';
    try {
      var parsed = new URL(String(url), location.href);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
    } catch (error) {
      return '';
    }
    return '';
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------

  function searchBody(keyword) {
    return new URLSearchParams({
      isCoupon: '1',
      keyword: keyword,
      openid: OPENID,
      order: 'desc',
      page: '1',
      pddListId: '',
      sort: '',
      sourceType: '0',
      user_id: ''
    });
  }

  function apiSearch(keyword) {
    var key = keyword.toLowerCase();
    var cached = searchCache.get(key);
    if (cached && Date.now() - cached.at < SEARCH_CACHE_MS) {
      return Promise.resolve(cached.raw);
    }

    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, 15000);

    return fetch(SEARCH_ENDPOINT, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        openid: OPENID,
        version: API_VERSION
      },
      body: searchBody(keyword)
    })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (json) {
        if (!json || !Array.isArray(json.data)) {
          throw new Error((json && json.message) || '搜索接口返回异常');
        }
        searchCache.set(key, { at: Date.now(), raw: json.data });
        return json.data;
      })
      .finally(function () {
        clearTimeout(timer);
      });
  }

  function shareBody(item) {
    return JSON.stringify({
      goodsId: item.goodsId,
      sourceType: String(item.sourceType),
      inviteCode: INVITE_CODE,
      supplierCode: '',
      activityId: '',
      isShare: '1',
      token: '',
      isDirectDetail: 0
    });
  }

  function apiShareLink(item) {
    if (linkCache.has(item.id)) return Promise.resolve(linkCache.get(item.id));
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, 12000);

    return fetch(SHARE_ENDPOINT, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        openid: OPENID,
        version: API_VERSION
      },
      body: shareBody(item)
    })
      .then(function (response) {
        return response.json();
      })
      .then(function (json) {
        var data = (json && json.data) || {};
        var url = data.h5Url || data.appUrl || data.schemaUrl || '';
        url = safeHttpUrl(url);
        linkCache.set(item.id, url);
        return url;
      })
      .finally(function () {
        clearTimeout(timer);
      });
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  function setStatus(text, tone) {
    var note = $('#search-note');
    if (!note) return;
    note.className = 'search-note' + (tone ? ' ' + tone : '');
    note.innerHTML = text;
  }

  function renderStatus() {
    if (state.loading) {
      setStatus(
        '<span class="loading-dot"></span>正在搜索淘宝、京东、拼多多，通常需要 3–8 秒…',
        ''
      );
      return;
    }
    if (state.error) {
      setStatus('搜索服务暂时不可用。可以重试，或直接去平台官方搜索。', 'error');
      return;
    }
    if (!state.keyword) {
      setStatus('输入商品名开始。搜索的是公开索引价格，不是登录后的专属价。', '');
      return;
    }
    var counts = E.platformCounts(state.all);
    setStatus(
      '找到 <strong>' +
        state.all.length +
        '</strong> 个相关商品 · 淘宝 ' +
        counts.taobao +
        ' / 京东 ' +
        counts.jd +
        ' / 拼多多 ' +
        counts.pdd,
      ''
    );
  }

  function renderSummary() {
    var root = $('#summary');
    if (!root) return;
    if (!state.summary || !state.summary.winner) {
      root.hidden = true;
      root.innerHTML = '';
      return;
    }
    root.hidden = false;
    var s = state.summary;
    var counts = E.platformCounts(state.all);
    var tie = s.difference === 0 && s.second;
    var winner = s.winner;

    var tiles = E.PLATFORM_ORDER.map(function (platform) {
      var meta = platformMeta(platform);
      var item = s.platforms[platform];
      return (
        '<div class="compare-tile' +
        (item && item.id === winner.id ? ' winner' : '') +
        '">' +
        '<div class="compare-top"><span class="compare-name">' +
        esc(shortPlatformName(platform)) +
        '</span><span class="compare-tag">' +
        (item ? (item.id === winner.id ? '最低' : '参考') : '暂无') +
        '</span></div>' +
        '<div class="compare-price"><small>¥</small>' +
        (item ? money(item.price) : '—') +
        '</div>' +
        '<div class="compare-meta">' +
        (counts[platform] ? counts[platform] + ' 个相关结果' : '没有匹配结果') +
        '</div>' +
        '</div>'
      );
    }).join('');

    root.innerHTML =
      '<div class="summary-card">' +
      '<div class="summary-head"><span>三平台相关结果最低</span><span class="live-pill"><i></i>实时搜索</span></div>' +
      '<div class="summary-winner"><span class="platform-pill ' +
      winner.platform +
      '">' +
      esc(winner.platformName) +
      '</span><strong>¥' +
      money(winner.price) +
      '</strong><span class="summary-diff">' +
      (tie ? '与第二名持平' : s.second ? '比第二低 ¥' + money(s.difference) : '仅一个平台有结果') +
      '</span></div>' +
      '<div class="compare-grid">' +
      tiles +
      '</div>' +
      '<p class="summary-caveat">这里是“相关商品”的最低券后价，不等于严格同款同规格。下单前请核对型号、店铺和结算页。</p>' +
      '</div>';
  }

  function renderControls() {
    var root = $('#controls');
    if (!root) return;
    if (!state.all.length) {
      root.hidden = true;
      root.innerHTML = '';
      return;
    }
    root.hidden = false;
    var counts = E.platformCounts(state.all);
    var chips =
      '<button class="filter-chip' +
      (state.platform === 'all' ? ' is-active' : '') +
      '" type="button" data-platform="all">全部 <span>' +
      state.all.length +
      '</span></button>' +
      E.PLATFORM_ORDER.map(function (platform) {
        return (
          '<button class="filter-chip' +
          (state.platform === platform ? ' is-active' : '') +
          '" type="button" data-platform="' +
          platform +
          '">' +
          esc(platformMeta(platform).name) +
          ' <span>' +
          counts[platform] +
          '</span></button>'
        );
      }).join('');

    root.innerHTML =
      '<div class="controls-row">' +
      '<div class="filter-scroll">' +
      chips +
      '</div>' +
      '<div class="controls-right">' +
      '<select class="sort-select" id="sort-select" aria-label="排序方式">' +
      '<option value="price"' +
      (state.sort === 'price' ? ' selected' : '') +
      '>价格最低</option>' +
      '<option value="sales"' +
      (state.sort === 'sales' ? ' selected' : '') +
      '>销量优先</option>' +
      '<option value="relevance"' +
      (state.sort === 'relevance' ? ' selected' : '') +
      '>相关度</option>' +
      '</select>' +
      '<button class="coupon-toggle' +
      (state.couponOnly ? ' is-active' : '') +
      '" type="button" id="coupon-toggle" aria-pressed="' +
      (state.couponOnly ? 'true' : 'false') +
      '">只看有券</button>' +
      '</div>' +
      '</div>';
  }

  function bestBadge(item) {
    if (!state.summary) return '';
    if (state.summary.winner && item.id === state.summary.winner.id) {
      return '<span class="best-badge">全网最低</span>';
    }
    var platformBest = state.summary.platforms[item.platform];
    if (platformBest && platformBest.id === item.id) {
      return '<span class="best-badge platform">平台最低</span>';
    }
    return '';
  }

  function renderCard(item) {
    var meta = platformMeta(item.platform);
    var image = safeImage(item.image);
    var fallback = E.platformSearchUrl(item.platform, state.keyword || item.title);
    return (
      '<article class="product-card" data-id="' +
      escAttr(item.id) +
      '">' +
      '<div class="product-media">' +
      (image
        ? '<img src="' +
          escAttr(image) +
          '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">'
        : '') +
      '<span class="platform-symbol ' +
      item.platform +
      '">' +
      esc(meta.short) +
      '</span>' +
      '</div>' +
      '<div class="product-main">' +
      '<div class="product-top"><span class="platform-pill ' +
      item.platform +
      '">' +
      esc(item.platformName) +
      '</span>' +
      bestBadge(item) +
      '</div>' +
      '<h3 class="product-title">' +
      esc(item.title) +
      '</h3>' +
      '<div class="product-meta">' +
      (item.shop ? '<span>' + esc(item.shop) + '</span>' : '') +
      (item.salesText ? '<span>' + esc(item.salesText) + '</span>' : '') +
      '</div>' +
      '<div class="price-row"><strong>¥' +
      money(item.price) +
      '</strong>' +
      (item.original > item.price ? '<s>¥' + money(item.original) + '</s>' : '') +
      (item.hasCoupon ? '<span class="coupon-tag">券 ¥' + money(item.coupon) + '</span>' : '') +
      '</div>' +
      '<div class="product-actions">' +
      '<button class="btn btn-primary btn-sm" type="button" data-open="' +
      escAttr(item.id) +
      '">打开商品</button>' +
      '<a class="official-search" href="' +
      escAttr(fallback) +
      '" target="_blank" rel="noopener noreferrer">在' +
      esc(meta.name) +
      '搜同款</a>' +
      '</div>' +
      '</div>' +
      '</article>'
    );
  }

  function renderResults() {
    var root = $('#results');
    if (!root) return;

    if (state.loading) {
      root.innerHTML =
        '<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>';
      return;
    }

    if (state.error) {
      root.innerHTML =
        '<div class="state-card error-card"><div class="state-icon">!</div><h2>搜索没有成功</h2><p>' +
        esc(state.error) +
        '</p><p class="hint">第三方搜索服务可能被限流或暂时不可用。你也可以直接去平台搜索：</p><div class="official-links">' +
        E.PLATFORM_ORDER.map(function (platform) {
          return (
            '<a href="' +
            escAttr(E.platformSearchUrl(platform, state.keyword)) +
            '" target="_blank" rel="noopener noreferrer">' +
            esc(platformMeta(platform).name) +
            '</a>'
          );
        }).join('') +
        '</div><button class="btn btn-primary btn-sm" type="button" data-retry>重试</button></div>';
      return;
    }

    if (!state.keyword) {
      root.innerHTML =
        '<div class="intro-card">' +
        '<div class="intro-kicker">三平台一起搜</div>' +
        '<h2>输入商品名，自动找券后价</h2>' +
        '<p>省算会把淘宝、京东、拼多多的公开索引结果放在一起，按相关度和价格排序，并标出每个平台的最低参考价。</p>' +
        '<div class="platform-cards">' +
        E.PLATFORM_ORDER.map(function (platform) {
          var meta = platformMeta(platform);
          return (
            '<div class="platform-card ' +
            platform +
            '"><span class="platform-symbol">' +
            esc(meta.short) +
            '</span><strong>' +
            esc(meta.name) +
            '</strong><small>自动搜索</small></div>'
          );
        }).join('') +
        '</div>' +
        '<div class="intro-examples">试试：<button type="button" data-example="iPhone 17 256G">iPhone 17 256G</button><button type="button" data-example="机械键盘">机械键盘</button><button type="button" data-example="洗衣液">洗衣液</button></div>' +
        '</div>';
      return;
    }

    var items = visibleItems();
    if (!items.length) {
      root.innerHTML =
        '<div class="state-card"><div class="state-icon">∅</div><h2>没有匹配结果</h2><p>换个更具体的型号或去掉平台筛选试试。</p><div class="official-links">' +
        E.PLATFORM_ORDER.map(function (platform) {
          return (
            '<a href="' +
            escAttr(E.platformSearchUrl(platform, state.keyword)) +
            '" target="_blank" rel="noopener noreferrer">' +
            esc(platformMeta(platform).name) +
            '搜「' +
            esc(state.keyword) +
            '」</a>'
          );
        }).join('') +
        '</div></div>';
      return;
    }

    root.innerHTML =
      '<div class="results-head"><span>相关商品</span><span>' +
      items.length +
      ' 个结果</span></div>' +
      '<div class="product-list">' +
      items.map(renderCard).join('') +
      '</div>' +
      '<p class="results-caveat">价格为第三方索引/券后参考价，可能延迟或混入不同 SKU；请以商品页和结算页为准。</p>';
  }

  function visibleItems() {
    var list = state.all.filter(function (item) {
      if (state.platform !== 'all' && item.platform !== state.platform) return false;
      if (state.couponOnly && !item.hasCoupon) return false;
      return true;
    });
    return E.sortItems(list, state.sort);
  }

  function render() {
    renderStatus();
    renderSummary();
    renderControls();
    renderResults();
  }

  // -------------------------------------------------------------------------
  // 搜索
  // -------------------------------------------------------------------------

  function runSearch(keyword) {
    var query = String(keyword == null ? '' : keyword).trim();
    if (!query) {
      toast('先输入商品名');
      var input = $('#search-input');
      if (input) input.focus();
      return;
    }
    state.keyword = query;
    state.loading = true;
    state.error = '';
    state.all = [];
    state.summary = null;
    state.platform = 'all';
    state.couponOnly = false;
    state.sort = 'price';
    var input = $('#search-input');
    if (input) input.value = query;
    try {
      history.replaceState(null, '', '?q=' + encodeURIComponent(query));
    } catch (error) {}
    render();

    apiSearch(query)
      .then(function (raw) {
        state.rawCount = raw.length;
        var ranked = E.filterAndRank(raw, query);
        state.all = ranked;
        state.summary = E.summarize(ranked);
        state.loading = false;
        if (!ranked.length) {
          state.error = '';
        }
        render();
        if (!ranked.length) {
          setStatus('找到公开结果，但没有通过相关度筛选。换一个更具体的型号试试。', 'error');
        }
      })
      .catch(function (error) {
        state.loading = false;
        state.all = [];
        state.summary = null;
        state.error =
          error && error.name === 'AbortError'
            ? '搜索超时，请检查网络后重试。'
            : '第三方搜索接口没有返回数据。';
        render();
      });
  }

  // -------------------------------------------------------------------------
  // 商品链接
  // -------------------------------------------------------------------------

  function openProduct(item) {
    if (!item) return;
    var fallback = E.platformSearchUrl(item.platform, state.keyword || item.title);
    var win = null;
    try {
      win = window.open('about:blank', '_blank');
    } catch (error) {
      win = null;
    }

    if (win) {
      try {
        win.document.write(
          '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:-apple-system,sans-serif;padding:32px;color:#17241d"><p>正在打开商品…</p><p style="color:#6d786f;font-size:14px">如果长时间没有跳转，请返回省算。</p></body></html>'
        );
        win.document.title = '正在打开商品…';
      } catch (error) {}
      apiShareLink(item)
        .then(function (url) {
          win.location.replace(url || fallback);
        })
        .catch(function () {
          win.location.replace(fallback);
        });
      return;
    }

    showProductSheet(item, fallback);
  }

  function showProductSheet(item, fallback) {
    openSheet({
      title: '打开商品',
      subtitle: item.platformName + ' · ¥' + money(item.price),
      body:
        '<div class="sheet-product"><div class="sheet-product-title">' +
        esc(item.title) +
        '</div><div class="sheet-product-meta">' +
        (item.shop ? esc(item.shop) + ' · ' : '') +
        (item.hasCoupon ? '券 ¥' + money(item.coupon) + ' · ' : '') +
        '参考到手价 ¥' +
        money(item.price) +
        '</div></div>' +
        '<div class="direct-link" id="direct-link"><span class="loading-dot"></span>正在获取商品直达链接…</div>' +
        '<a class="btn btn-soft btn-block" href="' +
        escAttr(fallback) +
        '" target="_blank" rel="noopener noreferrer">在' +
        esc(item.platformName) +
        '搜同款</a>' +
        '<p class="hint">直达链接由第三方比价服务提供，可能含推广参数；价格以平台结算页为准。</p>',
      type: 'product'
    });

    apiShareLink(item)
      .then(function (url) {
        var box = $('#direct-link');
        if (!box) return;
        if (url) {
          box.innerHTML =
            '<a class="btn btn-primary btn-block" href="' +
            escAttr(url) +
            '" target="_blank" rel="noopener noreferrer">打开' +
            esc(item.platformName) +
            '商品页</a>';
        } else {
          box.innerHTML = '<p class="hint">没有拿到直达链接，请用下面的平台搜索。</p>';
        }
      })
      .catch(function () {
        var box = $('#direct-link');
        if (box) box.innerHTML = '<p class="hint">直达链接获取失败，请用下面的平台搜索。</p>';
      });
  }

  // -------------------------------------------------------------------------
  // 弹层与说明
  // -------------------------------------------------------------------------

  function openSheet(options) {
    closeSheet();
    clearTimeout(toastTimer);
    var toastEl = $('#toast');
    if (toastEl) toastEl.classList.remove('show');
    var root = $('#sheet-root');
    root.innerHTML =
      '<div class="sheet-backdrop" data-action="close-sheet"></div>' +
      '<section class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">' +
      '<div class="sheet-grab"></div>' +
      '<div class="sheet-head"><div><h2 id="sheet-title">' +
      esc(options.title || '') +
      '</h2>' +
      (options.subtitle ? '<p>' + esc(options.subtitle) + '</p>' : '') +
      '</div><button class="sheet-close" type="button" data-action="close-sheet" aria-label="关闭">×</button></div>' +
      '<div class="sheet-body">' +
      (options.body || '') +
      '</div>' +
      '</section>';
    document.body.classList.add('sheet-open');
    activeSheet = true;
  }

  function closeSheet() {
    var root = $('#sheet-root');
    if (root) root.innerHTML = '';
    document.body.classList.remove('sheet-open');
    activeSheet = null;
  }

  function openAbout() {
    openSheet({
      title: '关于省算',
      subtitle: '淘宝 · 京东 · 拼多多',
      body:
        '<div class="about-box">' +
        '<p><strong>怎么搜的？</strong><br>输入商品名后，省算请求第三方公开比价索引，取淘宝/天猫、京东、拼多多的券后参考价，再按名称相关度和价格筛选。不是登录后的专属价，也不是结算页最终价。</p>' +
        '<p><strong>为什么价格可能不准？</strong><br>公开索引会延迟，也可能把不同 SKU、配件或店铺混在一起。省算会过滤明显配件和无关标题，但“最低价”仍只是相关结果的最低参考价。下单前请核对型号、规格和店铺。</p>' +
        '<p><strong>商品链接</strong><br>“打开商品”会请求第三方转链，可能包含推广参数；不影响商品页价格，但可能给第三方带来佣金。你也可以直接用“在平台搜同款”走官方搜索。</p>' +
        '<p><strong>隐私</strong><br>你输入的关键词会发送给第三方比价接口。省算没有自己的后端，不保存搜索记录到服务器；当前页面只保留内存状态。</p>' +
        '<p><strong>本版范围</strong><br>美团已移除。当前覆盖淘宝/天猫、京东、拼多多；优惠叠加的精确算券不再作为主流程，价格以接口返回的券后参考价为准。</p>' +
        '</div>',
      type: 'about'
    });
  }

  // -------------------------------------------------------------------------
  // 事件
  // -------------------------------------------------------------------------

  document.addEventListener('click', function (event) {
    var action = event.target.closest('[data-action]');
    if (action && action.getAttribute('data-action') === 'close-sheet') {
      closeSheet();
      return;
    }

    var example = event.target.closest('[data-example]');
    if (example) {
      var value = example.getAttribute('data-example');
      var input = $('#search-input');
      if (input) input.value = value;
      runSearch(value);
      return;
    }

    var filter = event.target.closest('[data-platform]');
    if (filter && filter.classList.contains('filter-chip')) {
      state.platform = filter.getAttribute('data-platform');
      render();
      return;
    }

    var open = event.target.closest('[data-open]');
    if (open) {
      var item = itemById.get(open.getAttribute('data-open'));
      if (item) openProduct(item);
      return;
    }

    if (event.target.closest('[data-retry]')) {
      if (state.keyword) runSearch(state.keyword);
      return;
    }

    if (event.target.closest('#coupon-toggle')) {
      state.couponOnly = !state.couponOnly;
      render();
      return;
    }

    if (event.target.closest('[data-action="open-about"]')) {
      openAbout();
    }
  });

  document.addEventListener('change', function (event) {
    if (event.target && event.target.id === 'sort-select') {
      state.sort = event.target.value;
      render();
    }
  });

  document.addEventListener('submit', function (event) {
    if (!event.target || event.target.id !== 'search-form') return;
    event.preventDefault();
    var input = $('#search-input');
    runSearch(input ? input.value : '');
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && activeSheet) closeSheet();
  });

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------

  function boot() {
    itemById = new Map();
    var params = new URLSearchParams(location.search);
    var query = params.get('q') || '';
    var input = $('#search-input');
    if (input && query) input.value = query;
    render();
    if (query) runSearch(query);
    if ('serviceWorker' in navigator && (location.protocol === 'http:' || location.protocol === 'https:')) {
      navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' }).catch(function () {});
    }
  }

  // 每次渲染后重建 id 映射，供“打开商品”使用。
  var originalRender = render;
  render = function () {
    itemById = new Map();
    state.all.forEach(function (item) {
      itemById.set(item.id, item);
    });
    originalRender();
  };

  boot();
})();
