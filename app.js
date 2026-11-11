(function () {
  'use strict';

  var E = window.SuanEngine;
  if (!E) {
    document.body.innerHTML = '<p style="padding:24px;font-family:sans-serif">计算引擎加载失败，请刷新页面。</p>';
    return;
  }

  var STORAGE_KEY = 'suansuan.state.v1';
  var PLATFORMS = ['taobao', 'meituan'];
  var VERSION = '1.0.3';
  var state;
  var compareResult = null;
  var cartResults = {};
  var fillerSuggestions = {};
  var activeSheet = null;
  var parsedDraft = null;
  var deferredInstallPrompt = null;
  var toastTimer = null;
  var refreshTimer = null;
  var saveTimer = null;
  var storageWarned = false;

  var PRESETS = {
    taobao: [
      {
        key: 'cross',
        short: '跨店满减',
        coupon: {
          title: '跨店每满300减50',
          type: 'per',
          threshold: 300,
          value: 50,
          scope: 'all',
          stackGroup: '平台活动',
          mode: 'parallel'
        }
      },
      {
        key: 'shop',
        short: '店铺券',
        coupon: {
          title: '店铺券 满200减20',
          type: 'minus',
          threshold: 200,
          value: 20,
          scope: 'shop',
          target: '',
          stackGroup: '店铺券',
          mode: 'parallel'
        }
      },
      {
        key: 'vip',
        short: '88VIP',
        coupon: {
          title: '88VIP 95折',
          type: 'percent',
          zhe: 9.5,
          threshold: 0,
          value: 0,
          scope: 'all',
          stackGroup: '会员权益',
          mode: 'parallel'
        }
      },
      {
        key: 'red',
        short: '红包',
        coupon: {
          title: '红包 10元',
          type: 'minus',
          threshold: 0,
          value: 10,
          scope: 'all',
          stackGroup: '红包',
          mode: 'parallel'
        }
      }
    ],
    meituan: [
      {
        key: 'shen',
        short: '外卖神券',
        coupon: {
          title: '外卖神券 满30减8',
          type: 'minus',
          threshold: 30,
          value: 8,
          scope: 'all',
          stackGroup: '平台券',
          mode: 'parallel'
        }
      },
      {
        key: 'shop',
        short: '店铺满减',
        coupon: {
          title: '店铺满减 满50减10',
          type: 'minus',
          threshold: 50,
          value: 10,
          scope: 'shop',
          target: '',
          stackGroup: '店铺券',
          mode: 'parallel'
        }
      },
      {
        key: 'vip',
        short: '会员红包',
        coupon: {
          title: '会员红包 5元',
          type: 'minus',
          threshold: 0,
          value: 5,
          scope: 'all',
          stackGroup: '红包',
          mode: 'parallel'
        }
      },
      {
        key: 'ship',
        short: '配送费券',
        coupon: {
          title: '配送费券 减3元',
          type: 'shipping',
          threshold: 0,
          value: 3,
          scope: 'all',
          stackGroup: '运费',
          mode: 'parallel'
        }
      }
    ]
  };

  var TYPE_SHORT = {
    minus: '满减',
    percent: '折扣',
    per: '每满',
    shipping: '运费'
  };

  // ---------------------------------------------------------------------------
  // 基础工具
  // ---------------------------------------------------------------------------

  function uid(prefix) {
    return (
      (prefix || 'id') +
      '-' +
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 7)
    );
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function escAttr(value) {
    return esc(value).replace(/`/g, '&#96;');
  }

  function money(cents) {
    return (Math.max(0, Math.round(Number(cents) || 0)) / 100).toFixed(2);
  }

  function inputNum(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return '0';
    var rounded = Math.round(n * 100) / 100;
    return String(rounded).replace(/\.0+$/, '').replace(/(\.\d)0+$/, '$1');
  }

  function num(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function platformMeta(id) {
    return E.PLATFORM_META[id] || { id: id, name: id, short: '?' };
  }

  function otherPlatform(id) {
    return id === 'taobao' ? 'meituan' : 'taobao';
  }

  function isIOSDevice() {
    var ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/i.test(ua)) return true;
    // iPadOS 13+ 的桌面模式 UA 不再包含 iPad，用触点数兜底。
    return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  }

  function isStandaloneApp() {
    if (navigator.standalone === true) return true;
    if (typeof window.matchMedia !== 'function') return false;
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches
    );
  }

  function safeLink(value) {
    if (!value) return '';
    try {
      var url = new URL(String(value), window.location.href);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch (error) {
      return '';
    }
    return '';
  }

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function toast(message) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('show');
    }, 2600);
  }

  function hasData() {
    return PLATFORMS.some(function (platform) {
      var cart = state.carts[platform];
      return cart.items.length > 0 || cart.coupons.length > 0;
    });
  }

  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------

  function emptyCart(platform) {
    return {
      id: platform,
      items: [],
      fees: { shipping: 0, packing: 0 },
      coupons: []
    };
  }

  function defaultState() {
    return {
      version: 1,
      carts: {
        taobao: emptyCart('taobao'),
        meituan: emptyCart('meituan')
      },
      updatedAt: 0
    };
  }

  function sanitizeItem(raw) {
    var item = raw && typeof raw === 'object' ? raw : {};
    return {
      id: item.id != null && String(item.id) ? String(item.id) : uid('item'),
      title: String(item.title || '未命名商品').slice(0, 120),
      price: Math.max(0, num(item.price)),
      qty: Math.max(1, Math.floor(num(item.qty) || 1)),
      shop: String(item.shop || '').slice(0, 80),
      category: String(item.category || '').slice(0, 40),
      link: String(item.link || '').slice(0, 800),
      isFiller: !!item.isFiller
    };
  }

  function sanitizeCoupon(raw) {
    var c = raw && typeof raw === 'object' ? raw : {};
    var type = ['minus', 'percent', 'per', 'shipping'].indexOf(c.type) >= 0 ? c.type : 'minus';
    var scope = ['all', 'shop', 'category', 'item'].indexOf(c.scope) >= 0 ? c.scope : 'all';
    var mode = c.mode === 'sequential' ? 'sequential' : 'parallel';
    return {
      id: c.id != null && String(c.id) ? String(c.id) : uid('coupon'),
      title: String(c.title || '优惠券').slice(0, 80),
      type: type,
      threshold: Math.max(0, num(c.threshold != null ? c.threshold : c.step)),
      value: Math.max(0, num(c.value != null ? c.value : c.discount)),
      zhe: Math.min(10, Math.max(0, num(c.zhe != null ? c.zhe : c.discountRate) || (type === 'percent' ? 9 : 0))),
      cap: Math.max(0, num(c.cap)),
      scope: scope,
      target: String(c.target || '').slice(0, 80),
      stackGroup: String(c.stackGroup || ''),
      mode: mode,
      solo: !!c.solo,
      enabled: c.enabled !== false
    };
  }

  function sanitizeCart(raw, platform) {
    var cart = raw && typeof raw === 'object' ? raw : {};
    var fees = cart.fees && typeof cart.fees === 'object' ? cart.fees : {};
    return {
      id: platform,
      items: (Array.isArray(cart.items) ? cart.items : []).map(sanitizeItem),
      fees: {
        shipping: Math.max(0, num(fees.shipping)),
        packing: Math.max(0, num(fees.packing))
      },
      coupons: (Array.isArray(cart.coupons) ? cart.coupons : []).map(sanitizeCoupon)
    };
  }

  function normalizeState(raw) {
    var base = defaultState();
    var input = raw && typeof raw === 'object' ? raw : {};
    var carts = input.carts && typeof input.carts === 'object' ? input.carts : input;
    PLATFORMS.forEach(function (platform) {
      base.carts[platform] = sanitizeCart(carts && carts[platform], platform);
    });
    base.updatedAt = num(input.updatedAt);
    return base;
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return normalizeState(JSON.parse(raw));
    } catch (error) {
      // 损坏的数据不应阻塞使用。
    }
    return defaultState();
  }

  function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        state.updatedAt = Date.now();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (error) {
        if (!storageWarned) {
          storageWarned = true;
          toast('浏览器禁止了本地存储，刷新后数据可能丢失');
        }
      }
    }, 120);
  }

  function demoState() {
    var now = Date.now();
    var demo = {
      version: 1,
      updatedAt: now,
      carts: {
        taobao: {
          id: 'taobao',
          items: [
            {
              id: 'demo-tb-item',
              title: 'Soundcore 声阔 Liberty 4 NC 降噪蓝牙耳机',
              price: 319,
              qty: 1,
              shop: '声阔旗舰店',
              category: '数码',
              link: ''
            }
          ],
          fees: { shipping: 0, packing: 0 },
          coupons: [
            {
              id: 'demo-tb-cross',
              title: '跨店每满300减50',
              type: 'per',
              threshold: 300,
              value: 50,
              scope: 'all',
              target: '',
              stackGroup: '平台活动',
              mode: 'parallel',
              enabled: true
            },
            {
              id: 'demo-tb-shop',
              title: '店铺券 满200减20',
              type: 'minus',
              threshold: 200,
              value: 20,
              scope: 'shop',
              target: '声阔旗舰店',
              stackGroup: '店铺券',
              mode: 'parallel',
              enabled: true
            },
            {
              id: 'demo-tb-vip',
              title: '88VIP 95折',
              type: 'percent',
              zhe: 9.5,
              threshold: 0,
              value: 0,
              scope: 'all',
              target: '',
              stackGroup: '会员权益',
              mode: 'parallel',
              enabled: true
            }
          ]
        },
        meituan: {
          id: 'meituan',
          items: [
            {
              id: 'demo-mt-item',
              title: 'Soundcore 声阔 Liberty 4 NC 降噪蓝牙耳机',
              price: 329,
              qty: 1,
              shop: '美团数码旗舰店',
              category: '数码',
              link: ''
            }
          ],
          fees: { shipping: 5, packing: 2 },
          coupons: [
            {
              id: 'demo-mt-shen',
              title: '外卖神券 满99减15',
              type: 'minus',
              threshold: 99,
              value: 15,
              scope: 'all',
              target: '',
              stackGroup: '平台券',
              mode: 'parallel',
              enabled: true
            },
            {
              id: 'demo-mt-shop',
              title: '店铺满减 满200减10',
              type: 'minus',
              threshold: 200,
              value: 10,
              scope: 'shop',
              target: '美团数码旗舰店',
              stackGroup: '店铺券',
              mode: 'parallel',
              enabled: true
            }
          ]
        }
      }
    };
    return normalizeState(demo);
  }

  // ---------------------------------------------------------------------------
  // 计算
  // ---------------------------------------------------------------------------

  function compute() {
    compareResult = E.compareCarts(
      PLATFORMS.map(function (platform) {
        return state.carts[platform];
      })
    );
    cartResults = {};
    compareResult.results.forEach(function (result) {
      cartResults[result.cartId] = result;
    });
    fillerSuggestions = {};
    PLATFORMS.forEach(function (platform) {
      var result = cartResults[platform];
      if (!result || result.empty || result.couponCount > 8) return;
      try {
        fillerSuggestions[platform] = E.suggestFiller(state.carts[platform], result);
      } catch (error) {
        fillerSuggestions[platform] = null;
      }
    });
  }

  function activePlatforms() {
    return PLATFORMS.filter(function (platform) {
      return cartResults[platform] && !cartResults[platform].empty;
    });
  }

  function winnerDiff(platform) {
    if (!compareResult || compareResult.empty || compareResult.tie) return 0;
    var winner = cartResults[compareResult.winnerId];
    var current = cartResults[platform];
    if (!winner || !current || winner.cartId === platform) return 0;
    return current.plan.payableCents - winner.plan.payableCents;
  }

  // ---------------------------------------------------------------------------
  // 渲染：页面骨架
  // ---------------------------------------------------------------------------

  function renderHero() {
    var title = $('#hero-title');
    var sub = $('#hero-sub');
    var compare = $('#hero-compare');
    var active = activePlatforms();

    if (!active.length) {
      title.textContent = '这单，在哪买更便宜？';
      sub.textContent = '把两个平台的商品和券填进来，自动算清每一分钱。';
      compare.classList.add('is-empty');
      compare.innerHTML =
        '<div class="compare-empty">先放一件商品，再加几张券。<strong>淘宝</strong> 和 <strong>美团</strong> 都填好后，这里会直接给出更低的那一边。</div>';
      return;
    }

    compare.classList.remove('is-empty');
    var winnerId = compareResult.winnerId;
    var tie = compareResult.tie;
    var winnerMeta = platformMeta(winnerId);

    if (active.length === 1) {
      title.textContent = '再填一边，就能比价';
      var only = active[0];
      sub.innerHTML =
        '已算好 <strong>' +
        esc(platformMeta(only).name) +
        '</strong> 的到手价；把同款商品加到另一个平台，立刻比较。';
    } else if (tie) {
      title.textContent = '两边到手价一样';
      sub.innerHTML = '都算上运费和优惠后，两边到手价相同。可以再看看赠品、时效和售后。';
    } else {
      title.textContent = '在' + winnerMeta.name + '买，更便宜';
      sub.innerHTML =
        '已经算上商品价、运费和优惠券，<strong>' +
        esc(winnerMeta.name) +
        '</strong> 比另一边便宜 <strong>¥' +
        money(compareResult.differenceCents) +
        '</strong>。';
    }

    compare.innerHTML = PLATFORMS.map(function (platform) {
      var result = cartResults[platform];
      var meta = platformMeta(platform);
      if (!result || result.empty) {
        return (
          '<div class="compare-tile">' +
          '<div class="compare-top"><span class="compare-name">' +
          esc(meta.name) +
          '</span><span class="compare-tag">待填写</span></div>' +
          '<div class="compare-price">—</div>' +
          '<div class="compare-meta">添加同款商品</div>' +
          '</div>'
        );
      }
      var isWinner = !tie && winnerId === platform;
      var tag = isWinner ? '更低' : tie ? '持平' : '贵 ¥' + money(winnerDiff(platform));
      return (
        '<div class="compare-tile' +
        (isWinner ? ' winner' : '') +
        '">' +
        '<div class="compare-top"><span class="compare-name">' +
        esc(meta.name) +
        '</span><span class="compare-tag">' +
        esc(tag) +
        '</span></div>' +
        '<div class="compare-price"><small>¥</small>' +
        money(result.plan.payableCents) +
        '</div>' +
        '<div class="compare-meta">' +
        (result.savingsCents > 0 ? '已省 ¥' + money(result.savingsCents) : '暂无优惠') +
        ' · ' +
        result.appliedCount +
        ' 张券</div>' +
        '</div>'
      );
    }).join('');
  }

  function renderSticky() {
    var label = $('#sticky-label');
    var price = $('#sticky-price');
    var active = activePlatforms();
    if (!active.length) {
      label.textContent = '当前最优';
      price.textContent = '—';
      return;
    }
    if (active.length === 1) {
      var only = cartResults[active[0]];
      label.textContent = '已算 ' + platformMeta(active[0]).name;
      price.textContent = '¥' + money(only.plan.payableCents);
      return;
    }
    if (compareResult.tie) {
      label.textContent = '两边持平';
      price.textContent = '¥' + money(cartResults[active[0]].plan.payableCents);
      return;
    }
    var winner = cartResults[compareResult.winnerId];
    label.textContent = platformMeta(compareResult.winnerId).name + ' 更低';
    price.innerHTML =
      '¥' +
      money(winner.plan.payableCents) +
      ' <em>省 ¥' +
      money(compareResult.differenceCents) +
      '</em>';
  }

  function renderWinnerMarks() {
    PLATFORMS.forEach(function (platform) {
      var card = $('#cart-' + platform);
      var mark = $('#win-' + platform);
      if (!card || !mark) return;
      var isWinner =
        compareResult &&
        !compareResult.empty &&
        !compareResult.tie &&
        compareResult.winnerId === platform;
      card.classList.toggle('is-winner', !!isWinner);
      mark.hidden = !isWinner;
    });
  }

  function renderCart(platform) {
    var card = $('#cart-' + platform);
    if (!card) return;
    var cart = state.carts[platform];
    var meta = platformMeta(platform);
    var itemCount = cart.items.length;
    var couponCount = cart.coupons.length;
    var itemHtml = itemCount
      ? '<div class="items">' +
        cart.items
          .map(function (item, index) {
            return renderItem(platform, item, index);
          })
          .join('') +
        '</div>'
      : '<div class="empty-items">' +
        '<span class="empty-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9Z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/></svg></span>' +
        '<strong>还没有商品</strong>' +
        '<p>粘贴商品口令最省事，也可以手动填写。</p>' +
        '<button class="btn btn-soft btn-sm" type="button" data-action="add-item" data-platform="' +
        platform +
        '">+ 添加商品</button>' +
        '</div>';

    var couponHtml = couponCount
      ? cart.coupons
          .map(function (coupon) {
            return renderCoupon(platform, coupon);
          })
          .join('')
      : '<p class="coupon-empty">还没有优惠。点“加优惠”，或用粘贴口令自动识别满减和折扣。</p>';

    card.innerHTML =
      '<div class="cart-head">' +
      '<span class="platform-badge ' +
      platform +
      '">' +
      esc(meta.short) +
      '</span>' +
      '<div class="cart-title">' +
      '<h3>' +
      esc(meta.name) +
      ' <span class="winner-dot" id="win-' +
      platform +
      '" hidden>更低</span></h3>' +
      '<p>' +
      (itemCount ? itemCount + ' 件商品' : '还没有商品') +
      ' · ' +
      couponCount +
      ' 张优惠</p>' +
      '</div>' +
      '<button class="cart-add" type="button" data-action="add-item" data-platform="' +
      platform +
      '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>商品</button>' +
      '</div>' +
      itemHtml +
      '<div class="fee-box">' +
      '<div class="fee-field"><label for="fee-' +
      platform +
      '-shipping">运费</label><input id="fee-' +
      platform +
      '-shipping" data-fee="shipping" data-platform="' +
      platform +
      '" type="number" inputmode="decimal" min="0" step="0.01" value="' +
      escAttr(inputNum(cart.fees.shipping)) +
      '" aria-label="' +
      escAttr(meta.name) +
      '运费"><span class="unit">元</span></div>' +
      '<div class="fee-field"><label for="fee-' +
      platform +
      '-packing">打包</label><input id="fee-' +
      platform +
      '-packing" data-fee="packing" data-platform="' +
      platform +
      '" type="number" inputmode="decimal" min="0" step="0.01" value="' +
      escAttr(inputNum(cart.fees.packing)) +
      '" aria-label="' +
      escAttr(meta.name) +
      '打包费"><span class="unit">元</span></div>' +
      '</div>' +
      '<div class="coupon-head"><h4>优惠券 <span class="coupon-count">' +
      couponCount +
      '</span></h4><button class="coupon-add" type="button" data-action="add-coupon" data-platform="' +
      platform +
      '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>加优惠</button></div>' +
      '<div class="coupon-list">' +
      couponHtml +
      '</div>' +
      '<div class="result" id="result-' +
      platform +
      '">' +
      renderResult(platform) +
      '</div>' +
      '<div id="filler-' +
      platform +
      '">' +
      renderFiller(platform) +
      '</div>';

    renderWinnerMarks();
  }

  function renderItem(platform, item, index) {
    var lineTotal = Math.round(item.price * 100) * item.qty;
    var meta = [];
    if (item.shop) meta.push(esc(item.shop));
    if (item.category) meta.push(esc(item.category));
    if (item.qty > 1) meta.push('数量 ×' + item.qty);
    var link = safeLink(item.link);
    if (link) {
      meta.push(
        '<a class="item-link" href="' +
          escAttr(link) +
          '" target="_blank" rel="noopener noreferrer">原链接</a>'
      );
    }
    return (
      '<div class="item-row">' +
      '<span class="item-index">' +
      (index + 1) +
      '</span>' +
      '<div class="item-main">' +
      '<div class="item-title">' +
      esc(item.title) +
      (item.isFiller ? ' <span class="coupon-count">凑单</span>' : '') +
      '</div>' +
      (meta.length ? '<div class="item-meta"><span>' + meta.join('</span><span>') + '</span></div>' : '') +
      '</div>' +
      '<div class="item-price">¥' +
      money(lineTotal) +
      (item.qty > 1
        ? '<small>¥' + money(Math.round(item.price * 100)) + ' × ' + item.qty + '</small>'
        : '') +
      '</div>' +
      '<div class="item-tools">' +
      '<button class="mini-btn" type="button" data-action="edit-item" data-platform="' +
      platform +
      '" data-id="' +
      escAttr(item.id) +
      '" aria-label="编辑商品"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.2-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z"/><path d="m13.5 7.5 3 3"/></svg></button>' +
      '<button class="mini-btn" type="button" data-action="delete-item" data-platform="' +
      platform +
      '" data-id="' +
      escAttr(item.id) +
      '" aria-label="删除商品"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12M9 7V5h6v2M8 7l.8 13h6.4L16 7"/></svg></button>' +
      '</div>' +
      '</div>'
    );
  }

  function couponCondition(coupon) {
    var type = coupon.type;
    var threshold = Number(coupon.threshold) || 0;
    var value = Number(coupon.value) || 0;
    if (type === 'percent') {
      return inputNum(coupon.zhe || 10) + '折' + (coupon.cap > 0 ? ' · 最多减¥' + inputNum(coupon.cap) : '');
    }
    if (type === 'per') {
      return '每满¥' + inputNum(threshold) + '减¥' + inputNum(value);
    }
    if (type === 'shipping') {
      return '运费减¥' + inputNum(value) + (threshold > 0 ? ' · 满¥' + inputNum(threshold) : '');
    }
    return threshold > 0 ? '满¥' + inputNum(threshold) + '减¥' + inputNum(value) : '无门槛减¥' + inputNum(value);
  }

  function renderCoupon(platform, coupon) {
    var type = coupon.type;
    var typeLabel = TYPE_SHORT[type] || '优惠';
    var scopeLabel =
      coupon.scope === 'shop'
        ? '店铺：' + (coupon.target || '未指定')
        : coupon.scope === 'category'
          ? '品类：' + (coupon.target || '未指定')
          : coupon.scope === 'item'
            ? '指定商品'
            : '全部商品';
    return (
      '<div class="coupon-row' +
      (coupon.enabled === false ? ' is-off' : '') +
      '">' +
      '<span class="coupon-ticket">' +
      esc(typeLabel) +
      '</span>' +
      '<div class="coupon-main">' +
      '<div class="coupon-title">' +
      esc(coupon.title || '优惠券') +
      '</div>' +
      '<div class="coupon-meta"><span>' +
      esc(couponCondition(coupon)) +
      '</span><span class="tag">' +
      esc(scopeLabel) +
      '</span>' +
      (coupon.stackGroup ? '<span class="tag">' + esc(coupon.stackGroup) + '</span>' : '') +
      (coupon.mode === 'sequential' ? '<span class="tag seq">递进</span>' : '') +
      (coupon.solo ? '<span class="tag seq">不叠加</span>' : '') +
      '</div>' +
      '</div>' +
      '<div class="coupon-tools">' +
      '<button class="mini-btn" type="button" data-action="edit-coupon" data-platform="' +
      platform +
      '" data-id="' +
      escAttr(coupon.id) +
      '" aria-label="编辑优惠券"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.2-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z"/><path d="m13.5 7.5 3 3"/></svg></button>' +
      '<button class="mini-btn" type="button" data-action="delete-coupon" data-platform="' +
      platform +
      '" data-id="' +
      escAttr(coupon.id) +
      '" aria-label="删除优惠券"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12M9 7V5h6v2M8 7l.8 13h6.4L16 7"/></svg></button>' +
      '<button class="toggle' +
      (coupon.enabled !== false ? ' on' : '') +
      '" type="button" role="switch" aria-checked="' +
      (coupon.enabled !== false ? 'true' : 'false') +
      '" data-action="toggle-coupon" data-platform="' +
      platform +
      '" data-id="' +
      escAttr(coupon.id) +
      '" aria-label="启用或停用优惠券"></button>' +
      '</div>' +
      '</div>'
    );
  }

  function renderResult(platform) {
    var result = cartResults[platform];
    if (!result || result.empty) {
      return '<div class="result-empty">添加商品后，这里会显示最优用券方案。</div>';
    }
    var plan = result.plan;
    var steps = plan.steps.length
      ? plan.steps
          .map(function (step, index) {
            return (
              '<div class="step">' +
              '<span class="step-num">' +
              (index + 1) +
              '</span>' +
              '<span class="step-name" title="按 ¥' +
              money(step.baseCents) +
              ' 计算">' +
              esc(step.title) +
              '</span>' +
              '<span class="step-amount">-¥' +
              money(step.discountCents) +
              '</span>' +
              '</div>'
            );
          })
          .join('')
      : '<div class="step"><span class="step-num">·</span><span class="step-name">暂无可用优惠</span><span class="step-amount">—</span></div>';

    return (
      '<div class="result-head"><span>最优方案</span><span class="result-head-right">' +
      (result.savingsCents > 0
        ? '<span class="save-chip">省 ¥' + money(result.savingsCents) + '</span>'
        : '') +
      '<button class="plan-copy" type="button" data-action="copy-plan" data-platform="' +
      platform +
      '">复制方案</button></span></div>' +
      '<div class="result-lines">' +
      '<div class="result-line"><span>商品小计</span><b>¥' +
      money(plan.itemsSubtotalCents) +
      '</b></div>' +
      '<div class="result-line"><span>运费 / 打包</span><b>¥' +
      money(plan.feesCents) +
      '</b></div>' +
      (plan.shippingDiscountCents > 0
        ? '<div class="result-line"><span>运费券</span><b>-¥' + money(plan.shippingDiscountCents) + '</b></div>'
        : '') +
      '<div class="steps"><span class="steps-title">用券顺序</span>' +
      steps +
      '</div>' +
      '</div>' +
      '<div class="result-total"><div><div class="label">到手价</div><div class="amount"><small>¥</small>' +
      money(plan.payableCents) +
      '</div></div><div class="saving">' +
      (result.savingsCents > 0
        ? '已省 ¥' + money(result.savingsCents) + '<br>' + (result.savingsRate * 100).toFixed(1) + '%'
        : '暂无优惠') +
      '</div></div>' +
      (result.truncated
        ? '<div class="result-note warn">券组合较多，已取计算时间内的最优解；减少几张“递进”券可以算得更彻底。</div>'
        : '')
    );
  }

  function renderFiller(platform) {
    var filler = fillerSuggestions[platform];
    if (!filler) return '';
    return (
      '<div class="filler">' +
      '<span class="filler-icon">+</span>' +
      '<div class="filler-main">' +
      '<div class="filler-title">凑单雷达</div>' +
      '<div class="filler-text">再凑 <b>¥' +
      money(filler.gapCents) +
      '</b> 可触发「' +
      esc(filler.title) +
      '」，预计再省 <b>¥' +
      money(filler.savingCents) +
      '</b>（含凑单品）。</div>' +
      '<button class="btn btn-soft btn-sm" type="button" data-action="apply-filler" data-platform="' +
      platform +
      '">加凑单品</button>' +
      '</div>' +
      '</div>'
    );
  }

  function renderDynamicResults() {
    PLATFORMS.forEach(function (platform) {
      var result = $('#result-' + platform);
      var filler = $('#filler-' + platform);
      if (result) result.innerHTML = renderResult(platform);
      if (filler) filler.innerHTML = renderFiller(platform);
    });
    renderHero();
    renderSticky();
    renderWinnerMarks();
  }

  function renderAll() {
    compute();
    PLATFORMS.forEach(renderCart);
    renderHero();
    renderSticky();
  }

  function refresh(structural) {
    if (structural) {
      clearTimeout(refreshTimer);
      compute();
      PLATFORMS.forEach(renderCart);
      renderHero();
      renderSticky();
      renderWinnerMarks();
      return;
    }
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () {
      compute();
      renderDynamicResults();
    }, 90);
  }

  // ---------------------------------------------------------------------------
  // 弹层
  // ---------------------------------------------------------------------------

  function openSheet(options) {
    closeSheet();
    clearTimeout(toastTimer);
    var toastEl = $('#toast');
    if (toastEl) toastEl.classList.remove('show');
    var root = $('#sheet-root');
    var actions = options.actions || '';
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
      (actions ? '<div class="sheet-actions">' + actions + '</div>' : '') +
      '</section>';
    document.body.classList.add('sheet-open');
    activeSheet = {
      onSubmit: options.onSubmit || null,
      type: options.type || ''
    };
    if (options.afterRender) {
      options.afterRender(root);
    }
  }

  function closeSheet() {
    var root = $('#sheet-root');
    if (root) root.innerHTML = '';
    document.body.classList.remove('sheet-open');
    activeSheet = null;
  }

  function sheetActions(submitText) {
    return (
      '<button class="btn btn-ghost" type="button" data-action="close-sheet">取消</button>' +
      '<button class="btn btn-primary" type="submit" form="sheet-form">' +
      esc(submitText || '保存') +
      '</button>'
    );
  }

  // ---------------------------------------------------------------------------
  // 商品表单
  // ---------------------------------------------------------------------------

  function openItemSheet(platform, itemId) {
    var cart = state.carts[platform];
    var existing = itemId
      ? cart.items.filter(function (item) {
          return item.id === itemId;
        })[0]
      : null;
    var item = existing || {
      id: '',
      title: '',
      price: '',
      qty: 1,
      shop: '',
      category: '',
      link: ''
    };
    var title = existing ? '编辑商品' : '添加商品';
    var body =
      '<form id="sheet-form" class="form-grid" novalidate>' +
      '<input type="hidden" name="id" value="' +
      escAttr(item.id) +
      '">' +
      '<div class="field"><label for="item-title">商品名称</label><input class="input" id="item-title" name="title" required maxlength="120" value="' +
      escAttr(item.title) +
      '" placeholder="例如：AirPods Pro 2"></div>' +
      '<div class="field-row">' +
      '<div class="field"><label for="item-price">价格（元）</label><div class="input-group"><span class="prefix">¥</span><input class="input" id="item-price" name="price" type="number" inputmode="decimal" min="0" step="0.01" required value="' +
      escAttr(inputNum(item.price)) +
      '" placeholder="0.00"></div></div>' +
      '<div class="field"><label for="item-qty">数量</label><input class="input" id="item-qty" name="qty" type="number" inputmode="numeric" min="1" step="1" value="' +
      escAttr(item.qty) +
      '"></div>' +
      '</div>' +
      '<div class="field-row">' +
      '<div class="field"><label for="item-shop">店铺（选填）</label><input class="input" id="item-shop" name="shop" maxlength="80" value="' +
      escAttr(item.shop) +
      '" placeholder="用于店铺券匹配"></div>' +
      '<div class="field"><label for="item-category">品类（选填）</label><input class="input" id="item-category" name="category" maxlength="40" value="' +
      escAttr(item.category) +
      '" placeholder="数码 / 外卖"></div>' +
      '</div>' +
      '<div class="field"><label for="item-link">商品链接（选填）</label><input class="input" id="item-link" name="link" type="url" inputmode="url" maxlength="800" value="' +
      escAttr(item.link) +
      '" placeholder="https://..."></div>' +
      '<p class="hint">价格填商品页显示的单价；运费和打包费在购物车下方单独填。商品链接只用于回看，不会自动抓取价格。</p>' +
      '</form>';
    openSheet({
      title: title,
      subtitle: platformMeta(platform).name,
      body: body,
      actions: sheetActions(existing ? '保存修改' : '添加商品'),
      type: 'item',
      onSubmit: function (form) {
        var data = new FormData(form);
        var name = String(data.get('title') || '').trim();
        var price = num(data.get('price'));
        var qty = Math.max(1, Math.floor(num(data.get('qty')) || 1));
        if (!name) {
          toast('请填写商品名称');
          return false;
        }
        if (!Number.isFinite(price) || price < 0) {
          toast('请填写正确的价格');
          return false;
        }
        var payload = sanitizeItem({
          id: existing ? existing.id : '',
          title: name,
          price: price,
          qty: qty,
          shop: data.get('shop'),
          category: data.get('category'),
          link: data.get('link')
        });
        if (existing) {
          var index = cart.items.findIndex(function (current) {
            return current.id === existing.id;
          });
          if (index >= 0) cart.items[index] = payload;
        } else {
          cart.items.push(payload);
        }
        saveState();
        closeSheet();
        refresh(true);
        toast(existing ? '商品已更新' : '商品已添加');
        return true;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 优惠券表单
  // ---------------------------------------------------------------------------

  function blankCoupon() {
    return {
      id: '',
      title: '',
      type: 'minus',
      threshold: 0,
      value: 10,
      zhe: 9,
      cap: 0,
      scope: 'all',
      target: '',
      stackGroup: '平台券',
      mode: 'parallel',
      solo: false,
      enabled: true
    };
  }

  function couponTypeBlock(type, coupon) {
    var hidden = coupon.type === type ? '' : ' hidden';
    if (type === 'minus') {
      return (
        '<div class="field-row js-type-block" data-type="minus"' +
        hidden +
        '><div class="field"><label for="coupon-minus-threshold">门槛（元）</label><div class="input-group"><span class="prefix">¥</span><input class="input" id="coupon-minus-threshold" name="minusThreshold" type="number" inputmode="decimal" min="0" step="0.01" value="' +
        escAttr(inputNum(coupon.threshold)) +
        '"></div><p class="hint">0 表示无门槛</p></div>' +
        '<div class="field"><label for="coupon-minus-value">减免金额（元）</label><div class="input-group"><span class="prefix">¥</span><input class="input" id="coupon-minus-value" name="minusValue" type="number" inputmode="decimal" min="0" step="0.01" value="' +
        escAttr(inputNum(coupon.value)) +
        '"></div></div></div>'
      );
    }
    if (type === 'percent') {
      return (
        '<div class="field-row js-type-block" data-type="percent"' +
        hidden +
        '><div class="field"><label for="coupon-percent-zhe">折扣（折）</label><input class="input" id="coupon-percent-zhe" name="percentZhe" type="number" inputmode="decimal" min="0.1" max="10" step="0.1" value="' +
        escAttr(inputNum(coupon.zhe || 9)) +
        '"><p class="hint">8.8 表示 8.8 折</p></div>' +
        '<div class="field"><label for="coupon-percent-cap">最多减（元）</label><div class="input-group"><span class="prefix">¥</span><input class="input" id="coupon-percent-cap" name="percentCap" type="number" inputmode="decimal" min="0" step="0.01" value="' +
        escAttr(inputNum(coupon.cap)) +
        '"></div><p class="hint">0 表示不封顶</p></div></div>'
      );
    }
    if (type === 'per') {
      return (
        '<div class="field-row js-type-block" data-type="per"' +
        hidden +
        '><div class="field"><label for="coupon-per-threshold">每满（元）</label><div class="input-group"><span class="prefix">¥</span><input class="input" id="coupon-per-threshold" name="perThreshold" type="number" inputmode="decimal" min="0.01" step="0.01" value="' +
        escAttr(inputNum(coupon.threshold || 300)) +
        '"></div></div>' +
        '<div class="field"><label for="coupon-per-value">每次减（元）</label><div class="input-group"><span class="prefix">¥</span><input class="input" id="coupon-per-value" name="perValue" type="number" inputmode="decimal" min="0.01" step="0.01" value="' +
        escAttr(inputNum(coupon.value || 50)) +
        '"></div></div></div>'
      );
    }
    return (
      '<div class="field-row js-type-block" data-type="shipping"' +
      hidden +
      '><div class="field"><label for="coupon-shipping-value">运费减免（元）</label><div class="input-group"><span class="prefix">¥</span><input class="input" id="coupon-shipping-value" name="shippingValue" type="number" inputmode="decimal" min="0.01" step="0.01" value="' +
      escAttr(inputNum(coupon.value || 3)) +
      '"></div></div><div class="field"><label for="coupon-shipping-threshold">使用门槛（元）</label><div class="input-group"><span class="prefix">¥</span><input class="input" id="coupon-shipping-threshold" name="shippingThreshold" type="number" inputmode="decimal" min="0" step="0.01" value="' +
      escAttr(inputNum(coupon.threshold)) +
      '"></div><p class="hint">0 表示无门槛</p></div></div>'
    );
  }

  function openCouponSheet(platform, couponId, preset) {
    var cart = state.carts[platform];
    var existing = couponId
      ? cart.coupons.filter(function (coupon) {
          return coupon.id === couponId;
        })[0]
      : null;
    var coupon = sanitizeCoupon(
      Object.assign(blankCoupon(), existing || {}, preset ? preset.coupon || preset : {})
    );
    if (!existing && !preset) {
      coupon.id = '';
    }
    var isEdit = !!existing;
    var presets = PRESETS[platform] || [];
    var presetHtml =
      !isEdit && presets.length
        ? '<div class="preset-row">' +
          presets
            .map(function (item) {
              return (
                '<button class="preset-chip" type="button" data-action="preset-coupon" data-platform="' +
                platform +
                '" data-preset="' +
                escAttr(item.key) +
                '">' +
                esc(item.short) +
                '</button>'
              );
            })
            .join('') +
          '</div>'
        : '';

    var scopeOptions = [
      ['all', '全部商品'],
      ['shop', '指定店铺'],
      ['category', '指定品类'],
      ['item', '指定商品']
    ]
      .map(function (pair) {
        return (
          '<option value="' +
          pair[0] +
          '"' +
          (coupon.scope === pair[0] ? ' selected' : '') +
          '>' +
          pair[1] +
          '</option>'
        );
      })
      .join('');

    var groupOptions =
      '<option value="">不限制（可与同组外叠加）</option>' +
      E.STACK_GROUPS.map(function (group) {
        return (
          '<option value="' +
          escAttr(group) +
          '"' +
          (coupon.stackGroup === group ? ' selected' : '') +
          '>' +
          esc(group) +
          '</option>'
        );
      }).join('');
    if (coupon.stackGroup && E.STACK_GROUPS.indexOf(coupon.stackGroup) < 0) {
      groupOptions =
        '<option value="' +
        escAttr(coupon.stackGroup) +
        '" selected>' +
        esc(coupon.stackGroup) +
        '</option>' +
        groupOptions;
    }

    var itemOptions = cart.items
      .map(function (item) {
        return (
          '<option value="' +
          escAttr(item.id) +
          '"' +
          (coupon.target === item.id ? ' selected' : '') +
          '>' +
          esc(item.title) +
          '</option>'
        );
      })
      .join('');
    if (!itemOptions) itemOptions = '<option value="">先添加商品</option>';

    var body =
      '<form id="sheet-form" class="form-grid" novalidate>' +
      '<input type="hidden" name="id" value="' +
      escAttr(coupon.id) +
      '">' +
      presetHtml +
      '<div class="form-section">' +
      '<div class="form-section-title">券面信息</div>' +
      '<div class="field"><label for="coupon-title">名称</label><input class="input" id="coupon-title" name="title" maxlength="80" value="' +
      escAttr(coupon.title) +
      '" placeholder="例如：店铺券 满200减20"></div>' +
      '<div class="field"><label for="coupon-type">类型</label><select class="select" id="coupon-type" name="type">' +
      ['minus', 'percent', 'per', 'shipping']
        .map(function (type) {
          return (
            '<option value="' +
            type +
            '"' +
            (coupon.type === type ? ' selected' : '') +
            '>' +
            E.COUPON_TYPE_META[type].name +
            '</option>'
          );
        })
        .join('') +
      '</select></div>' +
      couponTypeBlock('minus', coupon) +
      couponTypeBlock('percent', coupon) +
      couponTypeBlock('per', coupon) +
      couponTypeBlock('shipping', coupon) +
      '</div>' +
      '<div class="form-section">' +
      '<div class="form-section-title">适用范围</div>' +
      '<div class="field"><label for="coupon-scope">适用商品</label><select class="select" id="coupon-scope" name="scope">' +
      scopeOptions +
      '</select></div>' +
      '<div class="field js-target-block" data-target="shop"' +
      (coupon.scope === 'shop' ? '' : ' hidden') +
      '><label for="coupon-target-shop">店铺名</label><input class="input" id="coupon-target-shop" name="targetShop" maxlength="80" value="' +
      escAttr(coupon.scope === 'shop' ? coupon.target : '') +
      '" placeholder="要和商品里的店铺名一致"></div>' +
      '<div class="field js-target-block" data-target="category"' +
      (coupon.scope === 'category' ? '' : ' hidden') +
      '><label for="coupon-target-category">品类</label><input class="input" id="coupon-target-category" name="targetCategory" maxlength="40" value="' +
      escAttr(coupon.scope === 'category' ? coupon.target : '') +
      '" placeholder="例如：数码、外卖"></div>' +
      '<div class="field js-target-block" data-target="item"' +
      (coupon.scope === 'item' ? '' : ' hidden') +
      '><label for="coupon-target-item">指定商品</label><select class="select" id="coupon-target-item" name="targetItem">' +
      itemOptions +
      '</select></div>' +
      '<div class="field"><label for="coupon-group">叠加组</label><select class="select" id="coupon-group" name="stackGroup">' +
      groupOptions +
      '</select><p class="hint">同一组里的券只能选一张；不确定时选“不限制”。</p></div>' +
      '</div>' +
      '<div class="form-section">' +
      '<div class="form-section-title">叠加方式</div>' +
      '<div class="segmented">' +
      '<label><input type="radio" name="mode" value="parallel"' +
      (coupon.mode === 'parallel' ? ' checked' : '') +
      '><span>平行（按原价）</span></label>' +
      '<label><input type="radio" name="mode" value="sequential"' +
      (coupon.mode === 'sequential' ? ' checked' : '') +
      '><span>递进（按折后）</span></label>' +
      '</div>' +
      '<p class="hint">淘宝跨店满减、店铺券通常是平行；美团团购/外卖的店铺满减可能按折后金额，选“递进”更接近结算页。</p>' +
      '<div class="check-row"><input id="coupon-solo" name="solo" type="checkbox"' +
      (coupon.solo ? ' checked' : '') +
      '><label for="coupon-solo">不可与任何优惠叠加（特价券）<p>勾选后只单独计算这张券，再和普通方案比谁更省。</p></label></div>' +
      '<div class="check-row"><input id="coupon-enabled" name="enabled" type="checkbox"' +
      (coupon.enabled !== false ? ' checked' : '') +
      '><label for="coupon-enabled">启用这张券<p>暂时不想用可以关掉，不用删除。</p></label></div>' +
      '</div>' +
      '</form>';

    openSheet({
      title: isEdit ? '编辑优惠' : '添加优惠',
      subtitle: platformMeta(platform).name,
      body: body,
      actions: sheetActions(isEdit ? '保存修改' : '添加优惠'),
      type: 'coupon',
      afterRender: function (root) {
        updateCouponForm(root);
      },
      onSubmit: function (form) {
        var data = new FormData(form);
        var type = String(data.get('type') || 'minus');
        var scope = String(data.get('scope') || 'all');
        var target =
          scope === 'shop'
            ? String(data.get('targetShop') || '').trim()
            : scope === 'category'
              ? String(data.get('targetCategory') || '').trim()
              : scope === 'item'
                ? String(data.get('targetItem') || '').trim()
                : '';
        if (scope !== 'all' && !target) {
          toast('请填写适用的店铺、品类或商品');
          return false;
        }
        var threshold = 0;
        var value = 0;
        var zhe = 0;
        var cap = 0;
        if (type === 'minus') {
          threshold = num(data.get('minusThreshold'));
          value = num(data.get('minusValue'));
        } else if (type === 'percent') {
          zhe = num(data.get('percentZhe'));
          cap = num(data.get('percentCap'));
        } else if (type === 'per') {
          threshold = num(data.get('perThreshold'));
          value = num(data.get('perValue'));
        } else {
          threshold = num(data.get('shippingThreshold'));
          value = num(data.get('shippingValue'));
        }
        if (type === 'per' && (threshold <= 0 || value <= 0)) {
          toast('每满减的金额要大于 0');
          return false;
        }
        if ((type === 'minus' || type === 'shipping') && value <= 0) {
          toast('减免金额要大于 0');
          return false;
        }
        if (type === 'percent' && (zhe <= 0 || zhe >= 10)) {
          toast('折扣请在 0 到 10 折之间');
          return false;
        }
        var payload = sanitizeCoupon({
          id: isEdit ? existing.id : '',
          title: data.get('title') || couponTitleFromValues(type, threshold, value, zhe),
          type: type,
          threshold: threshold,
          value: value,
          zhe: zhe,
          cap: cap,
          scope: scope,
          target: target,
          stackGroup: data.get('stackGroup'),
          mode: data.get('mode'),
          solo: data.get('solo') === 'on',
          enabled: data.get('enabled') === 'on'
        });
        if (isEdit) {
          var index = cart.coupons.findIndex(function (current) {
            return current.id === existing.id;
          });
          if (index >= 0) cart.coupons[index] = payload;
        } else {
          cart.coupons.push(payload);
        }
        saveState();
        closeSheet();
        refresh(true);
        toast(isEdit ? '优惠已更新' : '优惠已添加');
        return true;
      }
    });
  }

  function couponTitleFromValues(type, threshold, value, zhe) {
    if (type === 'percent') return inputNum(zhe) + '折券';
    if (type === 'per') return '每满' + inputNum(threshold) + '减' + inputNum(value);
    if (type === 'shipping') return '运费券 减' + inputNum(value) + '元';
    return threshold > 0
      ? '满' + inputNum(threshold) + '减' + inputNum(value)
      : '无门槛券 ' + inputNum(value) + '元';
  }

  function updateCouponForm(root) {
    var scopeRoot = root || document;
    var type = $('#coupon-type', scopeRoot);
    var scope = $('#coupon-scope', scopeRoot);
    if (!type || !scope) return;
    $$('.js-type-block', scopeRoot).forEach(function (block) {
      block.hidden = block.getAttribute('data-type') !== type.value;
    });
    $$('.js-target-block', scopeRoot).forEach(function (block) {
      block.hidden = block.getAttribute('data-target') !== scope.value;
    });
  }

  // ---------------------------------------------------------------------------
  // 粘贴解析
  // ---------------------------------------------------------------------------

  function openPasteSheet() {
    parsedDraft = null;
    var body =
      '<form id="sheet-form" class="form-grid" novalidate>' +
      '<div class="field"><label for="paste-raw">粘贴分享口令 / 商品文案</label><textarea class="textarea" id="paste-raw" name="raw" placeholder="从淘宝或美团复制商品口令、链接或分享文案，粘贴到这里…"></textarea><p class="hint">会尝试识别平台、标题、价格、满减和折扣。识别不出的字段可以填入后再编辑。</p></div>' +
      '<div class="field-row">' +
      '<div class="field"><label for="paste-platform">识别平台</label><select class="select" id="paste-platform" name="platform"><option value="">自动识别</option><option value="taobao">淘宝 / 天猫</option><option value="meituan">美团</option></select></div>' +
      '<div class="field"><label for="paste-target">填入</label><select class="select" id="paste-target" name="target"><option value="">自动跟随识别</option><option value="taobao">淘宝 / 天猫</option><option value="meituan">美团</option></select></div>' +
      '</div>' +
      '<button class="btn btn-soft btn-block" type="button" data-action="parse-share">解析预览</button>' +
      '<div class="parse-preview" id="parse-preview"></div>' +
      '</form>';
    openSheet({
      title: '粘贴商品口令',
      subtitle: '从 App 复制，粘贴进来，自动填一半',
      body: body,
      actions: sheetActions('填入购物车'),
      type: 'paste',
      onSubmit: function (form) {
        var data = new FormData(form);
        var raw = String(data.get('raw') || '').trim();
        if (!raw) {
          toast('请先粘贴商品口令或链接');
          return false;
        }
        var hint = String(data.get('platform') || '');
        var parsed = parsedDraft;
        if (!parsed || parsed.raw !== raw || (hint && parsed.platform !== hint)) {
          parsed = E.parseShareText(raw, hint || undefined);
        }
        if (!parsed || (!parsed.title && !parsed.price && !parsed.coupons.length)) {
          toast('没有识别出内容，请检查口令或手动添加');
          return false;
        }
        var target = String(data.get('target') || parsed.platform || 'taobao');
        if (PLATFORMS.indexOf(target) < 0) target = 'taobao';
        var cart = state.carts[target];
        var item = sanitizeItem({
          id: '',
          title: parsed.title || '未命名商品',
          price: parsed.price || 0,
          qty: 1,
          shop: parsed.shop || '',
          category: '',
          link: parsed.link || ''
        });
        cart.items.push(item);

        var existing = new Set(
          cart.coupons.map(function (coupon) {
            return [coupon.title, coupon.type, coupon.threshold, coupon.value, coupon.zhe].join('|');
          })
        );
        var added = 0;
        parsed.coupons.forEach(function (coupon) {
          var key = [coupon.title, coupon.type, coupon.threshold, coupon.value, coupon.zhe].join('|');
          if (existing.has(key)) return;
          existing.add(key);
          cart.coupons.push(
            sanitizeCoupon(
              Object.assign({}, coupon, {
                id: '',
                title: coupon.title || '解析优惠'
              })
            )
          );
          added += 1;
        });
        saveState();
        closeSheet();
        refresh(true);
        toast(
          '已填入' +
            platformMeta(target).name +
            (added ? '，并识别 ' + added + ' 张券' : '') +
            (parsed.price ? '' : '；价格未识别，请手动补上')
        );
        return true;
      }
    });
  }

  function parseCurrentPaste() {
    var raw = String(($('#paste-raw') || {}).value || '').trim();
    if (!raw) {
      toast('请先粘贴商品口令或链接');
      return;
    }
    var hint = String(($('#paste-platform') || {}).value || '');
    parsedDraft = E.parseShareText(raw, hint || undefined);
    var preview = $('#parse-preview');
    if (!preview) return;
    if (!parsedDraft.ok) {
      preview.innerHTML =
        '<div class="parse-warn">没有识别出平台或价格。可以继续手动填写，或换一段包含「淘宝/美团 + 价格 + 满减」的文案。</div>';
      return;
    }
    var target = $('#paste-target');
    if (target && parsedDraft.platform) target.value = parsedDraft.platform;
    var coupons = parsedDraft.coupons.length
      ? parsedDraft.coupons
          .map(function (coupon) {
            return '<span class="parse-coupon">' + esc(coupon.title || '优惠券') + '</span>';
          })
          .join('')
      : '<span class="parse-coupon">未识别到券</span>';
    preview.innerHTML =
      '<div class="parse-card">' +
      '<div class="parse-platform"><span class="dot"></span><strong>' +
      esc(parsedDraft.platform ? platformMeta(parsedDraft.platform).name : '未识别平台') +
      '</strong></div>' +
      '<div class="parse-title">' +
      esc(parsedDraft.title || '未命名商品') +
      '</div>' +
      '<div class="parse-meta"><span>价格 <b>' +
      (parsedDraft.price ? '¥' + inputNum(parsedDraft.price) : '未识别') +
      '</b></span>' +
      (parsedDraft.shop ? '<span>店铺 <b>' + esc(parsedDraft.shop) + '</b></span>' : '') +
      (parsedDraft.link ? '<span>链接已识别</span>' : '') +
      '</div>' +
      '<div class="parse-coupons">' +
      coupons +
      '</div>' +
      (parsedDraft.price
        ? ''
        : '<div class="parse-warn">价格没识别出来，填入后请在商品里手动补上，否则无法比价。</div>') +
      '</div>';
  }

  // ---------------------------------------------------------------------------
  // 设置 / 数据
  // ---------------------------------------------------------------------------

  function copyPlan(platform) {
    var result = cartResults[platform];
    if (!result || result.empty) return;
    var meta = platformMeta(platform);
    var lines = [
      '【省算】' + meta.name + '到手价 ¥' + money(result.plan.payableCents),
      '原价 ¥' + money(result.plan.itemsSubtotalCents) + '，共省 ¥' + money(result.savingsCents)
    ];
    if (result.plan.steps.length) {
      lines.push('用券顺序：');
      result.plan.steps.forEach(function (step, index) {
        lines.push(index + 1 + '. ' + step.title + ' -¥' + money(step.discountCents));
      });
    }
    if (
      compareResult &&
      !compareResult.empty &&
      compareResult.complete &&
      !compareResult.tie &&
      compareResult.winnerId === platform
    ) {
      lines.push('比另一边便宜 ¥' + money(compareResult.differenceCents) + '。');
    }
    lines.push('按我填写的优惠规则计算，下单前以结算页为准。');
    copyText(lines.join('\n'))
      .then(function () {
        toast('方案已复制，可以发给自己或朋友');
      })
      .catch(function () {
        toast('复制失败，请手动截图');
      });
  }

  function openSettingsSheet() {
    var installLabel = isStandaloneApp()
      ? '已安装 · 查看说明'
      : deferredInstallPrompt
        ? '现在安装'
        : '查看安装方法';
    var body =
      '<div class="settings-list">' +
      '<button class="settings-item" type="button" data-action="install-app"><span class="s-icon">⌂</span><span class="s-main"><strong>安装到手机桌面</strong><p>' +
      installLabel +
      ' · 像 App 一样打开，支持离线使用</p></span><span class="chev">›</span></button>' +
      '<button class="settings-item" type="button" data-action="load-demo-settings"><span class="s-icon">◎</span><span class="s-main"><strong>载入示例数据</strong><p>一键看淘宝 / 美团双平台比价效果</p></span><span class="chev">›</span></button>' +
      '<button class="settings-item" type="button" data-action="export-data"><span class="s-icon">↓</span><span class="s-main"><strong>导出数据</strong><p>保存为 JSON，换手机或备份用</p></span><span class="chev">›</span></button>' +
      '<button class="settings-item" type="button" data-action="import-trigger"><span class="s-icon">↑</span><span class="s-main"><strong>导入数据</strong><p>从之前导出的 JSON 恢复</p></span><span class="chev">›</span></button>' +
      '<button class="settings-item" type="button" data-action="copy-json"><span class="s-icon">⧉</span><span class="s-main"><strong>复制数据 JSON</strong><p>不方便下载时，复制到备忘录</p></span><span class="chev">›</span></button>' +
      '<button class="settings-item" type="button" data-action="clear-data"><span class="s-icon">×</span><span class="s-main"><strong>清空所有数据</strong><p>删除本机保存的商品和优惠券</p></span><span class="chev">›</span></button>' +
      '<button class="settings-item" type="button" data-action="open-about"><span class="s-icon">i</span><span class="s-main"><strong>关于省算</strong><p>计算规则、边界和隐私说明</p></span><span class="chev">›</span></button>' +
      '</div>' +
      '<input class="file-input" type="file" id="import-file" accept=".json,application/json">' +
      '<div class="settings-note">省算不连接淘宝/美团账号，不抓取平台数据。所有商品和券都由你填写，计算只在这台设备上完成。优惠规则请以结算页为准。</div>';
    openSheet({
      title: '设置与数据',
      subtitle: '本地优先 · 无需登录',
      body: body,
      type: 'settings'
    });
    var file = $('#import-file');
    if (file) {
      file.addEventListener('change', handleImportFile);
    }
  }

  function openAboutSheet() {
    openSheet({
      title: '关于省算',
      subtitle: 'v' + VERSION,
      body:
        '<div class="about-box">' +
        '<p><strong>省算做什么？</strong><br>把淘宝/天猫和美团同一件商品的商品价、运费、满减、店铺券、折扣、红包、运费券放在一起，计算最低到手价和用券顺序。</p>' +
        '<p><strong>怎么算？</strong><br>金额按「分」计算。平行优惠按原价计算，递进优惠按上一张券后的金额计算；同一叠加组只选一张；不可叠加券单独比较。组合较多时会做限时搜索，结果可能不是数学上的绝对最优。</p>' +
        '<p><strong>为什么不能全自动抓价？</strong><br>淘宝、美团没有面向普通消费者的公开比价接口，商品页还需要登录、风控和 App 环境。省算选择「你粘贴/填写，我来算」的方式：不碰账号、不存 token、不依赖第三方接口，稳定且不违反平台规则。</p>' +
        '<p><strong>隐私</strong><br>没有后端、没有统计脚本。数据默认只存在浏览器 localStorage，除非你主动导出或复制。</p>' +
        '<p><strong>提醒</strong><br>平台优惠规则、门槛和叠加限制会变。下单前请以结算页显示为准；省算不是淘宝/美团官方产品。</p>' +
        '</div>',
      type: 'about'
    });
  }

  function downloadJson() {
    try {
      var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var date = new Date();
      var name =
        '省算-数据-' +
        date.getFullYear() +
        String(date.getMonth() + 1).padStart(2, '0') +
        String(date.getDate()).padStart(2, '0') +
        '.json';
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 2000);
      toast('已导出 JSON 文件');
    } catch (error) {
      toast('导出失败，可以试试“复制数据 JSON”');
    }
  }

  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      try {
        var area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-9999px';
        area.style.left = '0';
        area.style.fontSize = '16px';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.focus();
        area.select();
        // iOS Safari 需要显式选区，否则 execCommand('copy') 可能返回 false。
        area.setSelectionRange(0, area.value.length);
        var ok = document.execCommand('copy');
        document.body.removeChild(area);
        if (!ok) {
          reject(new Error('copy failed'));
          return;
        }
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () {
        return legacyCopy(text);
      });
    }
    return legacyCopy(text);
  }

  function copyJson() {
    copyText(JSON.stringify(state, null, 2))
      .then(function () {
        toast('数据 JSON 已复制');
      })
      .catch(function () {
        toast('复制失败，请用导出文件');
      });
  }

  function handleImportFile(event) {
    var file = event.target.files && event.target.files[0];
    if (!file) return;
    file
      .text()
      .then(function (text) {
        var data = JSON.parse(text);
        if (!data || (!data.carts && !data.taobao)) throw new Error('bad');
        state = normalizeState(data);
        saveState();
        closeSheet();
        refresh(true);
        toast('数据已导入');
      })
      .catch(function () {
        toast('导入失败：不是有效的省算 JSON');
      });
  }

  function clearData() {
    if (!window.confirm('确定清空所有商品和优惠券？此操作不可撤销。')) return;
    state = defaultState();
    saveState();
    closeSheet();
    refresh(true);
    toast('已清空');
  }

  function loadDemo(confirmReplace) {
    if (confirmReplace && hasData() && !window.confirm('示例会覆盖当前数据，继续？')) return;
    state = demoState();
    saveState();
    closeSheet();
    refresh(true);
    toast('示例已载入，可以直接改数字');
  }

  function installApp() {
    if (isStandaloneApp()) {
      toast('已经在主屏幕的独立窗口里运行');
      return;
    }
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice
        .then(function (choice) {
          if (choice && choice.outcome === 'accepted') toast('已添加到桌面');
          deferredInstallPrompt = null;
        })
        .catch(function () {});
      return;
    }
    var isIOS = isIOSDevice();
    var isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    openSheet({
      title: '安装到手机桌面',
      subtitle: '不经过应用商店，像 App 一样打开',
      body:
        '<div class="about-box">' +
        (isIOS
          ? '<p><strong>iPhone / iPad（iOS 27 Safari）</strong><br>点 Safari 底部工具栏的「分享」按钮 → 向下找到「添加到主屏幕」→ 点「添加」。<br><br>如果分享菜单里没有这一项，点「编辑操作」把它加回来。必须用 Safari；微信内置浏览器不能添加到桌面。</p>'
          : '<p><strong>Android（Chrome / Edge）</strong><br>点浏览器右上角「⋮」→「安装应用」或「添加到主屏幕」。<br><br>如果没看到安装入口，说明当前页面不是 HTTPS 地址，可先部署到 GitHub Pages 等免费静态托管。</p>') +
        (isSecure
          ? ''
          : '<p><strong>注意</strong><br>当前不是 HTTPS。iOS 仍可能允许“添加到主屏幕”，但 Service Worker 离线缓存不会生效；要完整体验请部署到 HTTPS。</p>') +
        '<p><strong>当前地址</strong><br>' +
        esc(location.href) +
        '</p>' +
        '</div>',
      type: 'install'
    });
  }

  // ---------------------------------------------------------------------------
  // 事件
  // ---------------------------------------------------------------------------

  document.addEventListener('click', function (event) {
    var target = event.target.closest('[data-action]');
    if (!target) return;
    var action = target.getAttribute('data-action');
    var platform = target.getAttribute('data-platform');
    var id = target.getAttribute('data-id');

    if (action === 'close-sheet') {
      closeSheet();
      return;
    }
    if (action === 'open-paste') {
      openPasteSheet();
      return;
    }
    if (action === 'open-settings') {
      openSettingsSheet();
      return;
    }
    if (action === 'open-about') {
      openAboutSheet();
      return;
    }
    if (action === 'add-item') {
      openItemSheet(platform);
      return;
    }
    if (action === 'edit-item') {
      openItemSheet(platform, id);
      return;
    }
    if (action === 'delete-item') {
      var itemCart = state.carts[platform];
      var item = itemCart.items.filter(function (current) {
        return current.id === id;
      })[0];
      if (!item) return;
      if (!window.confirm('删除「' + item.title + '」？')) return;
      itemCart.items = itemCart.items.filter(function (current) {
        return current.id !== id;
      });
      saveState();
      refresh(true);
      toast('商品已删除');
      return;
    }
    if (action === 'add-coupon') {
      openCouponSheet(platform);
      return;
    }
    if (action === 'preset-coupon') {
      var presetKey = target.getAttribute('data-preset');
      var preset = (PRESETS[platform] || []).filter(function (item) {
        return item.key === presetKey;
      })[0];
      if (preset) openCouponSheet(platform, null, preset);
      return;
    }
    if (action === 'edit-coupon') {
      openCouponSheet(platform, id);
      return;
    }
    if (action === 'delete-coupon') {
      var couponCart = state.carts[platform];
      couponCart.coupons = couponCart.coupons.filter(function (coupon) {
        return coupon.id !== id;
      });
      saveState();
      refresh(true);
      toast('优惠已删除');
      return;
    }
    if (action === 'toggle-coupon') {
      var toggleCart = state.carts[platform];
      var coupon = toggleCart.coupons.filter(function (current) {
        return current.id === id;
      })[0];
      if (!coupon) return;
      coupon.enabled = coupon.enabled === false;
      saveState();
      refresh(true);
      return;
    }
    if (action === 'copy-plan') {
      copyPlan(platform);
      return;
    }
    if (action === 'apply-filler') {
      var filler = fillerSuggestions[platform];
      if (!filler) return;
      var fillerItem = sanitizeItem(
        Object.assign({}, filler.filler, {
          id: '',
          isFiller: true
        })
      );
      state.carts[platform].items.push(fillerItem);
      saveState();
      refresh(true);
      toast('已加入凑单品，可以改成真实商品');
      return;
    }
    if (action === 'parse-share') {
      parseCurrentPaste();
      return;
    }
    if (action === 'scroll-hero') {
      var hero = $('#hero');
      if (hero) hero.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (action === 'load-demo' || action === 'load-demo-settings') {
      loadDemo(true);
      return;
    }
    if (action === 'install-app') {
      installApp();
      return;
    }
    if (action === 'export-data') {
      downloadJson();
      return;
    }
    if (action === 'import-trigger') {
      var file = $('#import-file');
      if (file) file.click();
      return;
    }
    if (action === 'copy-json') {
      copyJson();
      return;
    }
    if (action === 'clear-data') {
      clearData();
      return;
    }
  });

  document.addEventListener('change', function (event) {
    var target = event.target;
    if (target.id === 'coupon-type') {
      updateCouponForm(document);
    }
    if (target.id === 'coupon-scope') {
      updateCouponForm(document);
    }
    if (target.getAttribute && target.getAttribute('data-fee')) {
      updateFee(target);
    }
  });

  document.addEventListener('input', function (event) {
    var target = event.target;
    if (target.getAttribute && target.getAttribute('data-fee')) {
      updateFee(target, true);
    }
  });

  function updateFee(input, defer) {
    var platform = input.getAttribute('data-platform');
    var field = input.getAttribute('data-fee');
    if (!platform || !field) return;
    var value = Math.max(0, num(input.value));
    state.carts[platform].fees[field] = value;
    saveState();
    refresh(!defer);
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredInstallPrompt = event;
  });

  window.addEventListener('appinstalled', function () {
    deferredInstallPrompt = null;
    toast('已安装到桌面');
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && activeSheet) closeSheet();
  });

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || form.getAttribute('id') !== 'sheet-form') return;
    event.preventDefault();
    if (!activeSheet || !activeSheet.onSubmit) return;
    var result = activeSheet.onSubmit(form);
    if (result === false) {
      form.reportValidity();
    }
  });

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------

  function setupViewport() {
    var vv = window.visualViewport;
    if (!vv) return;
    var root = document.documentElement;
    var frame = 0;
    var raf =
      window.requestAnimationFrame ||
      function (callback) {
        return window.setTimeout(callback, 16);
      };

    function update() {
      frame = 0;
      var height = Math.max(1, Math.round(vv.height));
      // iOS 键盘弹出时，布局视口可能不变，只有 visualViewport 变矮。
      // 用两者的差值把底部弹层抬到键盘上方。
      var overlap = Math.max(
        0,
        Math.round(window.innerHeight - height - (vv.offsetTop || 0))
      );
      root.style.setProperty('--vvh', height + 'px');
      root.style.setProperty('--kb-offset', overlap > 60 ? overlap + 'px' : '0px');
      root.classList.toggle('keyboard-open', overlap > 60);
    }

    function schedule() {
      if (frame) return;
      frame = raf(update);
    }

    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    window.addEventListener('orientationchange', schedule);
    window.addEventListener('pageshow', schedule);
    update();
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    navigator.serviceWorker
      .register('sw.js', { scope: './', updateViaCache: 'none' })
      .catch(function () {
        // 离线能力不可用时不打扰用户。
      });
  }

  function boot() {
    var params = new URLSearchParams(location.search);
    setupViewport();
    if (isStandaloneApp()) {
      document.documentElement.classList.add('ios-standalone');
    }
    if (params.get('reset') === '1') {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (error) {}
    }
    state = loadState();
    if (params.get('demo') === '1') {
      state = demoState();
      saveState();
    } else if (!hasData() && params.get('welcome') === '1') {
      state = demoState();
      saveState();
    }
    renderAll();
    if (params.get('paste') === '1') {
      setTimeout(openPasteSheet, 180);
    }
    registerServiceWorker();
  }

  boot();
})();
