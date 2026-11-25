# 开发指南

面向仓库贡献者的开发环境搭建、构建和本地 link 安装。用户安装、更新、卸载见 [README.md](../README.md)；测试分层与证据要求见 [testing.md](testing.md)。

## 前置条件

- Node.js **>= 22.19**，版本下限由 `package.json` 的 `engines` 声明。
- npm，仓库用 `package-lock.json` 锁定开发依赖；不要用未提交的浮动版本。
- Git。
- 运行插件和本地 smoke/E2E 需要已安装的 DSH app 与 `dsh` CLI。仅执行 `npm run build`、`npm run typecheck`、`npm test` 不需要 DSH app，也不需要 DSH 源码 checkout。

## 首次搭建

```sh
git clone https://github.com/leigangzhang/dsh-cowork.git
cd dsh-cowork
npm ci
npm run typecheck
npm run build
npm test
```

仓库根目录的 `.npmrc` 设置 `legacy-peer-deps=true`：`@deepseek-ai/dsh-tools` 等包把宿主包声明为 peer，npm 的严格 peer 解析会与开发锁文件冲突。运行时 peer 仍由 DSH 宿主提供。

首次搭建完成的标志是 `npm run typecheck`、`npm run build` 和 `npm test` 都通过。

## 源码与构建产物

| 位置 | 归属 |
|---|---|
| `src/`、`src/client/` | 源码 |
| `tests/`、`scripts/`、`docs/` | 开发与文档 |
| `package.json` 的 `devDependencies` | 构建、测试、客户端打包 |
| `package.json` 的 `dependencies` | 服务端运行时依赖；当前为空 |
| `package.json` 的 `peerDependencies` | 必须由 DSH 宿主共享的单例 |
| `lib/` | `npm run build` 生成的 host/client 产物，gitignore |
| `lib/client.js` | 客户端预构建 bundle |

客户端重型库（Excalidraw、Mermaid、markdown-it、CodeMirror 等）放在 `devDependencies`，由 esbuild 打进 `lib/client.js`；本地 link 安装时不会单独安装它们。

## 本地插件开发

第一次把当前 checkout 装进 profile：

```sh
npm run plugin:install
```

该命令把插件以 `link:` 依赖挂到 `$DSH_PROFILE`（默认 `web`），不生成 tarball，也不重新解析整个 profile 的依赖树。随后重启 DSH，或让 live profile 应用变更。

日常改代码：

```sh
npm run plugin:hot
```

`plugin:hot` 执行构建并检查 link 状态；宿主是否免重启取决于当前 profile 的 live 能力，无法确认时重启 DSH。

其他命令：

```sh
npm run plugin:status       # 检查 link、bundle 列表与构建产物
npm run plugin:uninstall    # 移除 link 安装
```

调试客户端 bundle 时显式生成 sourcemap：

```sh
DSH_COWORK_SOURCEMAP=1 npm run build
```

sourcemap 只留在本地，不提交。

## 检查命令

```sh
npm run check              # 可执行约定、文档发布清单、E2E 证据
npm run check:self-test    # 证明检查本身能失败
npm test                   # 契约与行为测试
npm run test:coverage      # 逐文件覆盖率门禁
npm run typecheck          # host + client 类型检查
npm run build              # host + client 构建
npm run test:host-smoke    # 临时 DSH profile 启动检查，需要 dsh
npm run test:e2e           # keyless E2E，需要 dsh
```

`test:host-smoke` 和 `test:e2e` 使用临时 DSH home，不读写用户的真实 profile。`test:e2e:live` 是观测 lane，需要 `DEEPSEEK_API_KEY`，不作为发布证据。

## 常见问题

- `tsc: not found`：依赖未安装，运行 `npm ci`。
- `dsh: command not found`：`npm run build` 不需要 DSH，但 `plugin:install`、host smoke 和 E2E 需要安装 DSH app/CLI。
- npm peer 冲突：确认仓库根 `.npmrc` 的 `legacy-peer-deps=true` 生效后运行 `npm ci`；不要用 `--force` 绕过。
- `lib/` 缺失或过期：运行 `npm run build`；`lib/` 不入 git。
- 安装后仍加载旧代码：重启 DSH；当前 profile 是否支持 live 应用以宿主能力为准。

## 不在本仓库做的事

- 不把 profile 的本地插件或 registry 缓存 vendor 进本仓库。
- 不提交 `lib/`、`*.tgz`、`node_modules/` 或 sourcemap。
