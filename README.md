# Facebook VOC 评论采集器

## 一眼看懂

- 这是什么：按商品编号找 Facebook 公开帖子并采评论。
- 什么时候用：要理清公开主页帖子和视频里的回复关系时。
- 给它什么：商品编号或编号清单，和一个已登录的浏览器。
- 它给你什么：八张表的 Excel，含评论、回复树和帖子审核。

## 项目简介

`facebook-voc-collector` 是由 Amazon ASIN 驱动的 Facebook 公开评论采集工具，也可作为 Codex Skill 使用。程序从商品和可见卖家精灵数据建立产品语境，生成七类查询，发现公开 Page 帖子、视频和 Reels，再读取可见评论与回复，输出原始数据、审核记录和 Excel。

正式入口是 `scripts/facebook_playwright_collector.cjs`，通过 Playwright 连接专用 Chrome Profile 的 CDP（Chrome 调试协议）会话；`extension/` 与 Python 本地接收桥只是可见 DOM（页面结构）调试工具。仓库不含 Meta API 调用，也不处理登录或验证码，只读取当前会话可见的内容。

## 核心功能

- 🔎 **多种输入**：单 ASIN、分组或清单文件
- 🧭 **查询生成**：按产品证据生成七类查询
- 🌐 **帖子发现**：判定相关性并逐帖审核
- 🧵 **评论树展开**：展开排序、回复并留断点
- 🧹 **界面去噪**：区分真实评论与 UI 文本
- 🚦 **完整性分流**：按 PASS 与 PARTIAL 分流
- 📊 **八表导出**：JSONL、CSV、映射与 Excel

## 技术栈

| 层级 | 技术 | 版本 |
| --- | --- | --- |
| 运行时 | Node.js（`package.json` engines） | — |
| 浏览器自动化 | Playwright | >=1.55.0 <2 |
| 语言 | Python | >=3.10,<3.14 |
| 工作表 | openpyxl | >=3.1,<4 |
| 浏览器 | Google Chrome + CDP | — |
| 启动器 | Windows PowerShell | — |
| 测试 | Python unittest / Node.js test runner / GitHub Actions | — |

版本取自 `package.json`、`pyproject.toml`、`requirements.txt` 与 `.python-version`；Node.js 只写了 engines 要求（`>=20`），依赖文件未锁定具体版本，故记「—」，Python 本地锁定版本为 `3.12.13`。

## 快速开始

需要 Node.js 20+、Python 3.10–3.13 和 Google Chrome。自动采集目前以 Windows 为主，离线测试在 macOS / Linux 也可运行。

1. 克隆仓库并进入目录

   ```bash
   git clone https://github.com/fubo-ops/facebook-voc-collector.git
   cd facebook-voc-collector
   ```

2. 安装 Python 与 Node 依赖

   ```bash
   python -m venv .venv
   python -m pip install -r requirements.txt
   npm ci
   ```

3. 启动并连接专用 Chrome 的 CDP 会话（Windows PowerShell）

   ```powershell
   .\scripts\start_facebook_cdp.ps1
   node scripts/facebook_playwright_collector.cjs --help
   ```

4. 预检当前浏览器会话，只读可见内容

   ```bash
   node scripts/facebook_playwright_collector.cjs preflight --asin ASIN --session-mode cdp --headless 0
   ```

5. 采集单个 ASIN，输出到 `outputs/` 下的指定目录

   ```bash
   node scripts/facebook_playwright_collector.cjs collect --asin ASIN --target-comments 300 --target-posts 30 --session-mode cdp --out-dir outputs/run-001
   ```

6. 跑离线测试，不需要浏览器与登录态

   ```bash
   python -B -m unittest discover -s tests -p "test_*.py" -v
   npm test
   ```

把 `ASIN` 换成真实 10 位商品标识；批量采集用 `--asins ASIN_A,ASIN_B` 或 `--asin-file`。默认输出根目录来自 `FACEBOOK_COLLECTION_ROOT`，未设置时用当前目录的 `Facebook评论采集/`。续跑与重审要传入已有 `checkpoint.json` 的路径并加 `--retry-partial` 或 `--force-reaudit-partial`。

## 项目结构

只列两层，完整文件清单见文末《详细说明》。

