# 「今日开锅」项目交接文档

| 项目项 | 内容 |
|---|---|
| 项目名称 | 今日开锅 / Daily Wok |
| 项目类型 | 个人每日菜谱推荐网站 |
| 技术方向 | GitHub Actions + GitHub Pages + 静态前端 |
| 本地目录 | `C:\Users\phoenix\Documents\daily-wok` |
| 当前状态 | ✅ 已上线：`https://hugo1715.github.io/daily-menu/`（Actions 首次运行 build + deploy 均成功） |
| 远程仓库 | `git@github.com:hugo1715/daily-menu.git`（SSH；本机 HTTPS 到 github.com 被阻断） |
| 线上站点 | `https://hugo1715.github.io/daily-menu/` |
| 文档版本 | 2026-11-08 更新（本地重写验收 → 推送 GitHub → Pages 上线验收通过） |
| 文档用途 | 交接项目背景、完成情况、风险与后续动作 |

> **与上一版的差别**：上一版记录“代码稿已准备但可能在 `setup-project.ps1` 里丢失”。
> 经核查确认属实：该文件当时是终端回显被误存，90 道菜与生成逻辑**没有任何实物留存**。
> 本次已全部重写，并在本地跑通、完成验收，验收证据见 §2.3 与 `docs/` 目录。

---

# 一、最初实现目的与核心目标

## 1.1 项目背景

日常做饭时存在三个高频问题：

1. 每天都要重新思考“吃什么”；
2. 荤菜、素菜、汤的搭配容易失衡；
3. 网上菜谱很多，但适合电炒锅、且带教学视频的菜谱需要反复筛选。

因此制作一个简洁的个人小网站，每天自动推荐固定搭配的菜式，降低日常决策成本。

## 1.2 核心目标

网站每天自动展示：

- 3 道荤菜；
- 3 道素菜；
- 3 道汤；
- 全部限定为电炒锅可以完成；
- 每道菜附带 B 站或其他视频平台的教程入口；
- 推荐结果尽量避免连续重复；
- 桌面端和移动端都能正常浏览；
- 页面视觉简洁，不做复杂社交、登录或商业化功能。

## 1.3 预期使用效果

用户打开网站后，可以立即看到当天完整的九道菜，不需要登录、不需要手动刷新、不需要额外搜索菜谱。

理想状态如下：

1. 每天北京时间零点后自动生成新菜单；
2. 同一天内所有访客看到同一份菜单；
3. 系统记录推荐历史，短期内不重复推荐；
4. 每道菜有名称、主要食材、预计用时、难度标签和教学视频入口；
5. 手机上单列阅读，桌面端三列浏览；
6. 不依赖数据库，不产生服务器费用。

## 1.4 明确不包含的范围

当前版本不包含：用户注册登录、收藏点赞评论、个性化推荐、食材库存管理、自动抓取 B 站/抖音视频、付费商业化、真正的实时后端。

---

# 二、目前状况

## 2.1 技术方案（已落地）

```text
GitHub Actions（每天 UTC 16:05 = 北京时间 00:05）
  ↓ node scripts/generate-daily.mjs
读取 data/dishes.psv（90 道）+ data/history.json（推荐历史）
  ↓
生成 public/data/today.json，把当天选菜结果写回 history.json
  ↓
自动 commit 回仓库
  ↓
public/ 打包部署到 GitHub Pages
  ↓
浏览器读取 data/today.json 渲染
```

### 关键决策

| 项目 | 方案 |
|---|---|
| 菜品数量 | 90 道，荤菜/素菜/汤各 30 道 |
| 每日推荐 | 每类 3 道，共 9 道 |
| 去重策略 | 优先避开最近 9 天推荐过的菜（`history.json` 的 `windowDays`） |
| 时区 | Asia/Shanghai，日期由 `Intl.DateTimeFormat` 计算，不吃本机时区 |
| 定时任务 | `cron: '5 16 * * *'`（UTC）= 北京时间次日 00:05 |
| 数据存储 | `dishes.psv` + `history.json` |
| 视频策略 | 优先固定 `videoUrl`，留空则回退 B 站搜索深链 |
| 页面形式 | 单文件 HTML，内嵌 CSS 与渲染 JS |

