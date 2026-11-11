/**
 * 省算 · 三平台搜索结果处理
 * 纯函数，可在浏览器和 Node 中运行。
 *
 * 数据来自第三方公开索引接口，字段包括：
 * sourceType(1 淘宝/天猫, 2 京东, 3 拼多多)、title、actualPrice、
 * originalPrice、couponPrice、monthSales、goodsId 等。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SuanSearch = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PLATFORMS = Object.freeze({
    taobao: { id: 'taobao', name: '淘宝 / 天猫', short: '淘', color: '#f45613' },
    jd: { id: 'jd', name: '京东', short: '京', color: '#e1251b' },
    pdd: { id: 'pdd', name: '拼多多', short: '拼', color: '#e02e24' }
  });

  var SOURCE_TO_PLATFORM = { 1: 'taobao', 2: 'jd', 3: 'pdd' };
  var PLATFORM_ORDER = ['taobao', 'jd', 'pdd'];

  var ACCESSORY_WORDS = [
    '保护套',
    '保护壳',
    '手机壳',
    '耳机壳',
    '钢化膜',
    '贴膜',
    '数据线',
    '充电线',
    '充电器',
    '支架',
    '收纳',
    '键帽',
    '拔键器',
    '手托',
    '腕托',
    '防尘罩',
    '桌垫',
    '替换',
    '单只',
    '补配',
    '配件',
    '适用'
  ];

  var CONDITION_WORDS = [
    '二手',
    '翻新',
    '拆机',
    '仅激活',
    '已激活',
    '展示机',
    '权益机',
    '资源机',
    '官换机',
    '官翻',
    '99新',
    '95新',
    '美版',
    '港版',
    '日版',
    '欧版',
    '有锁',
    '卡贴'
  ];

  function normalizeText(value) {
    return String(value == null ? '' : value)
      .replace(/[\uFF01-\uFF5E]/g, function (ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
      })
      .replace(/\s+/g, ' ')
      .trim();
  }

  function compact(value) {
    return normalizeText(value).toLowerCase().replace(/\s+/g, '');
  }

  function round2(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
  }

  function parseSales(value) {
    if (typeof value === 'number') return Math.max(0, value);
    var text = String(value == null ? '' : value).replace(/,/g, '').replace(/\+/g, '');
    var match = text.match(/(\d+(?:\.\d+)?)\s*万/);
    if (match) return Math.round(Number(match[1]) * 10000);
    match = text.match(/(\d+(?:\.\d+)?)/);
    return match ? Math.round(Number(match[1])) : 0;
  }

  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var sourceType = Number(raw.sourceType);
    var platform = SOURCE_TO_PLATFORM[sourceType];
    if (!platform) return null;
    var title = normalizeText(raw.title);
    if (!title) return null;

    var price = Number(raw.actualPrice);
    var original = Number(raw.originalPrice);
    if (!Number.isFinite(price) || price <= 0) price = original;
    if (!Number.isFinite(price) || price <= 0) return null;
    if (!Number.isFinite(original) || original <= 0) original = price;

    var coupon = Math.max(0, Number(raw.couponPrice) || 0);
    var sales = parseSales(raw.monthSales);
    var goodsId = raw.goodsId != null ? String(raw.goodsId) : '';
    var id = platform + ':' + goodsId;

    return {
      id: id,
      goodsId: goodsId,
      sourceType: sourceType,
      platform: platform,
      platformName: PLATFORMS[platform].name,
      title: title,
      shop: normalizeText(raw.shopName),
      image: String(raw.picUrl || raw.goodsBannerList && raw.goodsBannerList[0] || ''),
      price: round2(price),
      original: round2(Math.max(original, price)),
      coupon: round2(coupon),
      saved: round2(Math.max(0, original - price)),
      hasCoupon: coupon > 0,
      sales: sales,
      salesText: sales > 0 ? '已售 ' + formatSales(sales) : '',
      score: 0,
      raw: raw
    };
  }

  function formatSales(value) {
    var n = Number(value) || 0;
    if (n >= 10000) return (n / 10000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '') + '万';
    return String(n);
  }

  function relevanceScore(item, query) {
    var q = compact(query);
    var t = compact(item && item.title);
    if (!q || !t) return 0;

    var score = 0;
    if (t.indexOf(q) >= 0) score += 90;

    var tokens = normalizeText(query)
      .toLowerCase()
      .split(/[\s,，、/|]+/)
      .map(compact)
      .filter(function (token) {
        return token.length > 0;
      });
    tokens.forEach(function (token) {
      if (token !== q && t.indexOf(token) >= 0) score += 25;
    });

    // 中文查询按二字组打分，处理“机械键盘”这类没有空格的词。
    if (/[\u4e00-\u9fff]/.test(q) && q.length >= 2) {
      var grams = [];
      for (var i = 0; i < q.length - 1; i++) grams.push(q.slice(i, i + 2));
      var hits = grams.filter(function (gram) {
        return t.indexOf(gram) >= 0;
      }).length;
      score += Math.round((45 * hits) / Math.max(1, grams.length));
    }

    var queryAccessory = ACCESSORY_WORDS.some(function (word) {
      return q.indexOf(word) >= 0;
    });
    var titleAccessory = ACCESSORY_WORDS.some(function (word) {
      return t.indexOf(word) >= 0;
    });
    if (titleAccessory && !queryAccessory) score -= 220;

    var expired = CONDITION_WORDS.some(function (word) {
      return t.indexOf(word) >= 0;
    });
    var queryCondition = CONDITION_WORDS.some(function (word) {
      return q.indexOf(word) >= 0;
    });
    // 默认只比较全新正品；用户明确搜“美版/二手”时不惩罚。
    if (expired && !queryCondition) score -= 170;

    if (/单只|补配|替换/.test(t) && !/单只|补配|替换/.test(q)) score -= 60;

    return score;
  }

  function filterAndRank(rawItems, query, options) {
    var opts = options || {};
    var max = opts.max || 60;
    var minScore = opts.minScore == null ? 40 : opts.minScore;
    var seen = new Set();
    var scored = [];

    (Array.isArray(rawItems) ? rawItems : []).forEach(function (raw) {
      var item = normalizeItem(raw);
      if (!item) return;
      var key = item.platform + ':' + (item.goodsId || item.title);
      if (seen.has(key)) return;
      seen.add(key);
      item.score = relevanceScore(item, query);
      if (item.score >= minScore) scored.push(item);
    });

    // 只有完全没有结果时才放宽阈值；宁可少给，也不把“机械手感”这类
    // 近似词或配件硬塞进最低价。
    if (scored.length === 0) {
      var relaxed = [];
      (Array.isArray(rawItems) ? rawItems : []).forEach(function (raw) {
        var item = normalizeItem(raw);
        if (!item) return;
        item.score = relevanceScore(item, query);
        if (item.score < 1) return;
        var key = item.platform + ':' + (item.goodsId || item.title);
        if (relaxed.some(function (current) { return current.id === key; })) return;
        relaxed.push(item);
      });
      if (relaxed.length > scored.length) scored = relaxed;
    }

    return scored
      .sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        if (a.price !== b.price) return a.price - b.price;
        return b.sales - a.sales;
      })
      .slice(0, max);
  }

  function sortItems(items, mode) {
    var list = (items || []).slice();
    if (mode === 'sales') {
      list.sort(function (a, b) {
        if (b.sales !== a.sales) return b.sales - a.sales;
        return a.price - b.price;
      });
    } else if (mode === 'relevance') {
      list.sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        return a.price - b.price;
      });
    } else {
      list.sort(function (a, b) {
        if (a.price !== b.price) return a.price - b.price;
        if (b.score !== a.score) return b.score - a.score;
        return b.sales - a.sales;
      });
    }
    return list;
  }

  function summarize(items) {
    var platforms = { taobao: null, jd: null, pdd: null };
    (items || []).forEach(function (item) {
      if (!platforms[item.platform]) {
        platforms[item.platform] = item;
        return;
      }
      if (item.price < platforms[item.platform].price) {
        platforms[item.platform] = item;
      }
    });

    var active = PLATFORM_ORDER.map(function (platform) {
      return platforms[platform];
    })
      .filter(Boolean)
      .sort(function (a, b) {
        return a.price - b.price;
      });

    return {
      platforms: platforms,
      active: active,
      winner: active[0] || null,
      second: active[1] || null,
      difference: active[1] ? round2(active[1].price - active[0].price) : 0,
      total: (items || []).length
    };
  }

  function platformSearchUrl(platform, query) {
    var q = encodeURIComponent(normalizeText(query));
    if (platform === 'jd') return 'https://search.jd.com/Search?keyword=' + q + '&enc=utf-8';
    if (platform === 'pdd') return 'https://mobile.yangkeduo.com/search_result.html?search_key=' + q;
    return 'https://s.taobao.com/search?q=' + q;
  }

  function platformCounts(items) {
    var counts = { taobao: 0, jd: 0, pdd: 0 };
    (items || []).forEach(function (item) {
      if (counts[item.platform] != null) counts[item.platform] += 1;
    });
    return counts;
  }

  return {
    PLATFORMS: PLATFORMS,
    PLATFORM_ORDER: PLATFORM_ORDER,
    SOURCE_TO_PLATFORM: SOURCE_TO_PLATFORM,
    normalizeText: normalizeText,
    normalizeItem: normalizeItem,
    relevanceScore: relevanceScore,
    filterAndRank: filterAndRank,
    sortItems: sortItems,
    summarize: summarize,
    platformSearchUrl: platformSearchUrl,
    platformCounts: platformCounts,
    parseSales: parseSales,
    formatSales: formatSales
  };
});
