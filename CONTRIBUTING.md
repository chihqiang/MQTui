# 贡献指南

## 环境要求

构建这套东西要凑齐三样：Node.js、Rust、以及「能被 C 编译器编出来的系统库」。
最容易卡住的是第三样 —— 它不是 npm 依赖，报错信息也往往只提一个头文件找不到，
所以下面按平台把命令都列全。

### 通用

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | >= 22 | 前端构建与脚本（CI 用 22） |
| npm | 随 Node | 装前端依赖，`package-lock.json` 已提交，用 `npm ci` 可复现 |
| Rust | stable | 后端；随仓库的 `rust-toolchain.toml` 自动装 rustfmt / clippy |
| C 编译器 | gcc / clang / MSVC | librdkafka 与部分 crate 的本地编译 |
| CMake | >= 3.20 | `rdkafka` 开了 `cmake-build` 特性，编译期需要它生成构建文件 |
| pkg-config | 任意 | 探测系统库（Linux / macOS） |
| perl | 任意 | OpenSSL 构建脚本使用；`rdkafka` 的 `ssl` 特性会牵出来 |
| make | 任意 | CMake 的默认生成器在 Linux / macOS 上依赖它 |

`cargo` 第一次构建会编译 librdkafka 本体（`rdkafka` + `cmake-build`），机器慢的话这一步要几分钟；
之后再改 Rust 代码就不会重复编了。

### Linux（Debian / Ubuntu）

```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential cmake pkg-config perl \
  libcurl4-openssl-dev libsasl2-dev libssl-dev zlib1g-dev \
  libgtk-3-dev libwebkit2gtk-4.1-dev libsoup-3.0-dev \
  libayatana-appindicator3-dev librsvg2-dev
```

- `libcurl4-openssl-dev` / `libsasl2-dev` / `libssl-dev` / `zlib1g-dev`：librdkafka 的依赖
- `libgtk-3-dev` / `libwebkit2gtk-4.1-dev` / `libsoup-3.0-dev`：Tauri 2 的窗口与 WebView
- `libayatana-appindicator3-dev` / `librsvg2-dev`：托盘图标与 SVG 图标（`tauri build` 需要）

CI 只装了其中一部分 —— 它只跑检查与单测，不打包，所以没装托盘相关的包。本地要出安装包就按上面这条装全。

Fedora / RHEL 对应的是：

```bash
sudo dnf install -y gcc gcc-c++ make cmake pkgconf-pkg-config perl \
  openssl-devel cyrus-sasl-devel libcurl-devel zlib-devel \
  gtk3-devel webkit2gtk4.1-devel libsoup3-devel \
  libappindicator-gtk3-devel librsvg2-devel
```

### macOS

```bash
xcode-select --install          # Command Line Tools 里带 clang、make、perl
brew install cmake pkg-config openssl@3
```

Apple Silicon 上如果 pkg-config 找不到 OpenSSL：

```bash
export PKG_CONFIG_PATH="$(brew --prefix openssl@3)/lib/pkgconfig:$PKG_CONFIG_PATH"
```

WebKit 由系统提供，不需要额外装。

### Windows