### 实际目录结构（已落盘）

```text
daily-wok/
├─ .github/workflows/daily-menu.yml   # build（生成+提交+打包） / deploy（Pages）
├─ data/
│  ├─ categories.json                 # 三个分类：label / en / note / accent
│  ├─ dishes.psv                      # 1 行表头 + 90 行菜品，每行 8 个字段
│  └─ history.json                    # { version, windowDays, days[] }，脚本自动维护
├─ public/
│  ├─ index.html                      # 单文件页面
│  └─ data/today.json                 # 生成产物
├─ scripts/
│  ├─ generate-daily.mjs              # 菜单生成器
│  └─ preview.mjs                     # 本地静态服务器（不依赖 python）
├─ docs/
│  ├─ preview-desktop.png             # 桌面端验收截图
│  └─ preview-mobile.png              # 移动端验收截图
├─ setup-project.ps1                  # 脚手架 + 自检（可重复执行）
├─ package.json                       # scripts: generate / preview
├─ README.md
└─ .gitignore
```

### `dishes.psv` 格式

`id|name|category|ingredients|minutes|difficulty|note|videoUrl`

- `category` ∈ `meat` / `veg` / `soup`；
- `ingredients` 用顿号 `、` 分隔，前端渲染成“主料：A · B · C”；
- `minutes` 为纯数字；
- `difficulty` 只用 `简单` / `中等` / `稍难`（决定前端标签配色）；
- `videoUrl` 允许为空 → 自动生成 `https://search.bilibili.com/all?keyword=<菜名 电炒锅 教程>`；
- 字段内不得出现 `|`。

## 2.2 本次交接完成的工作

### 已重写的文件（全部为新写，非旧稿修复）

| 文件 | 说明 |
|---|---|
| `data/dishes.psv` | 90 道电炒锅菜谱，荤/素/汤各 30，含食材、用时、难度、一句话简介 |
| `scripts/generate-daily.mjs` | 北京时间取日、PSV 校验、9 天去重、日期种子伪随机、幂等复用、写 `today.json` 与 `history.json` |
| `public/index.html` | 单文件页面：三分类 × 三卡、响应式三列/两列/单列、加载骨架、等待更新与读取失败三态、每分钟轮询 |
| `.github/workflows/daily-menu.yml` | 定时 + 手动触发；生成 → 提交 → 上传产物 → 部署 Pages |
| `setup-project.ps1` | **重写为真正的脚手架+自检脚本**（上一版是终端回显），不再内嵌 90 道菜，改为校验落盘内容 |
| `scripts/preview.mjs` | 本地静态服务器，替代 `python -m http.server`（本机没有 python） |
| `README.md`、`.gitignore`、`package.json` | 使用说明、忽略规则、`generate` / `preview` 脚本 |
| `docs/preview-*.png` | 验收截图 |

### 生成器关键行为

- **幂等**：`history.json` 里已有当天记录时，直接复用，同一天重跑不换菜；
- **可复现**：选菜随机数种子 = `日期 + 分类`，即使历史丢失，同一天重算结果也一致；
- **窗口去重**：排除最近 `windowDays`（默认 9）天出现过的菜；
- **兜底**：可用菜不足 3 道时，按“最久未使用”补足；
- **校验**：表头、字段数、id 重复、分类合法性、`minutes` 数字，任一不通过直接报错退出（Actions 会红）；
- **补生成**：支持 `DAILY_WOK_DATE=2026-11-01` 环境变量指定日期（补跑漏掉的某天、或做测试）。

### 2026-11-09 增量优化（本轮）

| 优化 | 实现 | 验收 |
|---|---|---|
| 页面「最近 7 天」区块 | 生成器在 `today.json` 里输出 `recent`（前 7 天、按日期倒序、只含菜名）；页面底部渲染「日期 + 荤/素/汤三行」，窄屏自动转单列 | 桌面/移动截图，`recent` 字段与历史一致 |
| 高频菜固定视频 | `dishes.psv` 为 **12 道菜**填入 `videoUrl`，页面按钮自动变「看教学视频」 | 12 条链接均经 B 站 API 核实标题匹配、`code=0` |
| 定时任务提交信息 | 改用菜单实际日期（原为 UTC 日期，00:05 生成时会写成前一天） | 下次自动运行可验证 |

