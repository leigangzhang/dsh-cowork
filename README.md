# @dsh-external/dsh-cowork

DSH 项目式主从协作插件：在一个 profile 内提供「master 主会话 + 可直接对话的 thread 会话 + 项目记忆 + worktree 隔离 + 路由 + handoff + review」的 Cloud Cowork 式协作模式。

- 完整产品与实现方案：[docs/PLAN.md](docs/PLAN.md)
- 目标：单插件安装，单 profile 生效，本地优先，无云上传。
- 状态：方案已冻结；仓库已生成 hybrid 插件骨架，`src/` 为占位实现，开发按 PLAN.md 的 M0 起步。

## 构建与注入

```bash
DSH_CHECKOUT=<checkout> bash scripts/build.sh
# 注入器环境内：dev_inject_plugin /Users/ray/Workspace/dsh-cowork
```