1. 装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，勾选「使用 C++ 的桌面开发」（提供 MSVC 与 Windows SDK）
2. 装 [CMake](https://cmake.org/download/)，安装时勾选「加入 PATH」
3. 装 [Node.js](https://nodejs.org/)（>= 22）与 [Rust](https://rustup.rs/)

librdkafka 在 Windows 上同样由 `cmake-build` 现场编译，走 MSVC 工具链；
`pkg-config` 与 `perl` 在 Windows 上不需要。WebView2 运行时 Win10 1803+ / Win11 自带。

- 用 PowerShell 而非 CMD 执行 npm 脚本，避免路径里的引号被吞掉。
- 路径里不要出现空格与中文，CMake 生成阶段会出奇怪的错。

### 依赖从哪来

- `rdkafka`（`cmake-build` + `ssl` + `zstd`）：C 编译工具链、CMake、Perl、OpenSSL / SASL / zlib 头文件
- `lapin`：纯 Rust AMQP 客户端，无系统依赖
- `reqwest`（`rustls`）：纯 Rust TLS，不走系统 OpenSSL，所以不必为它装证书开发包
- Tauri 2：平台的 WebView 与 GTK 开发包

## 本地开发

```bash
npm ci
npm run tauri dev
```

首次运行会依次：装前端依赖 → 编译 Rust（含 librdkafka）→ 拉起 Vite（`localhost:1420`）→ 开窗口。
只改前端时热更新是即时的；改 Rust 会重启应用。

常用脚本：

```bash
npm run typecheck    # 前端类型检查
npm run lint:ui      # 浅色主题颜色与字号守卫
npm run lint:layers  # 目录分层守卫（pages / types / lib / components）
npm run build        # typecheck + lint:ui + vite build
npm run test:rust    # 后端核心逻辑单测（--no-default-features，不需要图形环境）
npm run test:web     # 前端纯逻辑单测（node --test）
```

## 提交前自检

跑一遍 CI 会跑的东西，能省掉一轮返工：

```bash
# 前端
npm run typecheck
npm run lint:ui
npm run lint:layers
npm run test:web
npm run build

# 后端
npm run test:rust
(cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings)
```

`cargo clippy` 需要默认特性（含 `desktop`），因此依赖上面那套系统库；
`cargo test` 走 `--no-default-features`，脱离图形环境也能跑。

## 目录分层

四条线，各管一件事，由 `npm run lint:layers` 守着（破了不报错、只是慢慢漂移，所以才写成脚本）：

| 目录 | 放什么 | 不许做什么 |
| --- | --- | --- |
| `src/pages/` | 只写页面：取数据、排版、调动作 | 不许定义常量 / 方法 / 接口 / 枚举；不许跨页 import（`index.ts` 与 `lazy.tsx` 除外） |
| `src/types/` | 接口、枚举、常量表、列定义 | 不许有函数体；不许引 `lib` / `components` / `hooks` / `react` |
| `src/lib/` | 纯逻辑与方法 | 不许引 `react`（`nav.ts` 只引类型）、`components`、`pages` |
| `src/components/` | 通用界面块 | 不许引 `pages`、`services`（数据由页面通过 props 传入） |

几条具体的落点：

- 一个常量在**两个页面**出现，就说明它不属于任何一个页面 —— 进 `src/types` 对应领域文件。
  列定义（`TOPIC_COLUMNS` 这类）同理：它是「一页数据长什么样」，不是渲染。
- 一段逻辑在页面里被反复抄 —— 进 `src/lib`，并补一条 `node --test` 单测。
- 一块界面被两个页面用（弹窗、卡片、表单）—— 进 `src/components/broker`，命名以 `-dialog` /
  `-panel` / `-card` 结尾，避免与页面同名。
- 纯逻辑模块之间用相对路径 `./x.ts` / `../types/x.ts`，不要用 `@/` —— `node --test` 直接跑 `.mts`
  时解析不到路径别名。

例外写行内注释 `// layer-lint-allow: 原因`。

## 代码约定

- 目录按「概念」拆分；一个中间件一个子模块，避免出现 `kafka_xxx.rs` 这类扁平命名。
- 不在代码里硬编码：能力、菜单、文案都从统一出口获取。
- 复杂逻辑必须写中文注释，说明「为什么」而不是「做了什么」。
- 能用成熟库就不自己写，例如虚拟滚动、请求缓存、路由。
- Rust 遵循 [Google Rust Style Guide](https://google.github.io/styleguide/rustguide.html)：
  小函数、明确错误类型、`clippy` 零告警。
- 样式不写裸字号与浅色文字类名，走语义档位；例外必须写 `// ui-lint-allow: 原因`。
- 破坏性操作不用 `window.confirm`，统一走 `ConfirmDialog`，写清「会失去什么」。

## 提交信息

采用 [Conventional Commits](https://www.conventionalcommits.org/)：

```bash
feat(broker): 支持 RabbitMQ 队列被动声明探测
fix(message): 修正 Kafka 分区水位查询越界
docs: 按 README 与贡献指南的读者重新分工
```