已配置固定视频的 12 道菜：青椒肉丝、番茄炒蛋、可乐鸡翅、宫保鸡丁、红烧肉、白灼虾、蒜蓉粉丝虾、手撕包菜、醋溜土豆丝、红烧茄子、番茄鸡蛋汤、紫菜蛋花汤。

## 2.3 本地验收记录

执行环境：Windows 10/11 + Windows PowerShell 5.1；Node 用 DSH 内置运行时 v24.21.0（见 §2.5 P1）。

| 验收项 | 结果 | 证据 |
|---|---|---|
| `dishes.psv` 行数 | ✅ 91 行（1 表头 + 90 菜） | `setup-project.ps1` 输出 |
| 每行字段数 | ✅ 全部 8 个 | 同上 |
| 分类分布 | ✅ meat 30 / veg 30 / soup 30，id 无重复 | 同上 |
| `npm run generate` | ✅ 成功，生成 `public/data/today.json` | 控制台输出 |
| 当天菜单 | ✅ 荤 啤酒鸭/土豆烧牛肉/香菇滑鸡；素 青椒土豆丝/酸辣白菜/家常豆腐；汤 番茄鸡蛋汤/海带排骨汤/莲藕排骨汤 | `today.json` |
| 幂等性 | ✅ 第二次运行 `mode=reuse`，菜单不变、`generatedAt` 保持首次时间 | 两次运行对比 |
| 9 天去重 | ✅ 连续模拟 12 天（11-08 → 11-19），窗口内 0 重复 | 模拟脚本输出 |
| 去重周期 | ✅ 前 10 天每类 30 道全部用满，正好 10 天一轮 | 同上去重度统计 |
| 页面加载 | ✅ `GET /` 200、`GET /data/today.json` 200、未知路径 404 | `scripts/preview.mjs` |
| 内联 JS 语法 | ✅ `node --check` 通过；CSS 花括号配平 | 静态检查 |
| 桌面布局 | ✅ 1440px 三列，页脚完整 | `docs/preview-desktop.png` |
| 移动布局 | ✅ 390px 视口单列，`scrollWidth = clientWidth = 390`，横向溢出 0 | `docs/preview-mobile.png` + 溢出测量 |
| 等待态 | ✅ 数据日期落后时显示“正在等待今日（日期）的菜单生成”，并保留旧菜单 | 状态截图 |
| 读取失败态 | ✅ 404 时显示“菜单读取失败，请稍后刷新页面重试”+ 排查提示 | 状态截图 |
| 视频链接 | ⚠️ 链接格式与 URL 编码已校验，**未逐条点开** | `today.json` 中 `videoUrl` |

### 线上验收（Pages 已上线后复核）

| 验收项 | 结果 | 证据 |
|---|---|---|
| Actions 首次运行 | ✅ run #1 `build` + `deploy` 均 success | `workflow_dispatch`，耗时约 33 秒 |
| 站点首页 | ✅ HTTP 200 `https://hugo1715.github.io/daily-menu/` | 直接抓取 |
| 线上 `data/today.json` | ✅ HTTP 200，`date=2026-11-08`、`mode=reuse`、3/3/3 | 直接抓取 |
| 线上渲染 | ✅ 无头浏览器截图与本地截图**逐字节一致**（同一份数据、同一套样式） | `live-desktop.png` |
| 生成结果回写 | ✅ `提交生成结果` 步骤执行成功（当天数据无变化，按设计跳过 commit） | Actions 步骤日志 |

## 2.4 当前进度

