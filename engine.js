/**
 * 省算 · 到手价计算引擎
 * 纯函数、零依赖，可在浏览器与 Node.js 中运行。
 *
 * 金额在内部统一用「分」计算，避免浮点误差。
 * 购物车/优惠券对象里的金额字段使用「元」（number/string）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SuanEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CENTS = 100;
  var MAX_SEQ_DEPTH = 9;
  var MAX_SEARCH_NODES = 260000;
  var SEARCH_TIME_MS = 420;

  var PLATFORM_META = Object.freeze({
    taobao: { id: 'taobao', name: '淘宝 / 天猫', short: '淘', color: '#f45613' },
    meituan: { id: 'meituan', name: '美团', short: '团', color: '#f4b400' }
  });

  var COUPON_TYPE_META = Object.freeze({
    minus: { id: 'minus', name: '满减 / 直减' },
    percent: { id: 'percent', name: '折扣' },
    per: { id: 'per', name: '每满减' },
    shipping: { id: 'shipping', name: '运费券' }
  });

  var STACK_GROUPS = Object.freeze([
    '平台活动',
    '平台券',
    '店铺券',
    '品类券',
    '商品券',
    '红包',
    '会员权益',
    '其他'
  ]);

  function toCents(value) {
    if (typeof value === 'string') {
      value = value.replace(/[^\d.-]/g, '');
    }
    var n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.round(n * CENTS));
  }

  function fromCents(cents) {
    return Math.max(0, Math.round(Number(cents) || 0)) / CENTS;
  }

  function money(cents) {
    return (Math.max(0, Math.round(Number(cents) || 0)) / CENTS).toFixed(2);
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function normalizeText(value) {
    return String(value == null ? '' : value)
      .replace(/[\uFF01-\uFF5E]/g, function (ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
      })
      .replace(/\u3000/g, ' ')
      .replace(/￥/g, '¥')
      .trim();
  }

  function normalizeKey(value) {
    return normalizeText(value).replace(/\s+/g, '').toLowerCase();
  }

  function itemUnitCents(item) {
    if (!item) return 0;
    if (item.priceCents != null) return Math.max(0, Math.round(Number(item.priceCents) || 0));
    return toCents(item.price);
  }

  function itemQty(item) {
    var q = Number(item && item.qty);
    if (!Number.isFinite(q) || q <= 0) return 1;
    return Math.max(1, Math.floor(q));
  }

  function itemTotalCents(item) {
    return itemUnitCents(item) * itemQty(item);
  }

  function isCouponEnabled(coupon) {
    return !!coupon && coupon.enabled !== false;
  }

  function isSolo(coupon) {
    return !!(coupon && coupon.solo);
  }

  function couponType(coupon) {
    return (coupon && coupon.type) || 'minus';
  }

  function couponMode(coupon) {
    return coupon && coupon.mode === 'sequential' ? 'sequential' : 'parallel';
  }

  function couponGroupKey(coupon) {
    if (!coupon) return '';
    var group = normalizeText(coupon.stackGroup);
    return group ? 'g:' + group : 'u:' + String(coupon.id != null ? coupon.id : coupon.title || '');
  }

  function couponThresholdCents(coupon) {
    return toCents(coupon && (coupon.threshold != null ? coupon.threshold : coupon.step));
  }

  function couponValueCents(coupon) {
    return toCents(coupon && (coupon.value != null ? coupon.value : coupon.discount));
  }

  function couponCapCents(coupon) {
    return toCents(coupon && coupon.cap);
  }

  function couponZhe(coupon) {
    var z = Number(coupon && (coupon.zhe != null ? coupon.zhe : coupon.discountRate));
    if (!Number.isFinite(z) || z <= 0) return 10;
    return clamp(z, 0, 10);
  }

  function scopeMatches(item, coupon) {
    var scope = (coupon && coupon.scope) || 'all';
    if (scope === 'all') return true;
    var target = normalizeKey(coupon && coupon.target);
    if (!target) return false;
    if (scope === 'item') {
      return normalizeKey(item && item.id) === target;
    }
    if (scope === 'shop') {
      return normalizeKey(item && item.shop) === target;
    }
    if (scope === 'category') {
      var targets = String(coupon.target || '')
        .split(/[,，、/|]/)
        .map(normalizeKey)
        .filter(Boolean);
      return targets.indexOf(normalizeKey(item && item.category)) >= 0;
    }
    return false;
  }

  function createState(cart) {
    var items = Array.isArray(cart && cart.items) ? cart.items.filter(Boolean) : [];
    var entries = [];
    var itemPaid = new Map();
    var itemsSubtotal = 0;

    items.forEach(function (item, index) {
      var key = item.id != null ? String(item.id) : 'idx-' + index;
      var original = itemTotalCents(item);
      // 同一 id 理论上不应重复；若重复则合并，避免状态覆盖。
      if (itemPaid.has(key)) {
        var merged = itemPaid.get(key) + original;
        itemPaid.set(key, merged);
        itemsSubtotal += original;
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].key === key) entries[i].original += original;
        }
        return;
      }
      entries.push({ key: key, item: item, original: original });
      itemPaid.set(key, original);
      itemsSubtotal += original;
    });

    var fees = cart && cart.fees ? cart.fees : {};
    var feesPaid = toCents(fees.shipping) + toCents(fees.packing);

    return {
      cart: cart || {},
      entries: entries,
      itemPaid: itemPaid,
      itemsSubtotal: itemsSubtotal,
      feesPaid: feesPaid,
      itemDiscount: 0,
      shippingDiscount: 0,
      totalDiscount: 0,
      steps: [],
      usedGroups: new Set(),
      appliedIds: []
    };
  }

  function cloneState(state) {
    return {
      cart: state.cart,
      entries: state.entries,
      itemPaid: new Map(state.itemPaid),
      itemsSubtotal: state.itemsSubtotal,
      feesPaid: state.feesPaid,
      itemDiscount: state.itemDiscount,
      shippingDiscount: state.shippingDiscount,
      totalDiscount: state.totalDiscount,
      steps: state.steps.slice(),
      usedGroups: new Set(state.usedGroups),
      appliedIds: state.appliedIds.slice()
    };
  }

  function scopeEntries(state, coupon) {
    return state.entries.filter(function (entry) {
      return scopeMatches(entry.item, coupon);
    });
  }

  function sumOriginal(entries) {
    return entries.reduce(function (sum, entry) {
      return sum + entry.original;
    }, 0);
  }

  function sumCurrent(state, entries) {
    return entries.reduce(function (sum, entry) {
      return sum + (state.itemPaid.get(entry.key) || 0);
    }, 0);
  }

  function allocateItemDiscount(state, entries, amount) {
    var target = Math.min(amount, sumCurrent(state, entries));
    if (target <= 0) return 0;
    var currentTotal = sumCurrent(state, entries);
    if (currentTotal <= 0) return 0;

    var left = target;
    var positive = entries.filter(function (entry) {
      return (state.itemPaid.get(entry.key) || 0) > 0;
    });

    positive.forEach(function (entry, index) {
      var paid = state.itemPaid.get(entry.key) || 0;
      var share = index === positive.length - 1
        ? left
        : Math.round(target * paid / currentTotal);
      share = Math.max(0, Math.min(share, left, paid));
      state.itemPaid.set(entry.key, paid - share);
      left -= share;
    });

    return target - left;
  }

  function fail(reason, extra) {
    var result = { applied: false, reason: reason, discountCents: 0 };
    if (extra) {
      Object.keys(extra).forEach(function (key) {
        result[key] = extra[key];
      });
    }
    return result;
  }

  /**
   * 应用一张券。会直接修改 state。
   * 返回 { applied, discountCents, baseCents, reason }
   */
  function applyCoupon(state, coupon) {
    if (!isCouponEnabled(coupon)) return fail('disabled');
    if (isSolo(coupon) && state.steps.length > 0) return fail('solo');
    if (!isSolo(coupon) && state.steps.some(isSolo)) return fail('solo');

    var group = couponGroupKey(coupon);
    if (group && state.usedGroups.has(group)) return fail('group');

    var entries = scopeEntries(state, coupon);
    if (!entries.length) return fail('scope');

    var original = sumOriginal(entries);
    var current = sumCurrent(state, entries);
    var mode = couponMode(coupon);
    var thresholdBase = mode === 'sequential' ? current : original;
    var type = couponType(coupon);
    var threshold = couponThresholdCents(coupon);
    var value = couponValueCents(coupon);
    var cap = couponCapCents(coupon);
    var discount = 0;
    var base = 0;

    if (type === 'shipping') {
      if (threshold > 0 && thresholdBase < threshold) {
        return fail('threshold', { gapCents: threshold - thresholdBase, baseCents: thresholdBase });
      }
      base = state.feesPaid;
      discount = Math.min(value, state.feesPaid);
      if (discount <= 0) return fail('zero', { baseCents: base });
    } else if (type === 'percent') {
      if (threshold > 0 && thresholdBase < threshold) {
        return fail('threshold', { gapCents: threshold - thresholdBase, baseCents: thresholdBase });
      }
      base = mode === 'sequential' ? current : original;
      discount = Math.round(base * (1 - couponZhe(coupon) / 10));
      if (cap > 0) discount = Math.min(discount, cap);
      discount = Math.min(discount, base);
      if (discount <= 0) return fail('zero', { baseCents: base });
    } else if (type === 'per') {
      var step = threshold || value;
      if (step <= 0) return fail('invalid');
      base = mode === 'sequential' ? current : original;
      var times = Math.floor(base / step);
      discount = Math.min(base, times * value);
      if (times <= 0 || discount <= 0) {
        return fail('threshold', { gapCents: step - (base % step || step), baseCents: base });
      }
    } else {
      if (threshold > 0 && thresholdBase < threshold) {
        return fail('threshold', { gapCents: threshold - thresholdBase, baseCents: thresholdBase });
      }
      base = mode === 'sequential' ? current : original;
      discount = Math.min(value, base);
      if (discount <= 0) return fail('zero', { baseCents: base });
    }

    var actual = 0;
    if (type === 'shipping') {
      actual = Math.min(discount, state.feesPaid);
      state.feesPaid -= actual;
      state.shippingDiscount += actual;
    } else {
      actual = allocateItemDiscount(state, entries, discount);
      state.itemDiscount += actual;
    }
    if (actual <= 0) return fail('zero', { baseCents: base });

    state.totalDiscount = state.itemDiscount + state.shippingDiscount;
    state.usedGroups.add(group);
    state.appliedIds.push(coupon.id != null ? String(coupon.id) : String(coupon.title || ''));
    state.steps.push({
      couponId: coupon.id != null ? String(coupon.id) : '',
      title: coupon.title || COUPON_TYPE_META[type].name,
      type: type,
      mode: mode,
      scope: coupon.scope || 'all',
      stackGroup: coupon.stackGroup || '',
      baseCents: base,
      thresholdBaseCents: thresholdBase,
      discountCents: actual
    });

    return {
      applied: true,
      discountCents: actual,
      baseCents: base,
      thresholdBaseCents: thresholdBase
    };
  }

  function snapshot(state) {
    // feesPaid 在运费券后已经减少，不能再减 shippingDiscount，否则重复。
    // 到手价 = 商品优惠后的应付 + 当前运费/打包费。
    var payable = Math.max(0, (state.itemsSubtotal - state.itemDiscount) + state.feesPaid);
    return {
      cartId: state.cart && state.cart.id ? state.cart.id : '',
      itemsSubtotalCents: state.itemsSubtotal,
      feesCents: state.cart && state.cart.fees
        ? toCents(state.cart.fees.shipping) + toCents(state.cart.fees.packing)
        : 0,
      feesPaidCents: state.feesPaid,
      itemDiscountCents: state.itemDiscount,
      shippingDiscountCents: state.shippingDiscount,
      totalDiscountCents: state.totalDiscount,
      payableCents: payable,
      steps: state.steps.slice(),
      appliedCouponIds: state.appliedIds.slice()
    };
  }

  function betterPlan(a, b) {
    if (!b) return true;
    if (a.payableCents !== b.payableCents) return a.payableCents < b.payableCents;
    if (a.totalDiscountCents !== b.totalDiscountCents) {
      return a.totalDiscountCents > b.totalDiscountCents;
    }
    if (a.steps.length !== b.steps.length) return a.steps.length < b.steps.length;
    return a.appliedCouponIds.join('|') < b.appliedCouponIds.join('|');
  }

  function standaloneDiscount(cart, coupon) {
    var state = createState(cart);
    var result = applyCoupon(state, coupon);
    return result.applied ? result.discountCents : 0;
  }

  function groupParallelCandidates(cart, coupons) {
    var groups = new Map();
    coupons.forEach(function (coupon) {
      if (!isCouponEnabled(coupon) || isSolo(coupon) || couponMode(coupon) !== 'parallel') return;
      var key = couponGroupKey(coupon);
      var value = standaloneDiscount(cart, coupon);
      if (value <= 0) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ coupon: coupon, discount: value });
    });
    groups.forEach(function (list) {
      list.sort(function (a, b) {
        if (b.discount !== a.discount) return b.discount - a.discount;
        var at = couponThresholdCents(a.coupon);
        var bt = couponThresholdCents(b.coupon);
        if (at !== bt) return at - bt;
        return String(a.coupon.id || a.coupon.title).localeCompare(String(b.coupon.id || b.coupon.title));
      });
    });
    return groups;
  }

  function sequenceCoupons(coupons) {
    return coupons.filter(function (coupon) {
      return isCouponEnabled(coupon) && !isSolo(coupon) && couponMode(coupon) === 'sequential';
    });
  }

  function mixedGroupKeys(groups, seqCoupons) {
    var keys = new Set();
    seqCoupons.forEach(function (coupon) {
      if (coupon.stackGroup) keys.add('g:' + normalizeText(coupon.stackGroup));
    });
    return Array.from(groups.keys()).filter(function (key) {
      return keys.has(key);
    });
  }

  function optimizeSequential(startState, seqCoupons, ctx) {
    var best = snapshot(startState);
    var candidates = seqCoupons.slice().sort(function (a, b) {
      var ad = standaloneDiscount(startState.cart, a);
      var bd = standaloneDiscount(startState.cart, b);
      if (bd !== ad) return bd - ad;
      return String(a.id || a.title).localeCompare(String(b.id || b.title));
    });

    function dfs(state, remaining, depth) {
      if (depth >= MAX_SEQ_DEPTH) return;
      ctx.nodes += 1;
      if (ctx.nodes > MAX_SEARCH_NODES || Date.now() > ctx.deadline) {
        ctx.truncated = true;
        return;
      }
      for (var i = 0; i < remaining.length; i++) {
        var coupon = remaining[i];
        var next = cloneState(state);
        var result = applyCoupon(next, coupon);
        if (!result.applied) continue;
        var plan = snapshot(next);
        if (betterPlan(plan, best)) best = plan;
        var rest = remaining.slice(0, i).concat(remaining.slice(i + 1));
        dfs(next, rest, depth + 1);
        if (ctx.nodes > MAX_SEARCH_NODES || Date.now() > ctx.deadline) {
          ctx.truncated = true;
          return;
        }
      }
    }

    dfs(startState, candidates, 0);
    return best;
  }

  function baselinePlan(cart) {
    var state = createState(cart);
    return snapshot(state);
  }

  /**
   * 计算一个平台购物车的最优用券方案。
   */
  function optimizeCart(cart) {
    var normalized = cart || {};
    var baseline = baselinePlan(normalized);
    var empty = !normalized.items || normalized.items.length === 0;
    var enabled = (normalized.coupons || []).filter(isCouponEnabled);
    var solo = enabled.filter(isSolo);
    var normal = enabled.filter(function (coupon) {
      return !isSolo(coupon);
    });

    if (empty) {
      return {
        cartId: normalized.id || '',
        empty: true,
        baseline: baseline,
        plan: baseline,
        savingsCents: 0,
        savingsRate: 0,
        truncated: false,
        couponCount: enabled.length,
        appliedCount: 0
      };
    }

    var best = baseline;

    // 不叠加的特价券：单独使用，或与“不用券”比较。
    solo.forEach(function (coupon) {
      var state = createState(normalized);
      var result = applyCoupon(state, coupon);
      if (!result.applied) return;
      var plan = snapshot(state);
      if (betterPlan(plan, best)) best = plan;
    });

    var groups = groupParallelCandidates(normalized, normal);
    var seq = sequenceCoupons(normal);
    var mixed = mixedGroupKeys(groups, seq);
    var fixedKeys = Array.from(groups.keys()).filter(function (key) {
      return mixed.indexOf(key) < 0;
    });
    var branchCount = Math.pow(2, mixed.length);
    var ctx = {
      nodes: 0,
      truncated: false,
      deadline: Date.now() + SEARCH_TIME_MS
    };

    for (var mask = 0; mask < branchCount; mask++) {
      if (Date.now() > ctx.deadline) {
        ctx.truncated = true;
        break;
      }
      var selected = [];
      fixedKeys.forEach(function (key) {
        selected.push(groups.get(key)[0].coupon);
      });
      mixed.forEach(function (key, index) {
        if ((mask & (1 << index)) !== 0) selected.push(groups.get(key)[0].coupon);
      });

      var state = createState(normalized);
      selected.forEach(function (coupon) {
        applyCoupon(state, coupon);
      });

      var plan;
      if (seq.length) {
        plan = optimizeSequential(state, seq, ctx);
      } else {
        plan = snapshot(state);
      }
      if (betterPlan(plan, best)) best = plan;
      if (ctx.truncated && ctx.nodes > MAX_SEARCH_NODES) break;
    }

    var savings = baseline.payableCents - best.payableCents;
    return {
      cartId: normalized.id || '',
      empty: false,
      baseline: baseline,
      plan: best,
      savingsCents: Math.max(0, savings),
      savingsRate: baseline.payableCents > 0 ? Math.max(0, savings) / baseline.payableCents : 0,
      truncated: !!ctx.truncated,
      couponCount: enabled.length,
      appliedCount: best.appliedCouponIds.length,
      searchNodes: ctx.nodes
    };
  }

  function compareCarts(carts) {
    var list = Array.isArray(carts) ? carts : [];
    var results = list.map(optimizeCart);
    var active = results.filter(function (result) {
      return !result.empty;
    });
    if (!active.length) {
      return {
        empty: true,
        complete: false,
        results: results,
        winnerId: '',
        differenceCents: 0,
        tie: false
      };
    }
    active.sort(function (a, b) {
      if (a.plan.payableCents !== b.plan.payableCents) {
        return a.plan.payableCents - b.plan.payableCents;
      }
      if (b.savingsCents !== a.savingsCents) return b.savingsCents - a.savingsCents;
      return String(a.cartId).localeCompare(String(b.cartId));
    });
    var winner = active[0];
    var second = active[1];
    return {
      empty: false,
      complete: active.length === list.length && list.length > 1,
      results: results,
      winnerId: winner.cartId,
      differenceCents: second ? second.plan.payableCents - winner.plan.payableCents : 0,
      tie: !!(second && second.plan.payableCents === winner.plan.payableCents)
    };
  }

  /**
   * 凑单雷达：只对“平行优惠 + 达到门槛”的简单场景给出建议。
   * 返回 null 或 { couponId, title, gapCents, savingCents, newPayableCents, filler }
   */
  function suggestFiller(cart, result) {
    if (!result || result.empty || !result.plan) return null;
    var enabled = (cart.coupons || []).filter(isCouponEnabled);
    var applied = new Set(result.plan.appliedCouponIds);
    var best = null;

    enabled.forEach(function (coupon) {
      if (applied.has(String(coupon.id)) || isSolo(coupon) || couponMode(coupon) !== 'parallel') return;
      var type = couponType(coupon);
      if (type === 'shipping') return;
      var threshold = couponThresholdCents(coupon);
      if (threshold <= 0) return;
      if (coupon.scope && coupon.scope !== 'all' && coupon.scope !== 'category') return;

      var state = createState(cart);
      var entries = scopeEntries(state, coupon);
      var base = sumOriginal(entries);
      var gap = threshold - base;
      if (gap <= 0 || gap > 5000) return;
      // 差距过大时，凑单通常不划算；限制在门槛的 40% 以内。
      if (gap > threshold * 0.4) return;

      var filler = {
        id: 'filler-' + String(coupon.id || Math.random().toString(36).slice(2)),
        title: '凑单品（系统建议）',
        price: fromCents(gap),
        qty: 1,
        shop: coupon.scope === 'shop' ? coupon.target : '',
        category: coupon.scope === 'category' ? coupon.target : '',
        isFiller: true
      };
      var clone = {};
      Object.keys(cart).forEach(function (key) {
        clone[key] = cart[key];
      });
      clone.items = (cart.items || []).concat(filler);
      var next = optimizeCart(clone);
      var saving = result.plan.payableCents - next.plan.payableCents;
      if (saving > 0 && (!best || saving > best.savingCents)) {
        best = {
          couponId: String(coupon.id || ''),
          title: coupon.title || '门槛券',
          gapCents: gap,
          savingCents: saving,
          newPayableCents: next.plan.payableCents,
          filler: filler
        };
      }
    });

    return best;
  }

  // ---------------------------------------------------------------------------
  // 分享口令解析（尽力而为，解析后仍需用户确认）
  // ---------------------------------------------------------------------------

  function detectPlatform(text, hint) {
    if (hint === 'taobao' || hint === 'meituan') return hint;
    var s = normalizeText(text).toLowerCase();
    var taobaoAt = s.search(/taobao|tmall|淘宝|天猫|淘口令/);
    var meituanAt = s.search(/meituan|美团|外卖|点评/);
    if (taobaoAt < 0 && meituanAt < 0) return '';
    if (taobaoAt < 0) return 'meituan';
    if (meituanAt < 0) return 'taobao';
    return taobaoAt <= meituanAt ? 'taobao' : 'meituan';
  }

  function extractLink(text) {
    var match = normalizeText(text).match(/https?:\/\/[^\s，。；、】」)）>]+/i);
    return match ? match[0].replace(/[.,;!?]+$/, '') : '';
  }

  function parsePrice(text) {
    var s = normalizeText(text);
    var patterns = [
      /(?:券后价?|到手价?|实付|预估到手|应付|券后)\s*[:：]?\s*[¥]?\s*(\d+(?:\.\d{1,2})?)/i,
      /(?:现价|价格|售价|单价|低至)\s*[:：]?\s*[¥]?\s*(\d+(?:\.\d{1,2})?)/i,
      /[¥]\s*(\d+(?:\.\d{1,2})?)/
    ];
    for (var i = 0; i < patterns.length; i++) {
      var match = s.match(patterns[i]);
      if (match) {
        var n = Number(match[1]);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    return 0;
  }

  function parseCoupons(text) {
    var s = normalizeText(text);
    var found = [];
    var seen = new Set();

    function push(coupon) {
      var key = [coupon.type, coupon.threshold || 0, coupon.value || 0, coupon.zhe || 0].join('|');
      if (seen.has(key)) return;
      seen.add(key);
      found.push(coupon);
    }

    var perRe = /每满\s*(\d+(?:\.\d+)?)\s*减\s*(\d+(?:\.\d+)?)/g;
    var m;
    while ((m = perRe.exec(s)) !== null) {
      push({
        title: '每满' + m[1] + '减' + m[2],
        type: 'per',
        threshold: Number(m[1]),
        value: Number(m[2]),
        scope: 'all',
        target: '',
        stackGroup: '',
        mode: 'parallel'
      });
    }

    var minusRe = /满\s*(\d+(?:\.\d+)?)\s*减\s*(\d+(?:\.\d+)?)/g;
    while ((m = minusRe.exec(s)) !== null) {
      // 跳过“每满…”里的“满”，避免同一张券被识别两次。
      if (m.index > 0 && s.charAt(m.index - 1) === '每') continue;
      push({
        title: '满' + m[1] + '减' + m[2],
        type: 'minus',
        threshold: Number(m[1]),
        value: Number(m[2]),
        scope: 'all',
        target: '',
        stackGroup: '',
        mode: 'parallel'
      });
    }

    var cashRe = /(\d+(?:\.\d+)?)\s*元券/g;
    while ((m = cashRe.exec(s)) !== null) {
      push({
        title: m[1] + '元券',
        type: 'minus',
        threshold: 0,
        value: Number(m[1]),
        scope: 'all',
        target: '',
        stackGroup: '',
        mode: 'parallel'
      });
    }

    var zheRe = /(\d+(?:\.\d+)?)\s*折/g;
    while ((m = zheRe.exec(s)) !== null) {
      var zhe = Number(m[1]);
      if (zhe > 0 && zhe < 10) {
        push({
          title: m[1] + '折',
          type: 'percent',
          threshold: 0,
          value: 0,
          zhe: zhe,
          scope: 'all',
          target: '',
          stackGroup: '',
          mode: 'parallel'
        });
      }
    }

    return found;
  }

  function cleanTitleCandidate(value) {
    var s = normalizeText(value)
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/[¥]\s*\d+(?:\.\d{1,2})?/g, ' ')
      .replace(/(?:券后价?|到手价?|实付|现价|价格|售价|单价)\s*[:：]?\s*\d+(?:\.\d{1,2})?/gi, ' ')
      .replace(/满\s*\d+(?:\.\d+)?\s*减\s*\d+(?:\.\d+)?/g, ' ')
      .replace(/每满\s*\d+(?:\.\d+)?\s*减\s*\d+(?:\.\d+)?/g, ' ')
      .replace(/\d+(?:\.\d+)?\s*元券/g, ' ')
      .replace(/\d+(?:\.\d+)?\s*折/g, ' ')
      .replace(/[【】「」『』]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[：:，,。.\-—|/]+|[：:，,。.\-—|/]+$/g, '')
      .trim();
    return s;
  }

  function parseTitle(text) {
    var s = normalizeText(text);
    var candidates = [];
    var bracketRe = /[【「『]([^】」』]{2,80})[】」』]/g;
    var m;
    while ((m = bracketRe.exec(s)) !== null) {
      var value = cleanTitleCandidate(m[1]);
      if (value && !/^(淘宝|天猫|美团|京东|拼多多|抖音|优惠|广告|分享|商品)$/.test(value)) {
        candidates.push(value);
      }
    }

    var lines = s.split(/\r?\n|[。！!]/).map(cleanTitleCandidate).filter(Boolean);
    lines.forEach(function (line) {
      if (line.length >= 4 && line.length <= 80 && /[\u4e00-\u9fa5A-Za-z]/.test(line)) {
        if (!/^(淘宝|天猫|美团|京东|拼多多|抖音|点击|打开|复制|分享|领券|购买|下单)/.test(line)) {
          candidates.push(line);
        }
      }
    });

    candidates.sort(function (a, b) {
      return b.length - a.length;
    });
    return candidates[0] || '未命名商品';
  }

  function parseShop(text) {
    var s = normalizeText(text);
    var match = s.match(
      /(?:店铺|商家|门店)\s*[:：]\s*([^\n，,。;；|]+?)(?=\s*(?:到手价|券后|实付|现价|价格|售价|满\s*\d|¥|https?:|$))/
    );
    return match ? match[1].trim() : '';
  }

  function parseShareText(text, platformHint) {
    var raw = String(text == null ? '' : text);
    var platform = detectPlatform(raw, platformHint);
    var coupons = parseCoupons(raw);
    var price = parsePrice(raw);
    return {
      platform: platform,
      title: parseTitle(raw),
      price: price,
      shop: parseShop(raw),
      link: extractLink(raw),
      coupons: coupons,
      raw: raw,
      ok: !!(platform || price || coupons.length)
    };
  }

  return {
    CENTS: CENTS,
    PLATFORM_META: PLATFORM_META,
    COUPON_TYPE_META: COUPON_TYPE_META,
    STACK_GROUPS: STACK_GROUPS,
    toCents: toCents,
    fromCents: fromCents,
    money: money,
    normalizeText: normalizeText,
    couponType: couponType,
    couponMode: couponMode,
    couponGroupKey: couponGroupKey,
    couponThresholdCents: couponThresholdCents,
    couponValueCents: couponValueCents,
    createState: createState,
    applyCoupon: applyCoupon,
    snapshot: snapshot,
    optimizeCart: optimizeCart,
    compareCarts: compareCarts,
    suggestFiller: suggestFiller,
    parseShareText: parseShareText,
    parsePrice: parsePrice,
    parseCoupons: parseCoupons,
    parseTitle: parseTitle,
    detectPlatform: detectPlatform
  };
});
