#!/usr/bin/env node
/**
 * 今日开锅 / Daily Wok —— 每日菜单生成器
 *
 * 读取 data/dishes.psv（菜品库）+ data/history.json（推荐历史），
 * 按北京时间生成当天菜单，写入 public/data/today.json，并追加一条历史记录。
 *
 * 设计要点：
 * 1. 同一天重复运行不会重新选菜（历史里已有当天记录时直接复用）。
 * 2. 选菜使用「日期做种子的伪随机」，因此即使历史丢失，同一天重跑结果也稳定。
 * 3. 每类优先避开最近 windowDays 天出现过的菜，超过窗口则退化为「最久未用优先」。
 *
 * 用法：node scripts/generate-daily.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const TZ = 'Asia/Shanghai';
const PICK_PER_CATEGORY = 3;
const RECENT_DAYS = 7;
const MAX_HISTORY_DAYS = 400;
const DEFAULT_WINDOW_DAYS = 9;
const PSV_FIELDS = ['id', 'name', 'category', 'ingredients', 'minutes', 'difficulty', 'note', 'videoUrl'];

/* ---------- 工具函数 ---------- */

/** 北京时间当天，格式 YYYY-MM-DD */
function todayInTz(timeZone = TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** YYYY-MM-DD 转 UTC 毫秒（按日期零点算，仅用于日期差值） */
function dateToUtcMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** 两个日期字符串之间相差的天数（a - b） */
function diffDays(a, b) {
  return Math.round((dateToUtcMs(a) - dateToUtcMs(b)) / 86400000);
}

/** 字符串哈希，得到 32 位整数种子 */
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** 可复现的伪随机数发生器 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 用给定随机源洗牌（Fisher-Yates，返回新数组） */
function shuffle(list, rand) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function bilibiliSearch(keyword) {
  return `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`;
}

/* ---------- 读取数据 ---------- */

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Error(`读取 ${path.relative(ROOT, file)} 失败：${err.message}`);
  }
}

async function loadDishes() {
  const raw = await readFile(path.join(DATA_DIR, 'dishes.psv'), 'utf8');
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim() !== '');

  if (lines.length < 2) throw new Error('data/dishes.psv 内容为空');

  const header = lines[0].split('|').map((s) => s.trim());
  if (header.length !== PSV_FIELDS.length || header.some((h, i) => h !== PSV_FIELDS[i])) {
    throw new Error(`data/dishes.psv 表头应为：${PSV_FIELDS.join('|')}\n实际为：${lines[0]}`);
  }

  const dishes = [];
  const seenIds = new Set();

  lines.slice(1).forEach((line, index) => {
    const cells = line.split('|');
    if (cells.length !== PSV_FIELDS.length) {
      throw new Error(`data/dishes.psv 第 ${index + 2} 行字段数为 ${cells.length}，应为 ${PSV_FIELDS.length}：${line}`);
    }
    const [id, name, category, ingredients, minutes, difficulty, note, videoUrl] = cells.map((s) => s.trim());

    if (seenIds.has(id)) throw new Error(`data/dishes.psv 出现重复 id：${id}`);
    seenIds.add(id);

    const mins = Number(minutes);
    if (!Number.isFinite(mins) || mins <= 0) throw new Error(`菜品 ${id} 的 minutes 不是有效数字：${minutes}`);
    if (!['meat', 'veg', 'soup'].includes(category)) throw new Error(`菜品 ${id} 的 category 非法：${category}`);

    dishes.push({
      id,
      name,
      category,
      ingredients: ingredients.split('、').map((s) => s.trim()).filter(Boolean),
      minutes: mins,
      difficulty,
      note,
      videoUrl,
    });
  });

  return dishes;
}

async function loadImages() {
  // data/images.json 可选：{ "m01": "https://…jpg" }，用于替换卡片的 16:9 占位插画
  const file = path.join(DATA_DIR, 'images.json');
  const map = await readJson(file, {});
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error('data/images.json 应为 { "菜品id": "图片URL" } 形式的对象');
  }
  return map;
}