```text
facebook-voc-collector/
├── .github/                                # CI 工作流目录
├── .gitignore                              # 忽略环境、采集产物与浏览器 Profile
├── .python-version                         # 本地 Python 版本锁定
├── LICENSE                                 # MIT 许可证
├── README.md                               # 项目总览与快速开始
├── SKILL.md                                # Codex Skill 入口与命令说明
├── agents/                                 # Agent 配置
├── extension/                              # 可选 Chrome 调试扩展
├── package.json                            # Node 依赖、测试与语法检查脚本
├── pyproject.toml                          # Python 包元数据与依赖
├── requirements.txt                        # Python 运行依赖
├── references/                             # 采集规则与字段契约文档
├── scripts/                                # 采集、校验与工作簿脚本
│   ├── build_facebook_workbook.py          # 生成八表 Excel
│   ├── collector.py                        # 可选本地接收桥
│   ├── facebook_playwright_collector.cjs   # 正式采集 CLI 入口
│   ├── facebook_voc_core.cjs               # 产品语境、查询与审核核心
│   ├── quick_validate.py                   # 仓库分发契约自检
│   └── start_facebook_cdp.ps1              # Windows Chrome CDP 启动器
└── tests/                                  # 离线测试
    ├── test_collector.py                   # Python 采集与校验测试
    ├── test_facebook_core.cjs              # Node 核心逻辑测试
    ├── test_popup.cjs                      # 扩展弹窗测试
    ├── test_repository_distribution.py     # 分发与仓库结构测试
    └── test_workbook.py                    # 工作簿构建测试
```

## 架构图

```text
【输入】
┌────────────────────────────────────────────────┐
│   ASIN / ASIN 分组 / ASIN 文件                 │
└───────────────────────┬────────────────────────┘
                        ▼
┌────────────────────────────────────────────────┐
│   CLI 预检 + 专用 Chrome Profile CDP 会话      │
└───────────────────────┬────────────────────────┘
                        ▼
┌────────────────────────────────────────────────┐
│   Amazon 证据 + 可见卖家精灵词 → 七类查询      │
└───────────────────────┬────────────────────────┘
                        ▼
┌────────────────────────────────────────────────┐
│   Facebook 公开帖子 / 视频 / Reels 发现与判重  │
└───────────────────────┬────────────────────────┘
                        ▼
┌────────────────────────────────────────────────┐
│   Playwright 展开评论与回复，逐动作写断点      │
└───────────────────────┬────────────────────────┘
                        ▼
┌────────────────────────────────────────────────┐
│   评论树 / 完整性 PASS · PARTIAL · BLOCKED     │
└───────────────────────┬────────────────────────┘
                        ▼
┌────────────────────────────────────────────────┐
│   JSONL · CSV · 映射 · 逐帖证据 · 八表 Excel   │
└────────────────────────────────────────────────┘
```

断点文件与逐帖证据留在输出目录的 `evidence/`；评论正文、浏览器 Profile、cookie 和生成产物都不进 Git。

## 开发计划

### Phase 1: 采集与查询

- ✅ 单 ASIN、逗号分组与 ASIN 文件输入，合并去重
- ✅ Amazon 与可见卖家精灵证据生成七类查询
- ✅ 公开帖子、视频与 Reels 发现和相关性判定

### Phase 2: 评论树与证据

- ✅ 可见的全部评论排序、评论与回复展开
- ✅ UI 记录区分、稳定 ID 技术去重与不确定标记
- ✅ PASS（通过）/ PARTIAL（部分）/ BLOCKED（受阻）完整性分级与逐帖证据

### Phase 3: 输出与续跑

- ✅ 八表 Excel、JSONL / CSV 与查询页面映射导出
- ✅ checkpoint 断点续跑与不完整帖子重审
- ✅ Trusted（可信层）与 Partial（候选层）分层写入及 Quality Gate（质量门禁）检查

### Phase 4: 工程化与上线

- ✅ 离线测试（unittest、Node test runner）
- ✅ GitHub Actions 三平台与 Python 3.10/3.13 矩阵
- ✅ `quick_validate.py` 分发契约校验
- ⬜ `package.json` 与 `pyproject.toml` 版本元数据统一
- ⬜ 真实业务环境验收记录与后续排期
- ⬜ 非 Windows 平台的自动 CDP（Chrome 调试协议）启动

## 文档

- [Skill 入口](SKILL.md) — 命令、必做流程与访问边界
- [采集、发现、续跑与停止规则](references/collection-guide.md)
- [评论字段、父子关系与审核契约](references/raw-record-schema.md)
- [Windows CDP 启动器](scripts/start_facebook_cdp.ps1)
- [工作簿构建入口](scripts/build_facebook_workbook.py)
- [CI 配置](.github/workflows/test.yml)

## 许可证

采用 [MIT License](LICENSE)。

---

原 README 里的环境要求、安装配置、完整命令、数据边界、项目文件清单、开发状态与历史记录等细节，已全部迁移到 [docs/详细说明.md](docs/详细说明.md)。