| 阶段 | 状态 | 说明 |
|---|---|---|
| 需求确认 | 已完成 | 功能边界明确 |
| 页面设计 | 已完成 | 含响应式与三态 |
| 菜品内容 | 已完成 | 90 道已落盘并校验 |
| 生成脚本 | 已完成 | 本地运行 + 12 天模拟通过 |
| 前端页面 | 已完成 | 桌面/移动/异常态截图验收 |
| Actions 工作流 | 已完成（未运行） | 需推送到 GitHub 后才可验证 |
| 本地文件生成 | 已完成 | 全部文件落盘 |
| 本地预览 | 已完成 | `npm run preview` |
| GitHub 仓库 | ✅ 已完成 | `hugo1715/daily-menu`，`main` 已推送（实际仓库名是 `daily-menu`，不是约定的 `daily-wok`） |
| GitHub Pages | ✅ 已完成 | Source = GitHub Actions，站点已发布 |
| 首次 Actions 运行 | ✅ 已完成 | run #1，build + deploy 均 success |
| 线上验收 | ✅ 已完成（待次日复核） | 站点 200、today.json 数据正确、渲染与本地一致 |

## 2.5 当前存在的问题

### P0：无（站点已上线）

三项配置均已完成并验证：

1. `Settings → Pages → Source = GitHub Actions` —— 站点已发布，首页与 `data/today.json` 均 200；
2. `Settings → Actions → General → Workflow permissions = Read and write` —— 「提交生成结果」步骤执行成功；
3. 手动 `Run workflow` —— run #1 的 `build` 与 `deploy` 两个 job 均 success。

唯一待观察项：**次日（2026-11-09）北京时间 00:05 的定时任务**是否自动触发、是否自动 commit 新菜单并重新部署。

### P1：本机没有可用的 Node.js / npm

- 当前会话 `PATH` 里没有 `node` / `npm` / `python`；
- 本次验收用的是 DSH 内置 Node `v24.21.0`（`C:\Users\phoenix\.dsh\dsh-runtimes\...\node\bin\node.exe`）；
- 影响：**只有在本地想手动生成/预览时才需要**；GitHub Actions 里由 `actions/setup-node` 提供 Node 20，线上不受影响。
- 处理建议：装一个 Node LTS（20 或 22）到系统 PATH；装完后 `npm run generate` 即可直接用。

同样地，`git` 已安装（`C:\Program Files\Git\cmd\git.exe`，2.56.0），但当前会话 PATH 里没有；已配置 `user.name = hugo1715`。正常终端里如果 `git` 不可用，把 Git 的 `cmd` 目录加进 PATH 即可。

### P1：本机 HTTPS 到 github.com 被阻断，已改用 SSH

- 实测 `github.com:443` 不可达（连接超时），而 `api.github.com:443`、`github.com:22`、`ssh.github.com:443` 均可达；
- 因此 `origin` 使用 SSH：`git@github.com:hugo1715/daily-menu.git`，本机公钥已加入 GitHub 账号；
- 影响：`git push/pull` 正常，但**不能用 HTTPS 地址克隆或推送**；换机器/换网络时需重新处理（有可用代理时可临时切回 HTTPS）。

### P1：视频链接不是精确视频

默认全部走 B 站搜索深链（`菜名 + 电炒锅 + 教程`），没有为任何菜品绑定具体视频。

风险：搜索结果会变、需要用户自己挑、不保证第一条合适。
改进：在 `dishes.psv` 里给高优先级菜品填 `videoUrl`（页面会自动把按钮文案改成“看教学视频”），并定期抽查失效链接。

### P1：Actions 定时任务不保证准点

GitHub `schedule` 可能延迟数分钟。页面已处理：数据日期落后时显示“等待今日更新”并保留旧菜单，每 60 秒自动重取一次。

### P1：静态方案不支持个性化

同一天所有访客看到同一份菜单；无收藏、无跨设备历史。需要这些能力时应迁移到带数据库的方案（如 Cloudflare Workers + D1）。

### P2：菜品规模限制去重周期

每类 30 道 ≈ 10 天一轮。周期与所需菜品数：

| 目标周期 | 每类至少菜品数 |
|---|---:|
| 10 天 | 30 道 |
| 15 天 | 45 道 |
| 30 天 | 90 道 |

### P2：数据完整性风险

