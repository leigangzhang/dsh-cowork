# Plain language

The other half of the vocabulary problem: [glossary.md](glossary.md) fixes what a word means inside this project, and this page says how to say it to someone who has not read the glossary. A person reading a reply, a PR description, a release note, or a commit message has not read the glossary.

## When to expand

1. **First use in human-facing text.** Expand once, or replace the term outright.
2. **Never assume a word was granted.** The reader only has the words already in the message.
3. **One new word at a time.** Two invented words in one paragraph is a paragraph the reader skips.
4. **Name the actor and the fact**, not the mechanism's metaphor.
5. **Documents are exempt.** Records, contracts, and standing documents use the terms and link the glossary.

## Terms and their plain meaning

### master

The main session that routes requests and approves finished work.

*Instead of* "master 会把需求路由到最相关 thread" → *say* "主会话会把需求派给最相关的话题会话".

### topic（主题会话）

One feature's own conversation, which you can open and continue like any other chat. A work item and its review request live inside that topic.

*Instead of* "thread 完成 handoff" → *say* "这个话题会话做完后，会交回一份结构化汇报".

*Instead of* "thread" → *say* "话题会话"（`thread` 是 0.1.0 的旧名，不要用来描述当前行为）。

### handoff

The structured report a topic leaves when it finishes or needs a decision.

*Instead of* "handoff 未到达" → *say* "话题会话的交接汇报还没有投递给主会话".

### project memory

A small folder in the project that remembers decisions, constraints, and facts across sessions.

*Instead of* "project memory 命中" → *say* "项目记忆里存了这条约束，新会话能读到它".

### preset

A ready-made conversation mode that sets the assistant's role and rules.

*Instead of* "用 cowork-thread preset" → *say* "新会话选择 cowork-topic 这个预设"（`cowork-thread` 只是旧会话的弃用别名）。

### surface

The group of files a change touches, together with the checks that must run for those files.

*Instead of* "这个改动属于 source surface" → *say* "改的是源码，所以要先跑类型检查和构建".

### evidence

The commands that actually ran and what they printed.

*Instead of* "证据不足" → *say* "没有一条命令真的跑过，所以现在不能证明它能工作".

### check

A small executable rule that fails when a convention is violated.

*Instead of* "check 红了" → *say* "`npm run check` 失败：某条约定被破坏了".

### empty corpus

The check found no file to look at, so it proves nothing.

*Instead of* "这个 check 绿了" → *say* "这个检查没有匹配到任何文件，等于没查".

### seam

A part you can swap for a different implementation without touching the rest.

*Instead of* "memory 是 seam" → *say* "项目记忆可以换不同的存储实现，而调用方不用改".

### provider

One concrete implementation of a swappable part.

*Instead of* "provider 不匹配" → *say* "这个存储实现不支持当前的写入方式".

### sidecar

A small state file kept next to the thing it describes.

*Instead of* "sidecar 记录在磁盘" → *say* "项目索引和交接记录都放在 `.dsh-cowork/` 里".

### worktree

A separate working copy of the project for one work item, so two work items do not overwrite each other.

*Instead of* "thread 落到 worktree" → *say* "这个工作项在自己的独立克隆里改代码，合并时不会互相覆盖".
