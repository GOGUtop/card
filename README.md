# CardVault · Full · Anima 世界书

这是完整功能版源码，基于用户提供的 `card-main` 源码修改。

## 顶部三个页面

- **角色卡库**：保留上传、AI 分类、批量管理、自动导入酒馆等原功能。
- **游玩备份**：保留角色 PNG、完整角色 JSON、聊天 JSONL、绑定世界书等原有归档 / 恢复功能。
- **Anima世界书**：新增独立页面，用于保存当前聊天绑定的 Chat Lorebook，并可恢复到任意当前聊天。

## Anima 世界书保存方式

Anima 教程中的总结保存到“聊天世界书”，不是角色世界书。本版本直接读取 SillyTavern 当前聊天的 `chatMetadata.world_info`，将完整世界书 JSON 保存到 SillyTavern 当前站点的 IndexedDB。

保存记录按：

`角色 + 聊天 + 聊天世界书`

区分。同一角色不同聊天不会互相覆盖。恢复时会：

1. 把完整 JSON 写回 SillyTavern 世界书；
2. 将该世界书设置为当前聊天的 Chat Lorebook；
3. 不修改角色卡自身的角色世界书绑定。

> IndexedDB 属于 SillyTavern 站点数据。卸载 / 重装这个扩展不会主动删除它；如果手动清理浏览器站点数据或换域名，则本地保险箱数据可能丢失。

## AI 分类持久化

AI 分类现在由 **Full + Anima** 作为永久写入端，同时保存到两处：

1. SillyTavern 的 `extension_settings` 独立共享命名空间 `cardvault-ai-classifications-shared-v1`；
2. 当前站点 `localStorage` 的镜像 `cardvault_ai_classifications_persistent_v1`。

只读 Import-Only 版本会读取这两处并合并，因此在 Full + Anima 分类完成后，切换到 Import-Only 会直接显示同一批分类。卸载 / 重装 CardVault 不会主动删除这份共享分类库。

> 如果同时清空 SillyTavern 的扩展设置文件和浏览器站点数据，分类仍会丢失。

## 安装

将本目录作为 SillyTavern 第三方扩展仓库根目录，至少保留：

```text
manifest.json
index.js
style.css
settings.html
```

然后通过 SillyTavern 的“扩展 → 安装扩展”使用 Git 仓库 URL 安装。

## 版本

- Full + Anima: `1.2.2`
- 基础源码：用户提供的 CardVault Standalone `1.1.2`

### 1.2.2：修复跨版本分类读取 + 强制吸边

- **只有 Full + Anima 负责永久写入**：分类同时写入 SillyTavern 共享设置命名空间和 localStorage 镜像。
- **Import-Only 实时读取同一共享库**：不再依赖一次性内存缓存，切换版本后可直接显示 Full + Anima 已完成的分类。
- 悬浮球改为 0px 贴边，保存左右 `side` 而不是旧横坐标；加入移动端窗口级 `pointerup` 兜底和二次布局复算，拖动松手后强制吸附到最近左右边缘。