`data/history.json` 是去重的唯一依据。误删会丢失历史，可能很快重复推荐。
缓解：纳入 Git 版本控制（每次生成都会 commit），不要手工改格式；已限制最多保留 400 天。

## 2.6 风险汇总

| 风险 | 影响 | 当前缓解方式 |
|---|---|---|
| GitHub 仓库/权限未配置 | 无法自动更新 | 按 §3.2 逐项配置 |
| Pages 发布源未设为 Actions | 页面 404 | 设置后手动跑一次工作流 |
| Actions 无写权限 | 生成结果无法 commit | Workflow permissions 设为 Read and write |
| 定时任务延迟 | 零点后短时仍是旧菜单 | 页面自动重试 + 等待态提示 |
| 视频链接失效/不准 | 教程入口体验差 | 固定链接 + 搜索兜底，定期抽查 |
| 历史文件丢失 | 推荐重复 | Git 历史 + 400 天上限 + 不手改格式 |
| 本机无 Node | 无法本地生成 | 装 Node LTS；或用 DSH 内置 Node |
| 私有仓库 Pages 限制 | 无法按预期发布 | 免费账号请用 Public 仓库 |

---

# 三、后续待办事项

## 3.1 第一优先级：本地跑通（✅ 已完成）

- [x] 重写 `setup-project.ps1`（不再是终端回显，可重复执行）
- [x] 生成全部项目文件
- [x] 目录结构检查
- [x] `dishes.psv` 91 行 / 8 字段 / 30-30-30
- [x] 执行生成脚本并确认 `public/data/today.json`
- [x] 本地静态服务器打开页面（`npm run preview`）
- [x] 桌面与手机尺寸检查（截图在 `docs/`）
- [x] 检查视频入口链接格式（未逐条点开）
- [ ] **安装 Node LTS 到系统 PATH**（仅本地手动运行时需要）

## 3.2 第二优先级：发布到 GitHub Pages（✅ 已完成）

- [x] 在 GitHub 新建 **Public** 仓库（实际名字：`daily-menu`）
- [x] 本地初始化、提交并推送（`main`，commit `87e70ff`，15 个文件）

  ```powershell
  cd C:\Users\phoenix\Documents\daily-wok
  git init -b main
  git add .
  git commit -m "chore: 初始化今日开锅（90 道菜、生成脚本、页面与工作流）"
  git remote add origin git@github.com:hugo1715/daily-menu.git
  git push -u origin main
  ```

- [x] `Settings → Pages`：Source 选 **GitHub Actions**
- [x] `Settings → Actions → General`：Workflow permissions 选 **Read and write permissions**
- [x] `Actions → Daily Menu Build and Deploy → Run workflow` 手动跑一次
- [x] 确认 `build` 与 `deploy` 两个 job 都成功（run #1）
- [x] 打开 `https://hugo1715.github.io/daily-menu/` 验收

## 3.3 第三优先级：上线验收

- [x] 页面正常显示 3 荤、3 素、3 汤（截图与本地逐字节一致）
- [ ] 每道菜都有视频入口，点击能在新窗口打开 B 站（入口已渲染，未逐条点击验证）
- [x] 手机宽度下卡片单列，桌面三列（本地等价验证 + 线上同源样式）
- [x] `today.json` 的 `date` 等于北京时间当天（2026-11-08）
- [x] 同类当天无重复菜品
- [ ] 最近 9 天历史无明显重复（目前只有 1 天数据，需积累几天后再看）
- [x] 页面显示菜单生成时间
- [ ] **第二天再打开**，确认定时任务自动更新（北京时间 00:05）

## 3.4 后续优化

- [x] 为部分菜品补固定 B 站视频链接（已补 12 道，均核实）
- [ ] 增加链接失效检查（可用 Actions 定时 curl 检查）
- [ ] 菜品库扩到 45 或 90 道/类
- [x] 页面增加“最近 7 天历史”
- [ ] 增加分类筛选 / 随机再摇一次（前端本地摇签，不影响当天记录）
- [ ] 若要个性化，迁移 Cloudflare Workers + D1
- [ ] 补一版自动化测试（当前 12 天去重模拟是临时脚本，可固化为 `scripts/selftest.mjs`）