async function loadCategories() {
  const categories = await readJson(path.join(DATA_DIR, 'categories.json'));
  if (!Array.isArray(categories) || categories.length === 0) throw new Error('data/categories.json 应为非空数组');
  const keys = categories.map((c) => c.key);
  if (new Set(keys).size !== keys.length) throw new Error('data/categories.json 存在重复 key');
  return categories;
}

async function loadHistory() {
  const file = path.join(DATA_DIR, 'history.json');
  const history = await readJson(file, { version: 1, windowDays: DEFAULT_WINDOW_DAYS, days: [] });
  if (!Array.isArray(history.days)) history.days = [];
  if (!Number.isInteger(history.windowDays) || history.windowDays <= 0) history.windowDays = DEFAULT_WINDOW_DAYS;
  return history;
}

/* ---------- 选菜 ---------- */

function pickForCategory({ category, dishes, history, today, windowDays, seed }) {
  const pool = dishes.filter((d) => d.category === category);
  if (pool.length < PICK_PER_CATEGORY) {
    throw new Error(`分类「${category}」只有 ${pool.length} 道菜，至少需要 ${PICK_PER_CATEGORY} 道`);
  }

  // 最近 windowDays 天（不含今天）已出现过的菜
  const recentIds = new Set();
  const lastUsed = new Map();
  for (const day of history.days) {
    if (!day || typeof day.date !== 'string' || !day.picks) continue;
    const ids = day.picks[category] ?? [];
    const gap = diffDays(today, day.date);
    if (gap >= 0 && gap <= windowDays) ids.forEach((id) => recentIds.add(id));
    ids.forEach((id) => {
      const prev = lastUsed.get(id);
      if (!prev || day.date > prev) lastUsed.set(id, day.date);
    });
  }

  const rand = mulberry32(hashSeed(`${today}#${category}#${seed}`));
  const eligible = shuffle(pool.filter((d) => !recentIds.has(d.id)), rand);

  const chosen = eligible.slice(0, PICK_PER_CATEGORY);

  // 窗口内可用的菜不够 3 道时，按「最久未使用」补足
  if (chosen.length < PICK_PER_CATEGORY) {
    const chosenIds = new Set(chosen.map((d) => d.id));
    const fallback = pool
      .filter((d) => !chosenIds.has(d.id))
      .sort((a, b) => {
        const ua = lastUsed.get(a.id) ?? '0000-00-00';
        const ub = lastUsed.get(b.id) ?? '0000-00-00';
        return ua < ub ? -1 : ua > ub ? 1 : a.id < b.id ? -1 : 1;
      });
    for (const dish of fallback) {
      if (chosen.length >= PICK_PER_CATEGORY) break;
      chosen.push(dish);
    }
  }

  return chosen;
}

function buildDishView(dish, imageUrl) {
  const keyword = `${dish.name} 电炒锅 教程`;
  const url = dish.videoUrl || bilibiliSearch(keyword);
  return {
    id: dish.id,
    name: dish.name,
    ingredients: dish.ingredients,
    minutes: dish.minutes,
    difficulty: dish.difficulty,
    note: dish.note,
    videoUrl: url,
    videoSource: dish.videoUrl ? 'fixed' : 'search',
    imageUrl: imageUrl ?? '',
  };
}

/* ---------- 主流程 ---------- */

