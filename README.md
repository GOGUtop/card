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

AI 分类除了原来的扩展设置，还会镜像到 SillyTavern 站点的 `localStorage`。`onClean()` 不再删除这份分类缓存，因此卸载 / 重装扩展后会自动合并回分类结果，避免重复消耗分类 API。

> 同样地，清理浏览器站点数据会删除这份缓存。

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

- Full + Anima: `1.2.1`
- 基础源码：用户提供的 CardVault Standalone `1.1.2`

### 1.2.1：共享永久分类 + 悬浮球吸边

- **只有 Full + Anima 版本负责写入永久 AI 分类**：分类结果写入 SillyTavern 站点共享 `localStorage` 键 `cardvault_ai_classifications_persistent_v1`，卸载 / 重装插件时不会删除。
- **Import-Only 版本读取同一份共享分类**：在本版本完成分类后，切换到 Import-Only 仍可看到标签并用于筛选。
- 悬浮球拖动松手后会自动吸附到最近的左 / 右屏幕边缘，刷新后保持吸边位置。
