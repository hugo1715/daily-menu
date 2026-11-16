#!/usr/bin/env node
/**
 * 抓取每道菜「B 站播放量最高的教程」的封面，落到 public/images/covers/<id>.webp
 *
 * 设计：
 * - 用 WBI 签名的搜索接口，关键词「菜名 做法」，取播放量最高且标题包含菜名的视频；
 * - 封面走 B 站图片处理参数 @672w_378h_1c.webp —— 服务端直接裁成 16:9，体积约 50KB；
 * - 结果写入 data/covers.json（含 bvid / 标题 / 播放量 / 作者），便于追溯与人工复核；
 * - 已存在且未加 --force 的菜品会跳过，避免重复抓取。
 *
 * 用法：
 *   node scripts/fetch-covers.mjs            # 只补缺失的
 *   node scripts/fetch-covers.mjs --force    # 全部重抓
 *   node scripts/fetch-covers.mjs --only m13,s01
 *
 * 说明：这一步只在需要更新封面时手工跑一次（本地或 Actions 均可），
 * 生成器本身不联网，线上部署不依赖 B 站可用性。
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const COVER_DIR = path.join(ROOT, 'public', 'images', 'covers');
const COVERS_FILE = path.join(DATA_DIR, 'covers.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const COVER_PARAM = '@672w_378h_1c.webp';
const DELAY_MS = 700;
const RETRIES = 3;

const args = process.argv.slice(2);
const force = args.includes('--force');
const onlyArg = args.find((a) => a.startsWith('--only'));
const onlyIds = onlyArg
  ? new Set((onlyArg.includes('=') ? onlyArg.split('=')[1] : args[args.indexOf(onlyArg) + 1] || '').split(',').map((s) => s.trim()).filter(Boolean))
  : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

const mixinKey = (orig) => MIXIN_TAB.map((n) => orig[n]).join('').slice(0, 32);

async function fetchJson(url, referer) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: referer,
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getWbiKey() {
  const json = await fetchJson('https://api.bilibili.com/x/web-interface/nav', 'https://www.bilibili.com/');
  const img = json?.data?.wbi_img?.img_url?.split('/').pop()?.split('.')[0];
  const sub = json?.data?.wbi_img?.sub_url?.split('/').pop()?.split('.')[0];
  if (!img || !sub) throw new Error('拿不到 WBI 密钥');
  return mixinKey(img + sub);
}

async function searchVideos(keyword, key) {
  const params = new URLSearchParams({
    search_type: 'video',
    keyword,
    page: '1',
    page_size: '20',
  });
  params.set('wts', String(Math.floor(Date.now() / 1000)));

  const sorted = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const query = sorted
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v.replace(/[!'()*]/g, ''))}`)
    .join('&');
  const wRid = createHash('md5').update(query + key).digest('hex');

  const json = await fetchJson(
    `https://api.bilibili.com/x/web-interface/wbi/search/type?${query}&w_rid=${wRid}`,
    'https://search.bilibili.com/',
  );
  if (json.code !== 0) throw new Error(`搜索失败 code=${json.code} ${json.message ?? ''}`);
  return json.data?.result ?? [];
}

const stripTags = (s) => String(s ?? '')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>');

/** 容易跟炒菜混淆的品类词：标题里出现、菜名里却没有，就判为不是同一道菜 */
const CONFUSABLE = ['米线', '米粉', '拌面', '汤面', '盖饭', '炒饭', '馒头', '饺子', '包子', '火锅', '麻辣烫', '烧烤', '意面', '披萨', '寿司', '汉堡'];

/** 候选列表：标题必须包含完整菜名，且该视频没被别的菜用过；按播放量降序 */
function rankCandidates(results, dishName, usedBvids) {
  return results
    .map((v) => ({
      bvid: v.bvid,
      title: stripTags(v.title),
      play: Number(v.play) || 0,
      author: v.author,
      pic: v.pic?.startsWith('//') ? `https:${v.pic}` : v.pic,
    }))
    .filter((v) => v.bvid && v.pic && v.play > 0)
    .filter((v) => v.title.includes(dishName))
    .filter((v) => !CONFUSABLE.some((w) => v.title.includes(w) && !dishName.includes(w)))
    .filter((v) => !usedBvids.has(v.bvid))
    .sort((a, b) => b.play - a.play);
}

