# Facebook VOC Collector

一套可独立运行、也可作为 Codex Skill 使用的 Facebook VOC 评论采集器。输入一个或多个 Amazon ASIN 后，系统会解析商品语义、生成七类查询、发现公开 Facebook Page 帖子、视频和 Reels、展开可见评论与回复，并输出带审计和断点恢复能力的 JSONL、CSV 与 Excel。

正式采集使用专用 Chrome Profile + CDP，不依赖浏览器扩展。extension 目录仅保留为可见 DOM 调试工具。

## 支持环境

- Windows 10/11
- Python 3.10–3.13
- Node.js 20+
- Google Chrome
- 公开可见的 Facebook 内容

GitHub Actions 在 Windows、macOS、Linux 和 Python 3.10/3.13 上执行离线数据契约、评论树、工作簿与 JavaScript 测试。自动启动专用 CDP Chrome 的脚本为 Windows PowerShell 实现。

## 仓库结构

    .github/workflows/  GitHub Actions
    agents/             Codex Skill 界面元数据
    extension/          可选调试扩展
    references/         采集流程与字段说明
    scripts/            CLI、评论树、导出和 CDP 启动脚本
    tests/              Python 与 Node 回归测试
    SKILL.md             Codex Skill 入口

## 安装

    git clone https://github.com/fubo-ops/facebook-voc-collector.git
    cd facebook-voc-collector
    python -m venv .venv
    .venv\Scripts\Activate.ps1
    python -m pip install -r requirements.txt
    npm ci

## 首次登录与 Preflight

    .\scripts\start_facebook_cdp.ps1
    node scripts\facebook_playwright_collector.cjs preflight --asin ASIN --session-mode cdp --headless 0

首次 Facebook 登录属于环境准备。正常采集不会要求点击扩展、手动展开评论或逐帖操作。

## 自动采集

    node scripts\facebook_playwright_collector.cjs collect --asin ASIN --target-comments 300 --target-posts 30 --max-comments-per-post 100 --max-discovery-rounds 5 --session-mode cdp --headless 0

批量输入：

    node scripts\facebook_playwright_collector.cjs collect --asins ASIN_A,ASIN_B --session-mode cdp
    node scripts\facebook_playwright_collector.cjs collect --asin-file .\asins.csv --session-mode cdp

从断点继续并重试不完整帖子：

    node scripts\facebook_playwright_collector.cjs collect --asin ASIN --resume outputs\facebook-comments\checkpoint.json --retry-partial --force-reaudit-partial --session-mode cdp

## 输出

默认目录为 outputs/facebook-comments：

    raw_comments.jsonl
    trusted_comments.jsonl
    partial_candidates.jsonl
    raw_comments.csv
    conversation_map.json
    query_plan.json
    page_map.json
    manifest.json
    checkpoint.json
    facebook_voc.xlsx
    evidence/POST_ID/

Excel 包含 Raw_Comments、Trusted_Comments、Partial_Candidates、Conversation_Map、Query_Performance、Post_Audit、Run_Summary 和 Quality_Gate。

## 状态与完整性

- PASS：展开 frontier 已关闭、连续两轮稳定、总数已知或明确为零、没有孤儿回复。
- PARTIAL：仍有展开控件、总数未知、超时或父子关系尚未完整验证。
- BLOCKED：登录墙、验证码、403/429、访问限制或评论树无法加载。
- 原始层保留合格帖子内所有成功读取的评论；只按稳定 comment_id 技术去重。

## 验证

    python -m unittest discover -s tests -p "test_*.py" -v
    npm test
    npm run check
    python scripts\quick_validate.py .

## 数据与访问边界

- .gitignore 排除输出目录、浏览器 Profile、断点、Excel、JSONL、日志和缓存。
- 仓库不保存 Cookie、密码、令牌、浏览器凭据或采集结果。
- 不自动处理登录、验证码、私有内容、年龄和地区限制或访问风控。
- 遇到明确访问限制时保存本地 checkpoint 并标记 PARTIAL 或 BLOCKED。

详细流程见 references/collection-guide.md，字段契约见 references/raw-record-schema.md。

## License

MIT，见 LICENSE。