---

# 四、接手快速检查清单

```powershell
cd C:\Users\phoenix\Documents\daily-wok
tree /F
```

自检（目录、文件、PSV 行数/字段/分类分布、历史、Node/Git）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-project.ps1
```

检查 Git 与 Node：

```powershell
git --version
node --version
```

生成今日菜单：

```powershell
npm run generate          # 或 node scripts/generate-daily.mjs
```

本地预览：

```powershell
npm run preview           # 打开 http://127.0.0.1:8000
```

检查生成结果：

```powershell
Get-Content .\public\data\today.json -Raw -Encoding UTF8 | ConvertFrom-Json
Get-Content .\data\history.json -Raw -Encoding UTF8 | ConvertFrom-Json
```

补生成某一天（例如补 11-01 的菜单）：

```powershell
$env:DAILY_WOK_DATE = '2026-11-01'; node scripts/generate-daily.mjs; Remove-Item Env:DAILY_WOK_DATE
```

---

# 五、交接结论

项目需求、技术方案、90 道菜品、生成逻辑、页面与工作流**均已落地并本地验收通过**，不再是“只有设计稿”的状态。

项目已**完整上线**：本地生成与页面验收通过 → 推送 GitHub → Pages 发布 → 线上验收通过。

访问地址：**<https://hugo1715.github.io/daily-menu/>**

日常状态：每天北京时间 00:05 由 Actions 自动生成新菜单、提交回仓库并重新部署；同一天所有人看到同一份。
不再需要任何手工操作，除非要改菜谱、改样式或改去重周期。

剩余待观察：次日定时任务是否按预期自动触发（若 Actions 里出现新的 `chore: 更新 2026-11-09 菜单` 提交，即完全闭环）。

可选优化见 §3.4：补固定视频链接、扩充菜品库、页面加“最近 7 天历史”等，都不影响当前使用。

本地若还需要手动生成，先装 Node LTS 20/22（当前系统 PATH 里没有 Node，本次验收用的是 DSH 内置运行时）。

---

# 附录 A：文件清单（交接时状态）

| 文件 | 大小 | 说明 |
|---|---:|---|
| `data/dishes.psv` | 9.2 KB | 91 行 / 90 道菜 / 8 字段 |
| `data/categories.json` | 0.4 KB | 三分类定义 |
| `data/history.json` | 0.4 KB | 已含 2026-11-08 一条记录 |
| `public/index.html` | 14.3 KB | 单文件页面 |
| `public/data/today.json` | 5.3 KB | 今日菜单产物 |
| `scripts/generate-daily.mjs` | 11.0 KB | 生成器 |
| `scripts/preview.mjs` | 2.0 KB | 本地预览服务器 |
| `.github/workflows/daily-menu.yml` | 1.6 KB | build + deploy |
| `setup-project.ps1` | 5.3 KB | 自检脚本（UTF-8 with BOM） |
| `README.md` | 5.2 KB | 使用与部署说明 |
| `docs/preview-desktop.png` | 277 KB | 1440px 桌面截图 |
| `docs/preview-mobile.png` | 93 KB | 390px 移动截图 |

# 附录 B：参数速查

| 想改什么 | 改哪里 |
|---|---|
| 加菜 / 换菜 | `data/dishes.psv`（id 不重复，分类数量保持均衡） |
| 某道菜的固定视频 | 该行 `videoUrl` 填 B 站链接 |
| 去重周期 | `data/history.json` 的 `windowDays`（需保证每类菜品数 ≥ 3 × windowDays） |
| 每天几点生成 | `.github/workflows/daily-menu.yml` 的 `cron`（UTC） |
| 每类推荐几道 | `scripts/generate-daily.mjs` 的 `PICK_PER_CATEGORY` |
| 最近 7 天展示几天 | `scripts/generate-daily.mjs` 的 `RECENT_DAYS` |
| 分类标题/颜色 | `data/categories.json` |
| 重挑今天的菜 | 删掉 `history.json` 里当天记录再跑生成 |