async function main() {
  const dishes = await loadDishes();
  const categories = await loadCategories();
  const history = await loadHistory();
  const images = await loadImages();
  // DAILY_WOK_DATE 仅用于测试/补生成，正常运行时取北京时间当天
  const today = process.env.DAILY_WOK_DATE?.trim() || todayInTz();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`日期格式应为 YYYY-MM-DD，实际为：${today}`);
  const windowDays = history.windowDays;

  const missing = categories.filter((c) => !dishes.some((d) => d.category === c.key));
  if (missing.length) throw new Error(`以下分类没有任何菜品：${missing.map((c) => c.key).join(', ')}`);

  // 当天已有记录 → 直接复用，实现幂等
  const existing = history.days.find((day) => day && day.date === today);
  const byId = new Map(dishes.map((d) => [d.id, d]));

  let picks;
  let mode;
  if (existing && existing.picks && categories.every((c) => (existing.picks[c.key] ?? []).length === PICK_PER_CATEGORY)) {
    picks = {};
    for (const c of categories) {
      picks[c.key] = existing.picks[c.key].map((id) => {
        const dish = byId.get(id);
        if (!dish) throw new Error(`历史记录引用了不存在的菜品 id：${id}`);
        return dish;
      });
    }
    mode = 'reuse';
  } else {
    picks = {};
    for (const c of categories) {
      picks[c.key] = pickForCategory({
        category: c.key,
        dishes,
        history,
        today,
        windowDays,
        seed: 'v1',
      });
    }
    mode = 'fresh';
  }

  // 复用当天记录时，保留最初的生成时间，避免页面上的“生成于”被重跑改写
  const generatedAt = mode === 'reuse' && existing?.generatedAt ? existing.generatedAt : new Date().toISOString();

  // 最近 7 天（不含今天）的菜名，供页面「最近 7 天」区块使用
  const recent = history.days
    .filter((day) => day && typeof day.date === 'string' && day.date !== today && diffDays(today, day.date) > 0)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, RECENT_DAYS)
    .map((day) => ({
      date: day.date,
      items: Object.fromEntries(
        categories.map((c) => [
          c.key,
          (day.picks?.[c.key] ?? []).map((id) => byId.get(id)?.name).filter(Boolean),
        ]),
      ),
    }));

  // 最近 7 天的菜品 id（页面「换一换」时用来避开刚吃过的菜）
  const recentIds = Object.fromEntries(
    categories.map((c) => [
      c.key,
      [
        ...new Set(
          history.days
            .filter((day) => day && typeof day.date === 'string' && day.date !== today && diffDays(today, day.date) > 0 && diffDays(today, day.date) <= RECENT_DAYS)
            .flatMap((day) => day.picks?.[c.key] ?? []),
        ),
      ],
    ]),
  );

  const payload = {
    date: today,
    timezone: TZ,
    generatedAt,
    windowDays,
    mode,
    recent,
    recentIds,
    categories: categories.map((c) => ({
      key: c.key,
      label: c.label,
      en: c.en ?? c.key.toUpperCase(),
      note: c.note ?? '',
      accent: c.accent ?? '#b7472f',
      dishes: picks[c.key].map((dish) => buildDishView(dish, images[dish.id])),
    })),
  };

  await mkdir(path.join(PUBLIC_DIR, 'data'), { recursive: true });
  await writeFile(path.join(PUBLIC_DIR, 'data', 'today.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  // 页面的「换一换」需要候选池：输出全量菜品（含已解析的视频/图片地址）
  const pool = dishes.map((dish, index) => ({
    ...buildDishView(dish, images[dish.id]),
    category: dish.category,
    order: index,
  }));
  await writeFile(path.join(PUBLIC_DIR, 'data', 'dishes.json'), `${JSON.stringify(pool)}\n`, 'utf8');

  if (mode === 'fresh') {
    const entry = {
      date: today,
      generatedAt,
      picks: Object.fromEntries(categories.map((c) => [c.key, picks[c.key].map((d) => d.id)])),
    };
    history.days = history.days.filter((day) => day && day.date !== today);
    history.days.push(entry);
    history.days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (history.days.length > MAX_HISTORY_DAYS) history.days = history.days.slice(-MAX_HISTORY_DAYS);
    history.version = history.version ?? 1;
    history.windowDays = windowDays;
    await writeFile(path.join(DATA_DIR, 'history.json'), `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  }

  const summary = payload.categories
    .map((c) => `${c.label}：${c.dishes.map((d) => d.name).join('、')}`)
    .join('\n');
  console.log(`✅ 今日菜单已生成（${today}，${mode === 'reuse' ? '复用当天已有记录' : '新抽取'}，去重窗口 ${windowDays} 天）`);
  console.log(summary);
  console.log(`📄 输出：public/data/today.json`);
}

main().catch((err) => {
  console.error(`❌ 生成失败：${err.message}`);
  process.exit(1);
});