async function downloadCover(picUrl, id) {
  const url = picUrl + COVER_PARAM;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' } });
  if (!res.ok) throw new Error(`封面 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2000) throw new Error(`封面过小 ${buf.length}B`);
  await writeFile(path.join(COVER_DIR, `${id}.webp`), buf);
  return buf.length;
}

async function withRetry(fn, label) {
  let lastErr;
  for (let i = 1; i <= RETRIES; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < RETRIES) await sleep(1200 * i);
    }
  }
  throw new Error(`${label}: ${lastErr.message}`);
}

async function main() {
  await mkdir(COVER_DIR, { recursive: true });

  const raw = await readFile(path.join(DATA_DIR, 'dishes.psv'), 'utf8');
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const dishes = lines.slice(1).map((line) => {
    const c = line.split('|');
    return { id: c[0].trim(), name: c[1].trim(), category: c[2].trim() };
  });

  let covers = { updatedAt: null, source: 'bilibili-search', items: {} };
  try {
    covers = JSON.parse(await readFile(COVERS_FILE, 'utf8'));
  } catch { /* 首次运行 */ }

  const key = await withRetry(getWbiKey, 'WBI 密钥');

  const targets = dishes.filter((d) => {
    if (onlyIds && !onlyIds.has(d.id)) return false;
    if (force) return true;
    return !covers.items?.[d.id]?.cover;
  });

  console.log(`待抓取 ${targets.length} 道（共 ${dishes.length} 道）`);
  let ok = 0;
  const failed = [];
  const usedBvids = new Set(
    Object.entries(covers.items ?? {})
      .filter(([id]) => !targets.some((t) => t.id === id))
      .map(([, v]) => v.bvid)
      .filter(Boolean),
  );

  for (const [i, dish] of targets.entries()) {
    const tag = `[${i + 1}/${targets.length}] ${dish.name}`;
    try {
      // 先用「菜名 做法」，没有标题匹配的再换关键词多试两轮
      let candidates = [];
      for (const keyword of [`${dish.name} 做法`, dish.name, `${dish.name} 家常做法`]) {
        candidates = rankCandidates(await searchVideos(keyword, key), dish.name, usedBvids);
        if (candidates.length) break;
        await sleep(DELAY_MS);
      }
      if (!candidates.length) throw new Error('没有标题匹配的视频');

      // 封面太小（多半是纯色/低质图）就换下一条候选
      let picked = null;
      let bytes = 0;
      for (const c of candidates.slice(0, 3)) {
        const size = await withRetry(() => downloadCover(c.pic, dish.id), `${tag} 封面`);
        if (size >= 8000) { picked = c; bytes = size; break; }
        await sleep(300);
      }
      if (!picked) throw new Error('候选封面都过小');

      usedBvids.add(picked.bvid);
      covers.items = covers.items ?? {};
      covers.items[dish.id] = {
        cover: `images/covers/${dish.id}.webp`,
        bvid: picked.bvid,
        title: picked.title,
        play: picked.play,
        author: picked.author,
        bytes,
        fetchedAt: new Date().toISOString(),
      };
      ok += 1;
      console.log(`${tag}  ✅ ${picked.play}播放  ${picked.title.slice(0, 24)}  (${Math.round(bytes / 1024)}KB)`);
    } catch (err) {
      failed.push({ id: dish.id, name: dish.name, error: err.message });
      console.log(`${tag}  ❌ ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  covers.updatedAt = new Date().toISOString();
  await writeFile(COVERS_FILE, `${JSON.stringify(covers, null, 2)}\n`, 'utf8');

  console.log(`\n完成：成功 ${ok}，失败 ${failed.length}，累计 ${Object.keys(covers.items ?? {}).length} 道有封面`);
  if (failed.length) console.log('失败清单：', failed.map((f) => `${f.id}${f.name}`).join('、'));
}

main().catch((err) => {
  console.error(`❌ 抓取失败：${err.message}`);
  process.exit(1);
});
