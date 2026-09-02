'use strict';

const MONTHS = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];

const FAMILY_ORDER = [
  { id: 'icecream', label: 'آيس كريم' },
  { id: 'cotton', label: 'غزل البنات' },
  { id: 'donut', label: 'دونات' },
  { id: 'sandwich', label: 'سندوتشات' },
  { id: 'water', label: 'مياه' },
  { id: 'soda', label: 'مياه غازية' },
  { id: 'other', label: 'أصناف أخرى' }
];

function foldName(value) {
  return String(value || '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[\u064B-\u065F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function productFamily(name) {
  const n = foldName(name);
  if (!n) return 'other';
  if (/غزل/.test(n)) return 'cotton';
  if (/دونات|donut/.test(n)) return 'donut';
  if (/ساندوتش|سندوتش|ساندويتش|توست|toast|sandwich/.test(n)) return 'sandwich';
  if (/غازي|صودا|كولا|بيبسي|سبرايت|فانتا|soda/.test(n)) return 'soda';
  if (/مياه|ماء|water/.test(n)) return 'water';
  if (/ايس\s*كريم|ايسكريم|صنداي|كبايه|كباية/.test(n)) return 'icecream';
  if (/(^| )كون( |$)/.test(` ${n} `) || /كوب (صغير|كبير)/.test(n)) return 'icecream';
  return 'other';
}

function familyLabel(id) {
  const row = FAMILY_ORDER.find(item => item.id === id);
  return row ? row.label : 'أصناف أخرى';
}

function monthLabel(key) {
  const [year, month] = String(key || '').split('-').map(Number);
  if (!year || !month) return '';
  return `${MONTHS[month - 1]} ${year}`;
}

function daysInMonth(key) {
  const [year, month] = String(key || '').split('-').map(Number);
  if (!year || !month) return 30;
  return new Date(year, month, 0).getDate();
}

function nextMonthKey(key) {
  const [year, month] = String(key || '').split('-').map(Number);
  if (!year || !month) return '';
  const date = new Date(year, month, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function itemQty(item) {
  return Number(item && (item.quantity != null ? item.quantity : item.qty) || 0);
}

function salePieceCount(sale) {
  const items = sale && sale.items;
  if (Array.isArray(items) && items.length) {
    return items.reduce((sum, item) => sum + itemQty(item), 0);
  }
  if (sale && sale.item_qty != null && sale.item_qty !== '') return Number(sale.item_qty) || 0;
  return 0;
}

function mergeSaleLists(primary, extra) {
  const byId = new Map();
  for (const sale of extra || []) {
    if (sale && sale.source_id != null && sale.source_id !== '') {
      byId.set(String(sale.source_id), sale);
    }
  }
  const seen = new Set();
  const out = [];
  for (const sale of primary || []) {
    const id = sale && sale.source_id != null && sale.source_id !== '' ? String(sale.source_id) : '';
    const hist = id ? byId.get(id) : null;
    if (id) seen.add(id);
    if (!hist) {
      out.push(sale);
      continue;
    }
    const items = (sale.items && sale.items.length) ? sale.items : (hist.items || []);
    const merged = { ...hist, ...sale, items };
    merged.item_qty = salePieceCount(merged);
    out.push(merged);
  }
  for (const sale of extra || []) {
    const id = sale && sale.source_id != null && sale.source_id !== '' ? String(sale.source_id) : '';
    if (id && !seen.has(id)) out.push(sale);
  }
  return out;
}

function itemTotal(item) {
  if (item && item.line_total != null && item.line_total !== '') return Number(item.line_total) || 0;
  return itemQty(item) * (Number(item && item.price) || 0);
}

function monthProductMix(sales) {
  const families = {};
  FAMILY_ORDER.forEach(item => {
    families[item.id] = { id: item.id, label: item.label, qty: 0, total: 0 };
  });
  const skus = {};
  (sales || []).forEach(sale => {
    if (sale && sale.voided) return;
    (sale.items || []).forEach(item => {
      const qty = itemQty(item);
      const total = itemTotal(item);
      const name = String(item && item.name || 'صنف').trim() || 'صنف';
      const family = productFamily(name);
      if (!families[family]) families[family] = { id: family, label: familyLabel(family), qty: 0, total: 0 };
      families[family].qty += qty;
      families[family].total += total;
      const sku = skus[name] || (skus[name] = { name, qty: 0, total: 0, family });
      sku.qty += qty;
      sku.total += total;
    });
  });
  const familyList = FAMILY_ORDER
    .map(item => families[item.id])
    .filter(item => item.id !== 'other' || item.qty > 0 || item.total > 0);
  const skuList = Object.values(skus).sort((a, b) => b.qty - a.qty || b.total - a.total);
  const byMoney = skuList.slice().sort((a, b) => b.total - a.total || b.qty - a.qty);
  const topFamily = familyList.slice().sort((a, b) => b.qty - a.qty || b.total - a.total)[0] || null;
  const pieces = familyList.reduce((sum, item) => sum + item.qty, 0);
  return {
    families: familyList,
    skus: skuList,
    best: skuList[0] || null,
    bestMoney: byMoney[0] || null,
    topFamily,
    pieces
  };
}

function monthOutlook(sales, monthKey) {
  const days = new Set();
  let revenue = 0;
  (sales || []).forEach(sale => {
    if (!sale || sale.voided) return;
    revenue += Number(sale.total || 0);
    const stamp = sale.sold_at instanceof Date ? sale.sold_at : new Date(sale.sold_at || '');
    if (!Number.isNaN(stamp.getTime())) {
      days.add(`${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')}`);
      return;
    }
    const day = String(sale.sold_at || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) days.add(day);
  });
  const soldDays = days.size;
  const avgDaily = soldDays ? revenue / soldDays : 0;
  const nextKey = nextMonthKey(monthKey);
  return {
    soldDays,
    revenue,
    avgDaily,
    nextKey,
    nextLabel: monthLabel(nextKey),
    nextDays: daysInMonth(nextKey),
    forecast: Math.round(avgDaily * daysInMonth(nextKey))
  };
}

const AccountsMix = {
  FAMILY_ORDER,
  foldName,
  productFamily,
  familyLabel,
  monthLabel,
  daysInMonth,
  nextMonthKey,
  itemQty,
  salePieceCount,
  mergeSaleLists,
  monthProductMix,
  monthOutlook
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AccountsMix;
}
if (typeof window !== 'undefined') {
  window.AccountsMix = AccountsMix;
}
