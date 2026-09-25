# 网页资源库 / 漫画收藏助手 (Web Resource Harvester) v6

一个油猴（Tampermonkey）用户脚本，点 📚 打开**独立浏览器弹窗窗口**（原生窗口，可最小化/拖到副屏/与网页并排），内含三种模式：

- 🌐 **全局模式**：精准识别当前网页的**全部资源**，并按资源在页面里的「**角色**」细分分类（主图 / 卡片配图 / 缩略图 / 头像 / Logo / 背景图 / 画廊图 / 视频封面 / 装饰小图 / 视频 / 音频 / 字幕 / 文档 / 压缩包 / 字体），支持体积探测、预览、单个与批量下载；
- 🎬 **视频下载**（v6.1）：B站与抖音视频的解析与下载——B站 **playurl API 解析**（fnval=4048，各清晰度视频流 + 音频流分离）+ **带 Referer 的中继下载**（修复 CDN 403 防盗链）、ffmpeg 合并命令、完整文件直下；抖音拦截官方 `aweme/detail` 接口拿 `play_addr` **无水印地址**；任何站点均配备**网络拦截**兜底（拦截页面请求里的 m3u8/mp4 等媒体地址）。解析策略参考 [bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect) 与 [Bilibili-Evolved](https://github.com/the1812/Bilibili-Evolved) 下载模块，本地运行、数据不出浏览器；
- 📚 **漫画模式**：为缺少搜索与分类功能的漫画站提供收藏管理——标签分类、关键字搜索、封面网格、自建标签、批量打标、跨页累积（内置 18comic / JM 系精确预设）。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展。
2. TM 面板 →「添加新脚本」→ 粘贴 `manga-fav-enhancer.user.js` 全部内容保存。
3. 页面右下角出现 📚 按钮即成功；脚本不改动页面本身。
4. 首次使用下载 / 体积探测时 TM 会询问跨域许可（脚本声明了 `@connect *`），允许即可。

## 全局模式：资源怎么被识别

**采集来源**（在原页面 DOM 上遍历，结果全部去重）：

| 来源 | 说明 |
|---|---|
| `<img src>` `<picture source>` | 含 `srcset` 多分辨率、`data-src` 等懒加载属性 |
| CSS `background-image` | 用 `getComputedStyle` 逐个元素取（上限 5000 个元素，防大页面卡顿） |
| `<video>` / `<source>` / `poster` | 视频源与视频封面分开归类；含 `data-src` / `data-video` 等懒加载地址；HLS（`.m3u8`）也归为视频 |
| `<audio>` | 含 `<source>`、`data-audio` / `data-mp3` 等 |
| `<track>` | 字幕轨（`.vtt` `.srt` `.ass`），单独归类为「字幕」 |
| 独立 `<source>` | 不在 `<video>/<audio>` 内时按 `type` 属性或扩展名归类 |
| `<embed>` / `<object>` | |
| `<iframe src>` | 只列框架地址，不递归读取内容 |
| `<a href>` 指向文件 | zip/rar/pdf/mp4/mp3/字体/字幕 等 |

> **流媒体**：`<video>` 用 `blob:` 源（MSE）的会被列出来并标注「流媒体」——可以预览，但这类地址无法直接下载（预览窗会提示）。勾选「仅可下载」即可把它们过滤掉。

**角色判定**（优先级从高到低）：

1. `logo` — 元素签名命中 logo / brand / favicon / site-icon
2. `avatar` — avatar / user / author / profile / uploader 等
3. `gallery` — gallery / slider / swiper / carousel / album / lightbox / viewer
4. `poster` — `<video poster>`
5. `background` — 来自 CSS `background-image`
6. `card` — 位于 card / tile / list-item / entry / feed 等容器内
7. `content` — 位于 article / main / .content / post / editor 内
8. `thumbnail` — 卡片内但尺寸 ≤180px，或命中 thumb / mini / preview
9. `sprite` — 装饰小图（宽或高 < 64px）
10. `hero` **主图** — 采集结束后，在非装饰类图片中取面积最大的前 3 张标为主图

> 元素签名 = 元素自身 + 上溯 4 层的 id / class 名。所以"它是一张什么图"是按它在页面结构里的位置推断的，而不是只看扩展名。

**界面能力**：

- **顶部种类选项卡**：`全部 / 图片 / 视频 / 音频 / 文档 / 压缩包 / 字体 / 字幕 / 其他`，点一下即按种类筛选（带计数，无结果的种类置灰）
- **左侧角色分类栏**：在你选中的种类范围内，再按角色细分（全部 / 主图 / 卡片配图 / … / 视频 / 音频 / 字幕 / 文档），两级筛选叠加
- 切换种类时角色筛选自动重置，不会出现「选了视频种类却筛主图」的空结果
- 卡片左上角彩色徽标显示角色；下方显示尺寸、体积、种类
- 过滤：**隐藏小图标**（默认开，剔除 <96px 的装饰图与 sprite）、**仅本站**、**仅可下载**（剔除 blob 流媒体）
- 卡片左上角徽标显示角色；流媒体显示为灰色「流媒体」徽标，且不提供下载按钮
- 排序：**大图优先**（默认）/ 体积降序 / 按域名 / 按种类
- 搜索：按文件名、URL、域名匹配
- **预览**：图片大图；视频 / 音频内嵌播放；预览窗显示角色、种类、尺寸、体积、来源、完整 URL
- **下载**：悬停 ⬇ 单个下载；多选后「⬇ 下载所选」批量（350ms/个，防浏览器拦截）；「复制 URL」
- **获取体积**：HEAD 请求探测 `Content-Length`（并发 6，默认作用于当前列表前 120 项或选中项）

## 漫画模式

1. 打开漫画站的**收藏 / 书架列表页**，切到「📚 漫画模式」→「扫描本页」。
2. 「连续扫描」自动跟随"下一页"抓完所有分页（后台 fetch，不刷新页面）。
3. 左侧分类（全部 / 未分类 / 各标签）+ 搜索（多关键字空格分隔）+ 封面网格。
4. 卡片悬停点 ✎ 单独打标；多选后「打标签」批量归类；「备份」导出 / 导入 JSON。

### 防误抓

- 内置预设只用**精确选择器**（当前内置 `18comic / JM 系`：`div[id^="favorites_album_"]` + `.video-title` + `img.img-responsive` + `a[href*="album"]`）
- 未命中预设的站点才用通用启发式（需 ≥4 个同构卡片），可在「设置」里关闭
- 「设置 → 测试当前页」先看识别结果（几个容器 / 成功几条）再入库

## 🎬 视频下载模式（v6.1）

在 B站 / 抖音的视频页面切到「🎬 视频下载」标签，脚本自动解析当前视频。

### 哔哩哔哩（参考 bilibili-API-collect / Bilibili-Evolved 的成熟方案）

- **playurl API 解析**（v6.1 重写）：与播放器同域调用 `api.bilibili.com/x/player/playurl`（`fnval=4048`，带登录 cookie，旧端点免 wbi 签名），拿到**全部已授权清晰度**的视频流（360P～8K，每个清晰度保留兼容性最好的编码 avc > hevc > av01）与音频流（64k/132k/320k/杜比/Hi-Res），按 `带宽 × 时长` 估算体积；
- cid 缺失时自动用 `x/web-interface/view` 补齐；API 不可用时回退页面内嵌 `__playinfo__`，再不行靠网络拦截兜底（解析来源会显示在状态栏）；
- 顶部给出**推荐组合**（最高清晰度视频 + 最高音质音频），一键「⬇ 下载视频+音频」；
- **带 Referer + UA 的中继下载**（v6.2 修复 403/0 秒问题）：实测 B站 CDN 要求 `Referer` 与 `User-Agent` **同时匹配，缺一即 403**（返回空体/错误页，表现即"0 秒视频"）。下载自动走 `GM_xmlhttpRequest` 带完整请求头拉流 → blob 中继保存，弹窗实时显示进度；Referer 按**解析来源站点**打标（B站页面解析出的所有地址一律带 `https://www.bilibili.com/`），不再依赖 CDN 域名匹配——因为 B站 CDN 域名会轮换（bilivideo.com ↔ akamaized ↔ 随机第三方 mcdn 域名），按域名猜必漏。已实测 4 种不同 CDN 节点（含第三方域名）全部下载成功；
- 「📋 ffmpeg 合并命令」：DASH 音视频分离，两个文件下完本地合并：
  ```
  ffmpeg -headers "Referer: https://www.bilibili.com/" -i "视频.m4s" -headers "Referer: https://www.bilibili.com/" -i "音频.m4a" -c copy "标题.mp4"
  ```
- 部分视频有 `durl` 完整文件（MP4/FLV），直接单文件下载无需合并；
- 登录大会员账号可拿到对应更高清晰度的流（读取的是页面已授权的数据）。

### 抖音

- **拦截官方接口**（v6.1 重写）：页面自己会带完整签名请求 `aweme/v1/web/aweme/detail`，脚本拦截该响应 JSON，直接读官方 `play_addr`（比正则扫 URL 可靠得多）；
- `play_addr.uri` 自动构造 `aweme/v1/play` 无水印直链（`ratio=1080p`）；`download_addr`（含水印）单独标黄方便对比；
- SSR 数据（`_ROUTER_DATA` 等）作为兜底，`playwm→play` 无水印转换保留；
- 标题自动作为下载文件名。

### 网络拦截兜底（所有站点）

- 脚本在 `document-start` 早期注入，hook 页面的 `fetch` / `XMLHttpRequest`，自动拦截响应里的媒体地址（m3u8 / mp4 / flv / m4s / 抖音 play API / bilivideo 直链）；
- 刷新或跳转后继续累积（上限 600 条）；「🎬 视频下载」标签里统一展示，支持下载 / 复制 / 打开；
- 拦截到的 bilivideo / douyinvod 地址下载时同样自动补对应平台的 Referer；
- 这也是其他平台（快手、TikTok 等社媒站）的通用兜底——只要播放时 URL 走过网络层就能抓到。

### 使用提示

- B站从首页 SPA 跳进视频页后，直接打开弹窗点「重新解析」即可（无需刷新页面）；
- 下载走 blob 中继时文件先整体进内存再保存，**超大视频（>2GB）可能吃紧**——这种情况建议用 ffmpeg 命令边下边合并；
- m3u8 是 HLS 列表不是单个文件：复制 URL 配 ffmpeg `ffmpeg -i "xxx.m3u8" -c copy out.mp4` 下载。

## 数据与隐私

收藏数据存本地 `localStorage`（按站点主机名分库），资源嗅探与视频解析结果只在弹窗内存里、不落盘；网络拦截只记录 URL 本地展示，**不上传任何服务器**（与 SocialExt 相同的本地运行原则）。

## 已知边界

- 运行时用 blob: / MSE 流式加载的视频（B站播放器本身、部分流媒体站）**不能直接下载**——但 B站/抖音的真实地址已由平台解析器 + 网络拦截从数据层拿到，不受影响；纯 MSE 且无任何直链暴露的站点则无能为力。
- 脚本必须在页面加载**之前**注入（`@run-at document-start`）网络 hook 才生效；TM 里更新脚本后刷新页面即可。已打开很久的旧页面 hook 可能错过早期请求。
- 抖音网页改版频繁：接口路径变化时结构化拦截可能失效，此时自动退回 SSR / 网络拦截兜底（播放时 play API 一定会流过）。
- CSS 背景图扫描上限 5000 个元素；超大页面可能漏扫。
- HEAD 体积依赖目标服务器是否返回 `Content-Length`，部分 CDN 不返回就显示为空。
- Referer 中继下载把文件整体放进内存再保存，超大视频（>2GB）建议改用 ffmpeg 命令；普通资源仍走 GM_download 原生下载、不占内存。
- 脚本只读页面内容、不模拟登录、不绕过访问控制；下载内容仅限个人合理使用，请遵守各平台服务条款与版权规定。
